// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Delegate} from "../../src/Delegate.sol";
import {MandateReactive} from "../../src/MandateReactive.sol";
import {IDelegate} from "../../src/interfaces/IDelegate.sol";
import {MandateFixture} from "../harness/MandateFixture.sol";
import {MockSystemContract} from "../harness/MockSystemContract.sol";
import {Vm} from "forge-std/Test.sol";

/// @notice Owner actions, timers against both governor clocks, retries, give-ups, acknowledgements and duplicate or
/// out-of-order delivery, all through the relay.
contract LifecycleTest is MandateFixture {
    function _shortWindow(uint32 secs) internal {
        MandateReactive.Config memory c = rc.config();
        c.vetoWindow = secs;
        _setConfig(c);
    }

    function _decide(uint256 caseId, uint8 support) internal {
        _post(juror1, caseId, support);
        _post(juror2, caseId, support);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Veto and override

    function test_veto_duringWindow_noVote_andLearns() public {
        (uint256 caseId, uint256 pid) = _open(govB);
        _post(juror1, caseId, FOR);
        _post(juror2, caseId, FOR);
        _post(juror3, caseId, AGAINST);
        _veto(caseId);
        _assertStatus(caseId, MandateReactive.Status.Vetoed);
        assertFalse(rc.cronActive());
        _closeWindow();
        assertFalse(govB.hasVoted(pid, address(delegateB)));
        // Juror3 disagreed with the vetoed decision, so it agreed with the owner.
        assertEq(rc.weightOf(juror1), 75);
        assertEq(rc.weightOf(juror2), 75);
        assertEq(rc.weightOf(juror3), 125);
        assertEq(rc.activeCases(), 0);
    }

    function test_veto_beforeDecision_noLearning() public {
        (uint256 caseId,) = _open(govB);
        _post(juror1, caseId, FOR);
        _veto(caseId);
        _assertStatus(caseId, MandateReactive.Status.Vetoed);
        assertEq(rc.weightOf(juror1), 100);
    }

    function test_veto_afterCast_tooLate_butLearns() public {
        (uint256 caseId, uint256 pid) = _open(govB);
        _decide(caseId, FOR);
        _closeWindow();
        _assertStatus(caseId, MandateReactive.Status.Cast);
        vm.prank(owner);
        docket.veto(caseId);
        vm.expectEmit(address(rc));
        emit MandateReactive.OwnerActionTooLate(caseId, true);
        relay.pump();
        _assertStatus(caseId, MandateReactive.Status.Cast);
        assertTrue(govB.hasVoted(pid, address(delegateB)));
        assertEq(rc.weightOf(juror1), 75);
    }

    function test_override_duringWindow_castsOwnerChoiceImmediately() public {
        (uint256 caseId, uint256 pid) = _open(govT);
        _decide(caseId, FOR);
        _advance(61); // voting open on the timestamp governor, window still running
        _override(caseId, AGAINST);
        _assertStatus(caseId, MandateReactive.Status.Cast);
        (uint256 against, uint256 forVotes,) = govT.proposalVotes(pid);
        assertEq(against, tokenT.FAUCET_AMOUNT());
        assertEq(forVotes, 0);
        assertEq(rc.weightOf(juror1), 75);
        assertTrue(rc.getCase(caseId).overridden);
    }

    function test_override_beforeVotingOpens_waitsThenCasts() public {
        (uint256 caseId, uint256 pid) = _open(govT);
        _override(caseId, ABSTAIN);
        _assertStatus(caseId, MandateReactive.Status.Waiting);
        assertEq(rc.getCase(caseId).dueAt, govT.proposalSnapshot(pid) + 1);
        _advance(61);
        _tick();
        _assertStatus(caseId, MandateReactive.Status.Cast);
        (,, uint256 abstain) = govT.proposalVotes(pid);
        assertEq(abstain, tokenT.FAUCET_AMOUNT());
    }

    function test_override_releasesInjectionHold() public {
        (uint256 caseId, uint256 pid) = _open(govT);
        _post(juror1, caseId, FOR, 9000, true);
        _assertStatus(caseId, MandateReactive.Status.Held);
        _advance(61);
        _override(caseId, AGAINST);
        _assertStatus(caseId, MandateReactive.Status.Cast);
        (uint256 against,,) = govT.proposalVotes(pid);
        assertEq(against, tokenT.FAUCET_AMOUNT());
        // Juror1 said FOR, the owner said AGAINST.
        assertEq(rc.weightOf(juror1), 75);
    }

    function test_override_afterCastWithOtherSupport_tooLate() public {
        (uint256 caseId, uint256 pid) = _open(govB);
        _decide(caseId, FOR);
        _closeWindow();
        vm.prank(owner);
        docket.overrideVote(caseId, AGAINST);
        vm.expectEmit(address(rc));
        emit MandateReactive.OwnerActionTooLate(caseId, false);
        relay.pump();
        (uint256 against, uint256 forVotes,) = govB.proposalVotes(pid);
        assertEq(against, 0);
        assertEq(forVotes, tokenB.FAUCET_AMOUNT());
        assertEq(rc.weightOf(juror1), 75);
    }

    function test_override_afterCastWithSameSupport_isQuietAndRewards() public {
        (uint256 caseId,) = _open(govB);
        _decide(caseId, FOR);
        _closeWindow();
        _override(caseId, FOR);
        _assertStatus(caseId, MandateReactive.Status.Cast);
        assertEq(rc.weightOf(juror1), 125);
        assertEq(rc.weightOf(juror2), 125);
    }

    function test_override_reasonStringNamesOverride() public {
        (uint256 caseId,) = _open(govT);
        _advance(61);
        relay.setHoldCallbacks(true);
        _override(caseId, FOR);
        MockSystemContract.Request memory req = relay.heldAt(0);
        (,,,,,, string memory reason) =
            abi.decode(_args(req.payload), (address, uint256, uint256, address, uint256, uint8, string));
        assertEq(reason, "Mandate case 1, mandate v1: owner override");
    }

    function test_quorumReasonString_carriesRationaleHash() public {
        (uint256 caseId,) = _open(govT);
        _decide(caseId, FOR);
        relay.setHoldCallbacks(true);
        _closeWindow();
        MockSystemContract.Request memory req = relay.heldAt(0);
        (,,,,, uint8 support, string memory reason) =
            abi.decode(_args(req.payload), (address, uint256, uint256, address, uint256, uint8, string));
        assertEq(support, FOR);
        bytes32 r = keccak256(abi.encode("rationale", juror1, caseId));
        assertEq(reason, string.concat("Mandate case 1, mandate v1: juror quorum, rationale ", vm.toString(r)));
    }

    function _args(bytes memory payload) internal pure returns (bytes memory out) {
        out = new bytes(payload.length - 4);
        for (uint256 i; i < out.length; ++i) {
            out[i] = payload[i + 4];
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Timers against the governor clock

    function test_timestampGovernor_windowEndsBeforeVotingOpens_defersLocally() public {
        _shortWindow(10);
        (uint256 caseId, uint256 pid) = _open(govT);
        _decide(caseId, FOR);
        _advance(11);
        uint256 before = system.totalCallbackRequests();
        _tick();
        _assertStatus(caseId, MandateReactive.Status.Waiting);
        assertEq(system.totalCallbackRequests(), before, "no wasted callback");
        assertEq(rc.getCase(caseId).dueAt, govT.proposalSnapshot(pid) + 1);
        _advance(50);
        _tick();
        _assertStatus(caseId, MandateReactive.Status.Cast);
    }

    function test_blockGovernor_withBlockTime_estimatesOpening() public {
        _shortWindow(10);
        (uint256 caseId,) = _open(govB);
        _decide(caseId, FOR);
        _advance(11);
        uint256 before = system.totalCallbackRequests();
        _tick();
        _assertStatus(caseId, MandateReactive.Status.Waiting);
        assertEq(system.totalCallbackRequests(), before, "no wasted callback");
        _advance(60);
        _tick();
        _assertStatus(caseId, MandateReactive.Status.Cast);
    }

    function test_blockGovernor_unknownBlockTime_retriesOnNotYetActive() public {
        vm.prank(owner);
        rc.watchGovernor(CHAIN_B, address(govB), MandateReactive.ClockMode.BlockNumber, 0);
        _shortWindow(10);
        (uint256 caseId, uint256 pid) = _open(govB);
        _decide(caseId, FOR);
        _advance(11);
        vm.recordLogs();
        _tick();
        _assertStatus(caseId, MandateReactive.Status.Waiting);
        MandateReactive.Case memory c = rc.getCase(caseId);
        assertEq(c.dueAt, block.timestamp + rc.config().retryAfter);
        assertEq(c.seq, 2, "open + first cast");
        assertFalse(govB.hasVoted(pid, address(delegateB)));
        // Still pending after one retry interval: another NotYetActive, another deferral.
        _advance(rc.config().retryAfter);
        vm.roll(block.number - rc.config().retryAfter); // keep the block clock behind
        _tick();
        _assertStatus(caseId, MandateReactive.Status.Waiting);
        assertEq(rc.getCase(caseId).seq, 3);
        _advance(120);
        _tick();
        _assertStatus(caseId, MandateReactive.Status.Cast);
        assertTrue(govB.hasVoted(pid, address(delegateB)));
    }

    function test_timestampGovernor_alreadyEnded_givesUpWithoutCallback() public {
        (uint256 caseId, uint256 pid) = _open(govT);
        _advance(60 + 1800 + 1);
        _decide(caseId, FOR);
        _advance(rc.config().vetoWindow + 1);
        uint256 before = system.totalCallbackRequests();
        _tick();
        _assertStatus(caseId, MandateReactive.Status.Expired);
        assertEq(system.totalCallbackRequests(), before);
        assertFalse(govT.hasVoted(pid, address(delegateT)));
        assertFalse(rc.cronActive());
    }

    function test_blockGovernor_alreadyEnded_delegateReportsEnded() public {
        (uint256 caseId, uint256 pid) = _open(govB);
        _advance(30 + 1800 + 1);
        _decide(caseId, FOR);
        vm.recordLogs();
        _advance(rc.config().vetoWindow + 1);
        _tick();
        _assertStatus(caseId, MandateReactive.Status.Expired);
        assertFalse(govB.hasVoted(pid, address(delegateB)));
    }

    function test_neverCastsAfterVoteEnd_evenIfWindowEndsLate() public {
        (uint256 caseId, uint256 pid) = _open(govT);
        _decide(caseId, FOR);
        // Window closes, but nobody ticks until voting is over.
        _advance(60 + 1800 + 10);
        _tick();
        _assertStatus(caseId, MandateReactive.Status.Expired);
        assertFalse(govT.hasVoted(pid, address(delegateT)));
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Acknowledgements, resends, idempotence

    function test_missingOpenAck_resendsOnTick() public {
        relay.setHoldCallbacks(true);
        (uint256 caseId,) = _open(govB);
        relay.dropHeld();
        _assertStatus(caseId, MandateReactive.Status.Opening);
        _advance(rc.config().resendAfter);
        relay.setHoldCallbacks(false);
        _tick();
        _assertStatus(caseId, MandateReactive.Status.Open);
        assertEq(rc.getCase(caseId).seq, 2);
        assertEq(docket.caseCount(), 1);
    }

    function test_missingOpenAck_failsAfterMaxAttempts() public {
        relay.setHoldCallbacks(true);
        (uint256 caseId,) = _open(govB);
        for (uint256 i; i < rc.config().maxAttempts; ++i) {
            relay.dropHeld();
            _advance(rc.config().resendAfter);
            _tick();
        }
        _assertStatus(caseId, MandateReactive.Status.Failed);
        assertEq(rc.getCase(caseId).seq, rc.config().maxAttempts);
        assertFalse(rc.cronActive());
    }

    function test_missingCastAck_resendsAndVotesOnce() public {
        (uint256 caseId, uint256 pid) = _open(govB);
        _decide(caseId, FOR);
        relay.setHoldCallbacks(true);
        _closeWindow();
        relay.dropHeld();
        _assertStatus(caseId, MandateReactive.Status.Casting);
        relay.setHoldCallbacks(false);
        _advance(rc.config().resendAfter);
        _tick();
        _assertStatus(caseId, MandateReactive.Status.Cast);
        assertEq(delegateB.receiptOf(caseId).cast, true);
        assertTrue(govB.hasVoted(pid, address(delegateB)));
    }

    function test_duplicateCastDelivery_votesOnce() public {
        (uint256 caseId, uint256 pid) = _open(govB);
        _decide(caseId, FOR);
        relay.setHoldCallbacks(true);
        _closeWindow();
        assertEq(relay.heldCount(), 1);
        relay.deliverHeld(0);
        relay.deliverHeld(0);
        _assertStatus(caseId, MandateReactive.Status.Cast);
        (, uint256 forVotes,) = govB.proposalVotes(pid);
        assertEq(forVotes, tokenB.FAUCET_AMOUNT());
    }

    function test_duplicateOpenDelivery_oneCase() public {
        relay.setHoldCallbacks(true);
        (uint256 caseId,) = _open(govB);
        relay.deliverHeld(0);
        relay.deliverHeld(0);
        assertEq(docket.caseCount(), 1);
        _assertStatus(caseId, MandateReactive.Status.Open);
    }

    function test_lateAckAfterResend_bothCallbacksLand_oneVote() public {
        (uint256 caseId, uint256 pid) = _open(govB);
        _decide(caseId, FOR);
        relay.setHoldCallbacks(true);
        _closeWindow();
        _advance(rc.config().resendAfter);
        _tick();
        assertEq(relay.heldCount(), 2, "original and resend both in flight");
        relay.releaseHeldReversed();
        _assertStatus(caseId, MandateReactive.Status.Cast);
        (, uint256 forVotes,) = govB.proposalVotes(pid);
        assertEq(forVotes, tokenB.FAUCET_AMOUNT());
    }

    function test_verdictArrivesBeforeCaseOpenedAck() public {
        relay.setHoldCallbacks(true);
        (uint256 caseId,) = _open(govB);
        MockSystemContract.Request memory req = relay.heldAt(0);
        relay.dropHeld();
        relay.setHoldCallbacks(false);
        // Deliver openCase on the Docket but keep its CaseOpened log away from the relay for now.
        baseProxy.deliver(req.rc, req.recipient, req.gasLimit, req.payload);
        Vm.Log[] memory openLogs = vm.getRecordedLogs();
        _postOnly(juror1, caseId, FOR, 9000, false);
        Vm.Log[] memory verdictLogs = vm.getRecordedLogs();
        relay.route(verdictLogs);
        _assertStatus(caseId, MandateReactive.Status.Open);
        assertEq(rc.getCase(caseId).mandateVersion, 0);
        relay.route(openLogs);
        assertEq(rc.getCase(caseId).mandateVersion, 1);
        _assertStatus(caseId, MandateReactive.Status.Open);
        assertTrue(rc.ballotOf(caseId, juror1).posted);
    }

    function test_duplicateVerdictLog_countedOnce() public {
        (uint256 caseId,) = _open(govB);
        _postOnly(juror1, caseId, FOR, 9000, false);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        relay.route(logs);
        relay.route(logs);
        relay.pump();
        assertEq(rc.getCase(caseId).jurors.length, 1);
        _assertStatus(caseId, MandateReactive.Status.Open);
    }

    function test_staleNotActive_fromOlderSeq_ignored() public {
        (uint256 caseId, uint256 pid) = _open(govB);
        _decide(caseId, FOR);
        relay.setHoldCallbacks(true);
        _closeWindow();
        uint256 seq = rc.getCase(caseId).seq;
        bytes memory data = abi.encode(seq - 1, uint8(IDelegate.Refusal.Ended), uint8(3));
        _trigger(_log(CHAIN_B, address(delegateB), rc.NOT_ACTIVE_TOPIC(), caseId, 0, 0, 2, data));
        _assertStatus(caseId, MandateReactive.Status.Casting);
        relay.setHoldCallbacks(false);
        relay.deliverHeld(0);
        _assertStatus(caseId, MandateReactive.Status.Cast);
        assertTrue(govB.hasVoted(pid, address(delegateB)));
    }

    function test_pausedDelegate_failsCase() public {
        vm.prank(owner);
        delegateB.setPaused(true);
        (uint256 caseId, uint256 pid) = _open(govB);
        _decide(caseId, FOR);
        _closeWindow();
        _assertStatus(caseId, MandateReactive.Status.Failed);
        assertFalse(govB.hasVoted(pid, address(delegateB)));
    }

    function test_lateCastAck_afterGiveUp_recordsTruth() public {
        (uint256 caseId,) = _open(govB);
        _decide(caseId, FOR);
        relay.setHoldCallbacks(true);
        _closeWindow();
        vm.prank(owner);
        rc.closeCase(caseId);
        _assertStatus(caseId, MandateReactive.Status.Expired);
        relay.setHoldCallbacks(false);
        relay.deliverHeld(0);
        _assertStatus(caseId, MandateReactive.Status.Cast);
        assertEq(rc.activeCases(), 0);
    }

    function test_caseTtl_expiresTimedWork() public {
        MandateReactive.Config memory c = rc.config();
        c.caseTtl = 1 hours;
        c.maxAttempts = 50;
        _setConfig(c);
        relay.setHoldCallbacks(true);
        (uint256 caseId,) = _open(govB);
        _advance(1 hours + 1);
        _tick();
        _assertStatus(caseId, MandateReactive.Status.Expired);
        assertFalse(rc.cronActive());
    }

    function test_parallelCasesOnBothChains() public {
        (uint256 cB, uint256 pB) = _open(govB);
        (uint256 cT, uint256 pT) = _open(govT);
        _decide(cB, FOR);
        _decide(cT, AGAINST);
        _closeWindow();
        _assertStatus(cB, MandateReactive.Status.Cast);
        _assertStatus(cT, MandateReactive.Status.Cast);
        (, uint256 forB,) = govB.proposalVotes(pB);
        (uint256 againstT,,) = govT.proposalVotes(pT);
        assertEq(forB, tokenB.FAUCET_AMOUNT());
        assertEq(againstT, tokenT.FAUCET_AMOUNT());
        Delegate.Receipt memory rB = delegateB.receiptOf(cB);
        Delegate.Receipt memory rT = delegateT.receiptOf(cT);
        assertEq(rB.governor, address(govB));
        assertEq(rT.governor, address(govT));
        assertEq(system.revertedReactions(), 0);
        assertEq(baseProxy.failures() + uniProxy.failures(), 0);
    }

    function test_perTickCallbackBudget_drainsOverSeveralTicks() public {
        _shortWindow(5);
        uint256[] memory ids = new uint256[](6);
        for (uint256 i; i < 6; ++i) {
            (ids[i],) = _open(govT);
            _decide(ids[i], FOR);
        }
        _advance(61);
        _tick();
        uint256 cast;
        for (uint256 i; i < 6; ++i) {
            if (_status(ids[i]) == MandateReactive.Status.Cast) ++cast;
        }
        assertEq(cast, rc.MAX_CALLBACKS_PER_TICK());
        _tick();
        for (uint256 i; i < 6; ++i) {
            _assertStatus(ids[i], MandateReactive.Status.Cast);
        }
        assertFalse(rc.cronActive());
    }
}
