// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {MandateReactive} from "../../src/MandateReactive.sol";
import {DemoGovernor} from "../../src/demo/DemoGovernor.sol";
import {IDelegate} from "../../src/interfaces/IDelegate.sol";
import {IDocket} from "../../src/interfaces/IDocket.sol";
import {MandateFixture} from "../harness/MandateFixture.sol";
import {MockSystemContract} from "../harness/MockSystemContract.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {AbstractPayer} from "@reactive/src/base/AbstractPayer.sol";
import {IReactive} from "@reactive/src/interfaces/IReactive.sol";
import {Vm} from "forge-std/Test.sol";

/// @notice Wiring, subscriptions, filtering, configuration and gas of MandateReactive.
contract MandateReactiveTest is MandateFixture {
    uint256 internal constant PC_TOPIC = 0x7d84a6263ae0d98d3329bd7b46bb4e8d6f98cd35a7adb45c274c8b7fd5ebd5e0;

    function _proposalData(uint256 pid, uint256 voteStart, uint256 voteEnd) internal pure returns (bytes memory) {
        return abi.encode(
            pid,
            address(0xA11CE),
            new address[](1),
            new uint256[](1),
            new string[](1),
            new bytes[](1),
            voteStart,
            voteEnd,
            "manual proposal"
        );
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Access and wiring

    function test_react_onlySystem() public {
        IReactive.LogRecord memory rec;
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, address(this), SYSTEM_ADDR));
        rc.react(rec);
    }

    function test_constructor_defaults() public view {
        MandateReactive.Config memory c = rc.config();
        assertEq(c.quorum, 2);
        assertEq(c.minConfidenceBps, 6000);
        assertEq(c.majorityBps, 5000);
        assertEq(uint8(c.splitPolicy), uint8(MandateReactive.SplitPolicy.Hold));
        assertGe(c.openCaseGas, 100_000);
        assertGe(c.castGas, 100_000);
        MandateReactive.WeightBounds memory b = rc.weightBounds();
        assertEq(b.initial, 100);
        assertEq(rc.weightOf(juror1), 100);
        assertEq(address(rc).balance, 1 ether, "payable constructor funds the contract");
        assertEq(rc.cronTopic(), CRON10);
        assertFalse(rc.cronActive());
    }

    function test_setDocket_subscribesFourTopics_once() public {
        assertEq(system.activeCount(address(rc), BASE, address(docket), rc.CASE_OPENED_TOPIC()), 1);
        assertEq(system.activeCount(address(rc), BASE, address(docket), rc.VERDICT_TOPIC()), 1);
        assertEq(system.activeCount(address(rc), BASE, address(docket), rc.VETOED_TOPIC()), 1);
        assertEq(system.activeCount(address(rc), BASE, address(docket), rc.OVERRIDDEN_TOPIC()), 1);
        vm.prank(owner);
        vm.expectRevert(MandateReactive.DocketAlreadySet.selector);
        rc.setDocket(BASE, address(docket));
    }

    function test_wiring_totalSubscriptions() public view {
        // 4 docket + 2 governors + 2 delegates x 2 topics; no cron while idle.
        assertEq(system.activeTotal(address(rc)), 10);
    }

    function test_ownerFunctions_onlyOwner() public {
        vm.startPrank(proposer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, proposer));
        rc.watchGovernor(BASE, address(1), MandateReactive.ClockMode.Unknown, 0);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, proposer));
        rc.setDelegate(BASE, address(1));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, proposer));
        rc.closeCase(1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, proposer));
        rc.withdraw(1, payable(proposer));
        vm.stopPrank();
    }

    function test_watchGovernor_rewatchUpdatesClockWithoutDuplicateSubscription() public {
        vm.prank(owner);
        rc.watchGovernor(CHAIN_B, address(govB), MandateReactive.ClockMode.Unknown, 0);
        assertEq(system.activeCount(address(rc), CHAIN_B, address(govB), PC_TOPIC), 1);
        assertEq(uint8(rc.watchOf(CHAIN_B, address(govB)).clock), uint8(MandateReactive.ClockMode.Unknown));
    }

    function test_unwatchGovernor_unsubscribesExactly_andStopsCases() public {
        vm.prank(owner);
        rc.unwatchGovernor(CHAIN_B, address(govB));
        assertEq(system.activeCount(address(rc), CHAIN_B, address(govB), PC_TOPIC), 0);
        assertEq(system.unsubscribeMisses(), 0);
        (uint256 caseId,) = _open(govB);
        assertEq(caseId, 0);
        // Even a forged delivery is filtered by the watch list.
        _trigger(_log(CHAIN_B, address(govB), PC_TOPIC, 0, 0, 0, 1, _proposalData(5, 2000, 3000)));
        assertEq(rc.caseCount(), 0);
    }

    function test_setDelegate_swapsSubscriptions() public {
        address next = makeAddr("nextDelegate");
        vm.prank(owner);
        rc.setDelegate(CHAIN_B, next);
        assertEq(system.activeCount(address(rc), CHAIN_B, address(delegateB), rc.CAST_TOPIC()), 0);
        assertEq(system.activeCount(address(rc), CHAIN_B, address(delegateB), rc.NOT_ACTIVE_TOPIC()), 0);
        assertEq(system.activeCount(address(rc), CHAIN_B, next, rc.CAST_TOPIC()), 1);
        assertEq(system.activeCount(address(rc), CHAIN_B, next, rc.NOT_ACTIVE_TOPIC()), 1);
        assertEq(system.unsubscribeMisses(), 0);
        assertEq(rc.delegateOf(CHAIN_B), next);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Cron lifecycle

    function test_cron_onlyWhileTimedWork() public {
        relay.setHoldCallbacks(true);
        (uint256 caseId,) = _open(govB);
        assertTrue(rc.cronActive(), "Opening waits for an acknowledgement");
        assertEq(system.activeCount(address(rc), block.chainid, rc.CRON_EMITTER(), CRON10), 1);
        relay.setHoldCallbacks(false);
        relay.deliverHeld(0);
        _assertStatus(caseId, MandateReactive.Status.Open);
        assertFalse(rc.cronActive(), "waiting for jurors is not timed work");
        assertEq(system.activeCount(address(rc), block.chainid, rc.CRON_EMITTER(), CRON10), 0);
        assertEq(system.unsubscribeMisses(), 0);
    }

    function test_cron_tickWithNothingTimed_isNoop() public {
        _tick();
        assertEq(system.reactions(), 0, "not subscribed, nothing delivered");
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Filtering

    function test_proposalCreated_wrongOpCode_ignored() public {
        _trigger(_log(CHAIN_B, address(govB), PC_TOPIC, 1, 0, 0, 2, _proposalData(5, 2000, 3000)));
        assertEq(rc.caseCount(), 0);
    }

    function test_proposalCreated_malformed_skipped() public {
        vm.expectEmit(address(rc));
        emit MandateReactive.ProposalSkipped(CHAIN_B, address(govB), 0, MandateReactive.SkipReason.Malformed);
        _trigger(_log(CHAIN_B, address(govB), PC_TOPIC, 0, 0, 0, 1, hex"01"));
        assertEq(rc.caseCount(), 0);
    }

    function test_proposalCreated_noDelegate_skipped() public {
        DemoGovernor other = new DemoGovernor("X", IVotes(address(tokenB)), 1, 10, 1);
        vm.prank(owner);
        rc.watchGovernor(10, address(other), MandateReactive.ClockMode.Unknown, 0);
        vm.expectEmit(address(rc));
        emit MandateReactive.ProposalSkipped(10, address(other), 5, MandateReactive.SkipReason.NoDelegate);
        _trigger(_log(10, address(other), PC_TOPIC, 0, 0, 0, 1, _proposalData(5, 2000, 3000)));
    }

    function test_proposalCreated_duplicateDelivery_oneCaseOneCallback() public {
        _proposeRaw(govB, "dup");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        relay.setHoldCallbacks(true);
        relay.route(logs);
        relay.route(logs);
        relay.pump();
        assertEq(rc.caseCount(), 1);
        assertEq(relay.heldCount(), 1, "one openCase request");
    }

    function test_proposalCreated_noDocket_skipped() public {
        vm.prank(owner);
        MandateReactive bare = new MandateReactive(owner, CRON10);
        vm.prank(owner);
        bare.watchGovernor(CHAIN_B, address(govB), MandateReactive.ClockMode.Unknown, 0);
        vm.prank(owner);
        bare.setDelegate(CHAIN_B, address(delegateB));
        vm.expectEmit(address(bare));
        emit MandateReactive.ProposalSkipped(CHAIN_B, address(govB), 5, MandateReactive.SkipReason.NoDocket);
        system.trigger(address(bare), _log(CHAIN_B, address(govB), PC_TOPIC, 0, 0, 0, 1, _proposalData(5, 2000, 3000)));
    }

    function test_spoofedDocketEvent_fromOtherEmitterOrChain_ignored() public {
        (uint256 caseId,) = _open(govB);
        bytes memory data = abi.encode(uint8(1), uint16(9000), false, bytes32("r"), bytes32(0), bytes32(0));
        uint256 j = uint256(uint160(juror1));
        _trigger(_log(BASE, address(0xBAD), rc.VERDICT_TOPIC(), caseId, j, 0, 3, data));
        _trigger(_log(UNI, address(docket), rc.VERDICT_TOPIC(), caseId, j, 0, 3, data));
        assertFalse(rc.ballotOf(caseId, juror1).posted);
    }

    function test_spoofedCastAck_fromWrongDelegate_ignored() public {
        (uint256 caseId, uint256 pid) = _open(govB);
        bytes memory data = abi.encode(uint256(1), uint8(1), uint256(5));
        _trigger(_log(CHAIN_B, address(delegateT), rc.CAST_TOPIC(), caseId, uint160(address(govB)), pid, 4, data));
        _trigger(_log(CHAIN_T, address(delegateB), rc.CAST_TOPIC(), caseId, uint160(address(govB)), pid, 4, data));
        _assertStatus(caseId, MandateReactive.Status.Open);
    }

    function test_verdictForUnknownCase_ignored() public {
        bytes memory data = abi.encode(uint8(1), uint16(9000), false, bytes32("r"), bytes32(0), bytes32(0));
        _trigger(_log(BASE, address(docket), rc.VERDICT_TOPIC(), 99, uint160(juror1), 0, 3, data));
        assertFalse(rc.ballotOf(99, juror1).posted);
    }

    function test_verdictOutOfRangeFields_ignored() public {
        (uint256 caseId,) = _open(govB);
        bytes memory bad = abi.encode(uint256(3), uint256(9000), false, bytes32("r"), bytes32(0), bytes32(0));
        _trigger(_log(BASE, address(docket), rc.VERDICT_TOPIC(), caseId, uint160(juror1), 0, 3, bad));
        bad = abi.encode(uint256(1), uint256(10_001), false, bytes32("r"), bytes32(0), bytes32(0));
        _trigger(_log(BASE, address(docket), rc.VERDICT_TOPIC(), caseId, uint160(juror1), 0, 3, bad));
        assertFalse(rc.ballotOf(caseId, juror1).posted);
    }

    function testFuzz_react_neverReverts(
        uint256 chainSel,
        uint256 emitterSel,
        uint256 topicSel,
        uint256 topic1,
        uint256 topic2,
        uint8 opCode,
        bytes calldata data
    ) public {
        _open(govB);
        uint256[3] memory chains = [BASE, UNI, block.chainid];
        address[5] memory emitters =
            [address(docket), address(govB), address(delegateB), rc.CRON_EMITTER(), address(0xBAD)];
        uint256[8] memory topics = [
            PC_TOPIC,
            rc.CASE_OPENED_TOPIC(),
            rc.VERDICT_TOPIC(),
            rc.VETOED_TOPIC(),
            rc.OVERRIDDEN_TOPIC(),
            rc.CAST_TOPIC(),
            rc.NOT_ACTIVE_TOPIC(),
            CRON10
        ];
        IReactive.LogRecord memory rec = _log(
            chains[chainSel % 3],
            emitters[emitterSel % 5],
            topics[topicSel % 8],
            bound(topic1, 0, 3),
            topic2,
            0,
            opCode % 5,
            data
        );
        system.trigger(address(rc), rec);
        assertEq(system.revertedReactions(), 0);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Configuration

    function test_setConfig_validates() public {
        MandateReactive.Config memory bad;

        bad = rc.config();
        bad.quorum = 0;
        _expectInvalidConfig(bad);
        bad = rc.config();
        bad.quorum = 17;
        _expectInvalidConfig(bad);
        bad = rc.config();
        bad.majorityBps = 4999;
        _expectInvalidConfig(bad);
        bad = rc.config();
        bad.majorityBps = 10_000;
        _expectInvalidConfig(bad);
        bad = rc.config();
        bad.minConfidenceBps = 10_001;
        _expectInvalidConfig(bad);
        bad = rc.config();
        bad.castGas = 99_999;
        _expectInvalidConfig(bad);
        bad = rc.config();
        bad.openCaseGas = 3_000_001;
        _expectInvalidConfig(bad);
        bad = rc.config();
        bad.caseTtl = bad.vetoWindow - 1;
        _expectInvalidConfig(bad);
        bad = rc.config();
        bad.maxAttempts = 0;
        _expectInvalidConfig(bad);

        MandateReactive.Config memory c = rc.config();
        c.quorum = 3;
        c.splitPolicy = MandateReactive.SplitPolicy.Abstain;
        _setConfig(c);
        assertEq(rc.config().quorum, 3);
    }

    function _expectInvalidConfig(MandateReactive.Config memory c) internal {
        vm.prank(owner);
        vm.expectRevert(MandateReactive.InvalidConfig.selector);
        rc.setConfig(c);
    }

    function test_setWeightBounds_validates() public {
        vm.startPrank(owner);
        vm.expectRevert(MandateReactive.InvalidWeightBounds.selector);
        rc.setWeightBounds(MandateReactive.WeightBounds({min: 0, initial: 1, max: 2, step: 1}));
        vm.expectRevert(MandateReactive.InvalidWeightBounds.selector);
        rc.setWeightBounds(MandateReactive.WeightBounds({min: 10, initial: 5, max: 20, step: 1}));
        vm.expectRevert(MandateReactive.InvalidWeightBounds.selector);
        rc.setWeightBounds(MandateReactive.WeightBounds({min: 10, initial: 30, max: 20, step: 1}));
        vm.expectRevert(MandateReactive.InvalidWeightBounds.selector);
        rc.setWeightBounds(MandateReactive.WeightBounds({min: 1, initial: 1, max: 2, step: 0}));
        rc.setWeightBounds(MandateReactive.WeightBounds({min: 50, initial: 60, max: 70, step: 5}));
        vm.stopPrank();
        assertEq(rc.weightOf(juror1), 60);
    }

    function test_closeCase_ownerCleanup() public {
        (uint256 caseId,) = _open(govB);
        vm.prank(owner);
        rc.closeCase(caseId);
        _assertStatus(caseId, MandateReactive.Status.Expired);
        assertEq(rc.activeCases(), 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MandateReactive.CaseFinished.selector, caseId));
        rc.closeCase(caseId);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MandateReactive.UnknownCase.selector, 77));
        rc.closeCase(77);
    }

    function test_coverDebt_and_withdraw() public {
        rc.coverDebt();
        address payable to = payable(makeAddr("to"));
        vm.prank(owner);
        rc.withdraw(0.25 ether, to);
        assertEq(to.balance, 0.25 ether);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Callback shape and gas

    function test_callbackPayload_reservesAddressZeroFirstArg_andGasAboveMinimum() public {
        relay.setHoldCallbacks(true);
        _open(govB);
        MockSystemContract.Request memory req = relay.heldAt(0);
        assertEq(req.recipient, address(docket));
        assertEq(req.chainId, BASE);
        assertGe(req.gasLimit, 100_000);
        bytes memory p = req.payload;
        bytes4 sel;
        uint256 firstArg;
        assembly {
            sel := mload(add(p, 32))
            firstArg := mload(add(p, 36))
        }
        assertEq(sel, IDocket.openCase.selector);
        assertEq(firstArg, 0, "address(0) placeholder");
        assertEq(system.ignoredCallbacks(), 0);
    }

    function test_castPayload_reservesAddressZeroFirstArg() public {
        (uint256 caseId,) = _open(govB);
        _post(juror1, caseId, FOR);
        _post(juror2, caseId, FOR);
        relay.setHoldCallbacks(true);
        _closeWindow();
        MockSystemContract.Request memory req = relay.heldAt(0);
        assertEq(req.recipient, address(delegateB));
        bytes memory p = req.payload;
        bytes4 sel;
        uint256 firstArg;
        assembly {
            sel := mload(add(p, 32))
            firstArg := mload(add(p, 36))
        }
        assertEq(sel, IDelegate.cast.selector);
        assertEq(firstArg, 0);
    }

    function test_gas_reactStaysUnderCap_withManyTimedCases() public {
        MandateReactive.Config memory c = rc.config();
        c.vetoWindow = 30;
        _setConfig(c);
        for (uint256 i; i < 40; ++i) {
            (uint256 caseId,) = _open(govT);
            _post(juror1, caseId, FOR);
            _post(juror2, caseId, FOR);
        }
        assertEq(rc.timedCases().length, 40);
        _advance(31 + 60);
        uint256 before = system.totalCallbackRequests();
        relay.setHoldCallbacks(true);
        _tick();
        assertEq(system.totalCallbackRequests() - before, rc.MAX_CALLBACKS_PER_TICK(), "bounded per tick");
        emit log_named_uint("max react gas (tick: 24 scanned, 4 callbacks)", system.maxReactGas());
        assertLt(system.maxReactGas(), 900_000);
        assertEq(system.revertedReactions(), 0);
    }

    function test_gas_proposalCreatedFlat_inDescriptionLength() public {
        _proposeRaw(govT, "short");
        relay.pump();
        uint256 gSmall = system.lastReactGas();
        _proposeRaw(govT, string(abi.encodePacked(new bytes(30_000), "long")));
        relay.pump();
        // The last reaction is the CaseOpened ack; find the ProposalCreated one by replaying a fresh proposal alone.
        relay.setHoldCallbacks(true);
        _proposeRaw(govT, string(abi.encodePacked(new bytes(30_000), "longer")));
        relay.pump();
        uint256 gLarge = system.lastReactGas();
        assertLt(gLarge, gSmall + 30_000 * 16, "only calldata copy grows");
        assertLt(gLarge, 900_000);
    }
}
