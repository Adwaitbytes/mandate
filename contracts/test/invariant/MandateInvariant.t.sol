// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Delegate} from "../../src/Delegate.sol";
import {Docket} from "../../src/Docket.sol";
import {MandateReactive} from "../../src/MandateReactive.sol";
import {DemoGovernor} from "../../src/demo/DemoGovernor.sol";
import {MandateFixture} from "../harness/MandateFixture.sol";
import {MockSystemContract} from "../harness/MockSystemContract.sol";
import {Relay} from "../harness/Relay.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Drives the whole system with random proposals, verdicts, owner actions, time and lost callbacks.
contract MandateHandler is Test {
    MandateReactive internal rc;
    Docket internal docket;
    Relay internal relay;
    DemoGovernor internal govB;
    DemoGovernor internal govT;
    address internal owner;
    address[3] internal jurors;

    uint256 internal nonce;
    mapping(uint256 caseId => bool) public injectionHeld;
    mapping(uint256 caseId => bool) public overridden;
    uint256 public calls;

    constructor(
        MandateReactive rc_,
        Docket docket_,
        Relay relay_,
        DemoGovernor govB_,
        DemoGovernor govT_,
        address owner_,
        address[3] memory jurors_
    ) {
        rc = rc_;
        docket = docket_;
        relay = relay_;
        govB = govB_;
        govT = govT_;
        owner = owner_;
        jurors = jurors_;
    }

    function propose(bool timestampGov) external {
        ++calls;
        DemoGovernor gov = timestampGov ? govT : govB;
        address[] memory targets = new address[](1);
        targets[0] = address(gov);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeCall(gov.votingDelay, ());
        gov.propose(targets, new uint256[](1), calldatas, string.concat("inv ", vm.toString(++nonce)));
        relay.pump();
    }

    function post(uint256 caseSeed, uint256 jurorSeed, uint8 support, uint16 confidence) external {
        ++calls;
        uint256 n = rc.caseCount();
        if (n == 0) return;
        uint256 caseId = bound(caseSeed, 1, n);
        bool injection = confidence % 17 == 0;
        vm.prank(jurors[jurorSeed % 3]);
        try docket.postVerdict(
            caseId,
            support % 3,
            uint16(bound(confidence, 0, 10_000)),
            keccak256(abi.encode(caseId, jurorSeed)),
            keccak256("model"),
            keccak256("prompt"),
            injection
        ) {}
        catch {
            return;
        }
        relay.pump();
        MandateReactive.Case memory c = rc.getCase(caseId);
        if (c.status == MandateReactive.Status.Held && c.hold == MandateReactive.HoldReason.Injection) {
            injectionHeld[caseId] = true;
        }
    }

    function ownerAction(uint256 caseSeed, bool veto, uint8 support) external {
        ++calls;
        uint256 n = rc.caseCount();
        if (n == 0) return;
        uint256 caseId = bound(caseSeed, 1, n);
        vm.prank(owner);
        if (veto) {
            try docket.veto(caseId) {}
            catch {
                return;
            }
        } else {
            try docket.overrideVote(caseId, support % 3) {
                overridden[caseId] = true;
            } catch {
                return;
            }
        }
        relay.pump();
    }

    function advanceAndTick(uint256 secs) external {
        ++calls;
        secs = bound(secs, 1, 900);
        vm.warp(block.timestamp + secs);
        vm.roll(block.number + secs);
        relay.tick();
    }

    /// @dev Loses every callback requested during one tick.
    function lossyTick(uint256 secs) external {
        ++calls;
        secs = bound(secs, 1, 300);
        vm.warp(block.timestamp + secs);
        vm.roll(block.number + secs);
        relay.setHoldCallbacks(true);
        relay.tick();
        relay.dropHeld();
        relay.setHoldCallbacks(false);
    }
}

