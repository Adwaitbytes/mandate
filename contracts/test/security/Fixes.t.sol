// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {MandateReactive} from "../../src/MandateReactive.sol";
import {DemoVotesToken} from "../../src/demo/DemoVotesToken.sol";
import {IDelegate} from "../../src/interfaces/IDelegate.sol";
import {MandateFixture} from "../harness/MandateFixture.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Regression tests for each security review fix (docs/SECURITY_REVIEW.md), beyond the reviewer's PoCs.
contract SecurityFixesTest is MandateFixture {
    function _unknownBlockClockAndShortWindow() internal {
        vm.startPrank(owner);
        rc.watchGovernor(CHAIN_B, address(govB), MandateReactive.ClockMode.BlockNumber, 0);
        MandateReactive.Config memory c = rc.config();
        c.vetoWindow = 10;
        rc.setConfig(c);
        vm.stopPrank();
    }

    /// Decided FOR, window over, first cast held in flight while the proposal is still Pending.
    function _caseWithCastInFlight() internal returns (uint256 caseId, uint256 pid) {
        _unknownBlockClockAndShortWindow();
        (caseId, pid) = _open(govB);
        _post(juror1, caseId, FOR);
        _post(juror2, caseId, FOR);
        relay.setHoldCallbacks(true);
        _advance(11);
        _tick();
        _assertStatus(caseId, MandateReactive.Status.Casting);
    }

    function _releaseAllInOrder() internal {
        relay.setHoldCallbacks(false);
        uint256 n = relay.heldCount();
        for (uint256 i; i < n; ++i) {
            relay.deliverHeld(i);
        }
        relay.dropHeld();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // H-1

    function test_H1_overrideDuringCasting_castsOwnerSupportNotTheOldOne() public {
        (uint256 caseId, uint256 pid) = _caseWithCastInFlight();
        _override(caseId, AGAINST);
        assertTrue(rc.getCase(caseId).cancelPending);
        _releaseAllInOrder(); // old FOR cast (Pending), cancel, new AGAINST cast (Pending)
        _advance(120);
        _tick();
        _assertStatus(caseId, MandateReactive.Status.Cast);
        (uint256 against, uint256 forVotes,) = govB.proposalVotes(pid);
        assertEq(against, tokenB.FAUCET_AMOUNT());
        assertEq(forVotes, 0);
    }

    function test_H1_injectionDuringCasting_holdsAndCancels() public {
        (uint256 caseId, uint256 pid) = _caseWithCastInFlight();
        _post(juror3, caseId, FOR, 9000, true);
        _assertStatus(caseId, MandateReactive.Status.Held);
        assertTrue(rc.getCase(caseId).cancelPending);
        _releaseAllInOrder();
        _advance(120);
        _tick();
        assertFalse(govB.hasVoted(pid, address(delegateB)));
        _assertStatus(caseId, MandateReactive.Status.Held);
    }

    function test_H1_vetoDuringCasting_cancelAcknowledged_cronOff() public {
        (uint256 caseId,) = _caseWithCastInFlight();
        _veto(caseId);
        _assertStatus(caseId, MandateReactive.Status.Vetoed);
        assertTrue(rc.cronActive(), "unacknowledged cancel is timed work");
        _releaseAllInOrder();
        assertFalse(rc.getCase(caseId).cancelPending);
        assertEq(delegateB.minSeq(caseId), rc.getCase(caseId).cancelSeq);
        assertEq(rc.timedCases().length, 0);
        assertFalse(rc.cronActive());
    }

    function test_H1_lostCancel_isResent_thenAbandoned() public {
        (uint256 caseId,) = _caseWithCastInFlight();
        _veto(caseId);
        relay.dropHeld();
        uint32 cancelSeq = rc.getCase(caseId).cancelSeq;
        for (uint256 i; i < rc.caseConfig(caseId).maxAttempts; ++i) {
            _advance(rc.caseConfig(caseId).resendAfter);
            _tick();
            relay.dropHeld();
        }
        assertFalse(rc.getCase(caseId).cancelPending);
        assertEq(rc.getCase(caseId).cancelSeq, cancelSeq, "resends reuse the cancel's sequence number");
        assertFalse(rc.cronActive());
    }

    function test_H1_lateCastAckAfterVeto_recordsTruth() public {
        (uint256 caseId, uint256 pid) = _caseWithCastInFlight();
        // Voting opens before the veto lands, so the in-flight cast executes.
        vm.roll(block.number + 120);
        _veto(caseId);
        relay.setHoldCallbacks(false);
        relay.deliverHeld(0); // the cast that was already in flight
        _assertStatus(caseId, MandateReactive.Status.Cast);
        assertTrue(govB.hasVoted(pid, address(delegateB)));
    }

    // ---------------------------------------------------------------------------------------------------------------
    // M-2

    function test_M2_expireStale_isPermissionless() public {
        (uint256 caseId,) = _open(govB);
        uint256[] memory ids = new uint256[](1);
        ids[0] = caseId;
        rc.expireStale(ids); // not stale yet: no-op
        _assertStatus(caseId, MandateReactive.Status.Open);
        _advance(uint256(rc.caseConfig(caseId).caseTtl) + 1);
        vm.prank(makeAddr("anyone"));
        rc.expireStale(ids);
        _assertStatus(caseId, MandateReactive.Status.Expired);
        assertEq(rc.activeCases(), 0);
    }

    function test_M2_timestampCaseWaitingForJurors_expiresAfterVoteEnd() public {
        (uint256 caseId,) = _open(govT);
        _advance(TS_DELAY + TS_PERIOD + 1);
        _open(govT); // the next reaction sweeps the oldest stale case
        _assertStatus(caseId, MandateReactive.Status.Expired);
    }

    function test_M2_perGovernorCap() public {
        vm.prank(owner);
        rc.setGovernorLimits(CHAIN_T, address(govT), 2, 0);
        (uint256 a,) = _open(govT);
        (uint256 b,) = _open(govT);
        uint256 pid = _proposeRaw(govT, "third");
        vm.expectEmit(address(rc));
        emit MandateReactive.ProposalSkipped(CHAIN_T, address(govT), pid, MandateReactive.SkipReason.GovernorCapacity);
        relay.pump();
        assertTrue(a != 0 && b != 0);
        // Other governors are unaffected.
        (uint256 onB,) = _open(govB);
        assertTrue(onB != 0);
        // Finishing a case frees a slot.
        vm.prank(owner);
        rc.closeCase(a);
        assertEq(rc.watchOf(CHAIN_T, address(govT)).activeCount, 1);
        (uint256 d,) = _open(govT);
        assertTrue(d != 0);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // M-3

    function test_M3_twoFlagPolicy_singleFlagDoesNotFreeze() public {
        MandateReactive.Config memory c = rc.config();
        c.injectionFlagsToHold = 2;
        _setConfig(c);
        (uint256 caseId,) = _open(govT);
        _post(juror1, caseId, FOR, 9000, true);
        _assertStatus(caseId, MandateReactive.Status.Open);
        _post(juror2, caseId, FOR);
        _assertStatus(caseId, MandateReactive.Status.Window);
        _post(juror3, caseId, FOR, 9000, true);
        _assertStatus(caseId, MandateReactive.Status.Held);
        assertEq(rc.getCase(caseId).injectionFlags, 2);
    }

    function test_M3_defaultPolicy_singleFlagHolds() public view {
        assertEq(rc.config().injectionFlagsToHold, 1);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // M-5

    function test_M5_configFloors() public {
        vm.prank(owner);
        MandateReactive live = new MandateReactive(owner, CRON10, 300);
        assertEq(live.config().vetoWindow, 600);
        MandateReactive.Config memory c;

        c = live.config();
        c.quorum = 1;
        c.minAgreeing = 1;
        c.injectionFlagsToHold = 1;
        _expectInvalid(live, c);
        c = live.config();
        c.minAgreeing = 1;
        _expectInvalid(live, c);
        c = live.config();
        c.minAgreeing = 3; // above quorum 2
        _expectInvalid(live, c);
        c = live.config();
        c.minConfidenceBps = 4999;
        _expectInvalid(live, c);
        c = live.config();
        c.vetoWindow = 299;
        _expectInvalid(live, c);
        c = live.config();
        c.injectionFlagsToHold = 0;
        _expectInvalid(live, c);
        c = live.config();
        c.injectionFlagsToHold = 3;
        _expectInvalid(live, c);

        c = live.config();
        c.vetoWindow = 300;
        vm.prank(owner);
        live.setConfig(c);
    }

    function _expectInvalid(MandateReactive target, MandateReactive.Config memory c) internal {
        vm.prank(owner);
        vm.expectRevert(MandateReactive.InvalidConfig.selector);
        target.setConfig(c);
    }

    function test_M5_configIsSnapshottedPerCase() public {
        (uint256 caseId, uint256 pid) = _open(govT);
        MandateReactive.Config memory c = rc.config();
        c.quorum = 3;
        c.minAgreeing = 3;
        c.vetoWindow = 1 days;
        _setConfig(c);
        _post(juror1, caseId, FOR);
        _post(juror2, caseId, FOR);
        _assertStatus(caseId, MandateReactive.Status.Window); // still quorum 2
        _advance(rc.caseConfig(caseId).vetoWindow + 1); // the case's own 10 min window, not the new 1 day
        _tick();
        assertTrue(govT.hasVoted(pid, address(delegateT)));
        (uint256 next,) = _open(govT);
        assertEq(rc.caseConfig(next).quorum, 3);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // M-6

    function test_M6_perGovernorRateLimit_resetsHourly() public {
        vm.prank(owner);
        rc.setGovernorLimits(CHAIN_T, address(govT), 0, 2);
        _open(govT);
        _open(govT);
        uint256 pid = _proposeRaw(govT, "over the limit");
        vm.expectEmit(address(rc));
        emit MandateReactive.ProposalSkipped(CHAIN_T, address(govT), pid, MandateReactive.SkipReason.RateLimited);
        relay.pump();
        _advance(1 hours);
        (uint256 later,) = _open(govT);
        assertTrue(later != 0);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Low

    function test_L2_stateUnavailable_retriesInsteadOfFailing() public {
        (uint256 caseId,) = _caseWithCastInFlight();
        relay.dropHeld();
        uint32 seq = rc.getCase(caseId).seq;
        bytes memory data = abi.encode(uint256(seq), uint8(IDelegate.Refusal.StateUnavailable), uint8(255));
        relay.setHoldCallbacks(false);
        _trigger(_log(CHAIN_B, address(delegateB), rc.NOT_ACTIVE_TOPIC(), caseId, 0, 0, 2, data));
        _assertStatus(caseId, MandateReactive.Status.Waiting);
    }

    function test_L2_superseded_isIgnored() public {
        (uint256 caseId,) = _caseWithCastInFlight();
        uint32 seq = rc.getCase(caseId).seq;
        bytes memory data = abi.encode(uint256(seq), uint8(IDelegate.Refusal.Superseded), uint8(255));
        _trigger(_log(CHAIN_B, address(delegateB), rc.NOT_ACTIVE_TOPIC(), caseId, 0, 0, 2, data));
        _assertStatus(caseId, MandateReactive.Status.Casting);
    }

    function test_L3_hugeWeightStep_doesNotRevertOwnerActions() public {
        vm.prank(owner);
        rc.setWeightBounds(MandateReactive.WeightBounds({min: 1, initial: 1, max: 1_000_000, step: 1_000_000}));
        (uint256 caseId,) = _open(govB);
        _post(juror1, caseId, FOR);
        _post(juror2, caseId, AGAINST);
        _override(caseId, FOR);
        assertEq(system.revertedReactions(), 0);
        assertEq(rc.weightOf(juror1), 1_000_000);
        assertEq(rc.weightOf(juror2), 1);
        vm.prank(owner);
        vm.expectRevert(MandateReactive.InvalidWeightBounds.selector);
        rc.setWeightBounds(MandateReactive.WeightBounds({min: 1, initial: 1, max: 10, step: 1_000_001}));
    }

    function test_L7_setDelegate_refusedWhileChainHasTimedWork() public {
        (uint256 caseId,) = _caseWithCastInFlight();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MandateReactive.DelegateInUse.selector, CHAIN_B, caseId));
        rc.setDelegate(CHAIN_B, makeAddr("next"));
        // Another chain is free to change.
        vm.prank(owner);
        rc.setDelegate(CHAIN_T, makeAddr("nextT"));
    }

    function test_L8_withdrawKeepsFloor_andRenounceDisabled() public {
        uint256 bal = address(rc).balance;
        uint256 floor = rc.WITHDRAW_FLOOR();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MandateReactive.ReserveFloor.selector, floor - 1, floor));
        rc.withdraw(bal - floor + 1, payable(owner));
        vm.prank(owner);
        rc.withdraw(bal - floor, payable(owner));
        assertEq(address(rc).balance, floor);
        vm.prank(owner);
        vm.expectRevert(MandateReactive.RenounceDisabled.selector);
        rc.renounceOwnership();
        vm.prank(proposer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, proposer));
        rc.renounceOwnership();
    }

    function test_L6_faucetLifetimeCap() public {
        DemoVotesToken t = new DemoVotesToken("T", "T", true);
        deal(address(t), address(this), t.MAX_FAUCET_SUPPLY() - t.FAUCET_AMOUNT() + 1, true);
        vm.prank(proposer);
        vm.expectRevert(DemoVotesToken.FaucetExhausted.selector);
        t.faucet();
    }
}