contract MandateInvariantTest is MandateFixture {
    MandateHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new MandateHandler(rc, docket, relay, govB, govT, owner, [juror1, juror2, juror3]);
        targetContract(address(handler));
    }

    function _isTerminal(MandateReactive.Status s) internal pure returns (bool) {
        return s == MandateReactive.Status.Cast || s == MandateReactive.Status.Vetoed
            || s == MandateReactive.Status.Expired || s == MandateReactive.Status.Failed;
    }

    function _isTimedStatus(MandateReactive.Status s) internal pure returns (bool) {
        return s == MandateReactive.Status.Opening || s == MandateReactive.Status.Window
            || s == MandateReactive.Status.Waiting || s == MandateReactive.Status.Casting;
    }

    function invariant_cronOnExactlyWhileTimedWork() public view {
        bool timed = rc.timedCases().length != 0;
        assertEq(rc.cronActive(), timed);
        assertEq(system.activeCount(address(rc), block.chainid, rc.CRON_EMITTER(), CRON10), timed ? 1 : 0);
    }

    function invariant_timedSetMatchesStatuses() public view {
        uint256[] memory timed = rc.timedCases();
        for (uint256 i; i < timed.length; ++i) {
            MandateReactive.Case memory c = rc.getCase(timed[i]);
            assertTrue(_isTimedStatus(c.status) || c.cancelPending, "timed case with nothing to time");
        }
        uint256 timedCount;
        uint256 active;
        for (uint256 id = 1; id <= rc.caseCount(); ++id) {
            MandateReactive.Case memory c = rc.getCase(id);
            if (_isTimedStatus(c.status) || c.cancelPending) ++timedCount;
            if (!_isTerminal(c.status)) ++active;
        }
        assertEq(timedCount, timed.length, "every timed-status case is in the timed set");
        assertEq(active, rc.activeCases());
    }

    function invariant_weightsWithinBounds() public view {
        MandateReactive.WeightBounds memory b = rc.weightBounds();
        address[3] memory js = [juror1, juror2, juror3];
        for (uint256 i; i < 3; ++i) {
            uint32 w = rc.weightOf(js[i]);
            assertGe(w, b.min);
            assertLe(w, b.max);
        }
    }

    function invariant_reactNeverRevertsAndUnsubscribesMatch() public view {
        assertEq(system.revertedReactions(), 0);
        assertEq(system.unsubscribeMisses(), 0);
        assertEq(system.ignoredCallbacks(), 0);
    }

    function invariant_castMatchesDelegateReceipts() public view {
        for (uint256 id = 1; id <= rc.caseCount(); ++id) {
            MandateReactive.Case memory c = rc.getCase(id);
            Delegate d = Delegate(payable(c.delegate));
            bool voted = d.receiptOf(id).cast;
            if (c.status == MandateReactive.Status.Cast) assertTrue(voted, "Cast without a receipt");
            if (c.status == MandateReactive.Status.Vetoed) assertFalse(voted, "vetoed case voted");
            if (voted) assertEq(d.receiptOf(id).proposalId, c.proposalId);
        }
    }

    function invariant_injectionHoldNeverAutoVotes() public view {
        for (uint256 id = 1; id <= rc.caseCount(); ++id) {
            if (handler.injectionHeld(id) && !handler.overridden(id)) {
                MandateReactive.Case memory c = rc.getCase(id);
                assertFalse(Delegate(payable(c.delegate)).receiptOf(id).cast, "held case voted");
            }
        }
    }

    function invariant_oneCasePerProposal() public view {
        for (uint256 id = 1; id <= rc.caseCount(); ++id) {
            MandateReactive.Case memory c = rc.getCase(id);
            assertEq(rc.caseIdOf(c.originChainId, c.governor, c.proposalId), id);
        }
    }

    /// @dev Reports how far the random runs got, so a green run that never reached Cast would be visible.
    function afterInvariant() external {
        uint256[11] memory byStatus;
        for (uint256 id = 1; id <= rc.caseCount(); ++id) {
            ++byStatus[uint8(rc.getCase(id).status)];
        }
        emit log_named_uint("cases", rc.caseCount());
        emit log_named_uint("cast", byStatus[uint8(MandateReactive.Status.Cast)]);
        emit log_named_uint("vetoed", byStatus[uint8(MandateReactive.Status.Vetoed)]);
        emit log_named_uint("expired", byStatus[uint8(MandateReactive.Status.Expired)]);
        emit log_named_uint("failed", byStatus[uint8(MandateReactive.Status.Failed)]);
        emit log_named_uint("held", byStatus[uint8(MandateReactive.Status.Held)]);
        emit log_named_uint("open", byStatus[uint8(MandateReactive.Status.Open)]);
    }
}
