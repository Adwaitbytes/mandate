// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {MandateReactive} from "../../src/MandateReactive.sol";
import {MandateFixture} from "../harness/MandateFixture.sol";

/// @notice Weighted tally: quorum, minimum confidence, majority, split policy, injection hold, decision changes.
contract TallyTest is MandateFixture {
    function _policy(MandateReactive.SplitPolicy p) internal {
        MandateReactive.Config memory c = rc.config();
        c.splitPolicy = p;
        _setConfig(c);
    }

    function test_belowQuorum_staysOpen() public {
        (uint256 caseId,) = _open(govB);
        _post(juror1, caseId, FOR);
        _assertStatus(caseId, MandateReactive.Status.Open);
        assertFalse(rc.getCase(caseId).hasDecision);
        assertFalse(rc.cronActive());
    }

    function test_quorumDecisive_startsWindowWithSupport() public {
        (uint256 caseId,) = _open(govB);
        _post(juror1, caseId, AGAINST);
        _postOnly(juror2, caseId, AGAINST, 9000, false);
        vm.expectEmit(address(rc));
        emit MandateReactive.TallyUpdated(caseId, 200, 0, 0, 0, 2);
        vm.expectEmit(address(rc));
        emit MandateReactive.WindowStarted(caseId, AGAINST, uint64(block.timestamp + rc.config().vetoWindow));
        relay.pump();
        MandateReactive.Case memory c = rc.getCase(caseId);
        assertEq(uint8(c.status), uint8(MandateReactive.Status.Window));
        assertEq(c.support, AGAINST);
        assertTrue(c.hasDecision);
        assertEq(c.dueAt, block.timestamp + rc.config().vetoWindow);
    }

    function test_quorumThree_needsThree() public {
        MandateReactive.Config memory c = rc.config();
        c.quorum = 3;
        _setConfig(c);
        (uint256 caseId,) = _open(govB);
        _post(juror1, caseId, FOR);
        _post(juror2, caseId, FOR);
        _assertStatus(caseId, MandateReactive.Status.Open);
        _post(juror3, caseId, FOR);
        _assertStatus(caseId, MandateReactive.Status.Window);
    }

    function test_lowConfidence_countsTowardQuorumNotTowardSide() public {
        (uint256 caseId,) = _open(govB);
        _post(juror1, caseId, FOR, 9000, false);
        _postOnly(juror2, caseId, FOR, 5999, false);
        vm.expectEmit(address(rc));
        emit MandateReactive.TallyUpdated(caseId, 0, 100, 0, 100, 2);
        relay.pump();
        // 100 of 200 is not strictly above 50%: split, and the default policy holds.
        _assertStatus(caseId, MandateReactive.Status.Held);
        assertEq(uint8(rc.getCase(caseId).hold), uint8(MandateReactive.HoldReason.Split));
    }

    function test_minConfidenceBoundary_isInclusive() public {
        (uint256 caseId,) = _open(govB);
        _post(juror1, caseId, FOR, 6000, false);
        _post(juror2, caseId, FOR, 6000, false);
        _assertStatus(caseId, MandateReactive.Status.Window);
    }

    function test_split_holdPolicy_holdsWithoutCron() public {
        (uint256 caseId,) = _open(govB);
        _post(juror1, caseId, FOR);
        _postOnly(juror2, caseId, AGAINST, 9000, false);
        vm.expectEmit(address(rc));
        emit MandateReactive.CaseHeld(caseId, MandateReactive.HoldReason.Split);
        relay.pump();
        _assertStatus(caseId, MandateReactive.Status.Held);
        assertFalse(rc.cronActive());
        _closeWindow();
        _assertStatus(caseId, MandateReactive.Status.Held);
    }

    function test_split_holdPolicy_reEvaluatedWhenThirdVerdictDecides() public {
        (uint256 caseId, uint256 pid) = _open(govB);
        _post(juror1, caseId, FOR);
        _post(juror2, caseId, AGAINST);
        _assertStatus(caseId, MandateReactive.Status.Held);
        _post(juror3, caseId, AGAINST);
        _assertStatus(caseId, MandateReactive.Status.Window);
        assertEq(uint8(rc.getCase(caseId).hold), uint8(MandateReactive.HoldReason.None));
        _closeWindow();
        _assertStatus(caseId, MandateReactive.Status.Cast);
        (uint256 against,,) = govB.proposalVotes(pid);
        assertEq(against, tokenB.FAUCET_AMOUNT());
    }

    function test_split_abstainPolicy_castsAbstain() public {
        _policy(MandateReactive.SplitPolicy.Abstain);
        (uint256 caseId, uint256 pid) = _open(govT);
        _post(juror1, caseId, FOR);
        _post(juror2, caseId, AGAINST);
        MandateReactive.Case memory c = rc.getCase(caseId);
        assertEq(uint8(c.status), uint8(MandateReactive.Status.Window));
        assertEq(c.support, ABSTAIN);
        _closeWindow();
        _assertStatus(caseId, MandateReactive.Status.Cast);
        (,, uint256 abstain) = govT.proposalVotes(pid);
        assertEq(abstain, tokenT.FAUCET_AMOUNT());
    }

    function test_threeWaySplit_isSplit() public {
        (uint256 caseId,) = _open(govB);
        _post(juror1, caseId, FOR);
        _post(juror2, caseId, AGAINST);
        _post(juror3, caseId, ABSTAIN);
        _assertStatus(caseId, MandateReactive.Status.Held);
    }

    function test_abstainMajority_castsAbstain() public {
        (uint256 caseId, uint256 pid) = _open(govB);
        _post(juror1, caseId, ABSTAIN);
        _post(juror2, caseId, ABSTAIN);
        _closeWindow();
        (,, uint256 abstain) = govB.proposalVotes(pid);
        assertEq(abstain, tokenB.FAUCET_AMOUNT());
    }

    function test_decisionChangesDuringWindow_keepsWindowEnd() public {
        _policy(MandateReactive.SplitPolicy.Abstain);
        (uint256 caseId, uint256 pid) = _open(govB);
        _post(juror1, caseId, FOR);
        _post(juror2, caseId, AGAINST);
        uint64 dueAt = rc.getCase(caseId).dueAt;
        assertEq(rc.getCase(caseId).support, ABSTAIN);
        _advance(100);
        _postOnly(juror3, caseId, FOR, 9000, false);
        vm.expectEmit(address(rc));
        emit MandateReactive.DecisionChanged(caseId, FOR);
        relay.pump();
        assertEq(rc.getCase(caseId).support, FOR);
        assertEq(rc.getCase(caseId).dueAt, dueAt, "window end unchanged");
        _closeWindow();
        (, uint256 forVotes,) = govB.proposalVotes(pid);
        assertEq(forVotes, tokenB.FAUCET_AMOUNT());
    }

    function test_higherMajorityBar() public {
        MandateReactive.Config memory c = rc.config();
        c.majorityBps = 7000;
        c.quorum = 3;
        _setConfig(c);
        (uint256 caseId,) = _open(govB);
        _post(juror1, caseId, FOR);
        _post(juror2, caseId, FOR);
        _post(juror3, caseId, AGAINST);
        // 200 / 300 = 66.7% is not above 70%.
        _assertStatus(caseId, MandateReactive.Status.Held);
    }

    function test_weightsDecideOneOnOne_afterLearning() public {
        // Teach the quorum that juror1 reads the owner well and juror2 does not.
        (uint256 c1,) = _open(govB);
        _post(juror1, c1, AGAINST);
        _post(juror2, c1, FOR);
        _override(c1, AGAINST);
        assertEq(rc.weightOf(juror1), 125);
        assertEq(rc.weightOf(juror2), 75);

        (uint256 c2, uint256 pid) = _open(govB);
        _post(juror1, c2, AGAINST);
        _post(juror2, c2, FOR);
        // 125 vs 75: AGAINST has 62.5% of the weight.
        _assertStatus(c2, MandateReactive.Status.Window);
        assertEq(rc.getCase(c2).support, AGAINST);
        _closeWindow();
        (uint256 against,,) = govB.proposalVotes(pid);
        assertEq(against, tokenB.FAUCET_AMOUNT());
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Injection

    function test_injectionFlag_holdsBeforeQuorum_andNeverAutoVotes() public {
        (uint256 caseId, uint256 pid) = _open(govB);
        _postOnly(juror1, caseId, FOR, 9000, true);
        vm.expectEmit(address(rc));
        emit MandateReactive.CaseHeld(caseId, MandateReactive.HoldReason.Injection);
        relay.pump();
        _assertStatus(caseId, MandateReactive.Status.Held);
        _post(juror2, caseId, FOR);
        _post(juror3, caseId, FOR);
        _assertStatus(caseId, MandateReactive.Status.Held);
        assertEq(uint8(rc.getCase(caseId).hold), uint8(MandateReactive.HoldReason.Injection));
        _closeWindow();
        _advance(3600);
        _tick();
        assertFalse(govB.hasVoted(pid, address(delegateB)));
        assertFalse(rc.cronActive());
    }

    function test_injectionFlag_duringWindow_stopsTheVote() public {
        (uint256 caseId, uint256 pid) = _open(govB);
        _post(juror1, caseId, FOR);
        _post(juror2, caseId, FOR);
        _assertStatus(caseId, MandateReactive.Status.Window);
        _post(juror3, caseId, AGAINST, 9000, true);
        _assertStatus(caseId, MandateReactive.Status.Held);
        assertFalse(rc.getCase(caseId).hasDecision);
        _closeWindow();
        assertFalse(govB.hasVoted(pid, address(delegateB)));
    }

    function test_injectionFlag_whileWaiting_stopsTheVote() public {
        (uint256 caseId, uint256 pid) = _open(govT);
        MandateReactive.Config memory c = rc.config();
        c.vetoWindow = 5;
        _setConfig(c);
        _post(juror1, caseId, FOR);
        _post(juror2, caseId, FOR);
        _advance(6);
        _tick();
        _assertStatus(caseId, MandateReactive.Status.Waiting);
        _post(juror3, caseId, FOR, 9000, true);
        _assertStatus(caseId, MandateReactive.Status.Held);
        _advance(120);
        _tick();
        assertFalse(govT.hasVoted(pid, address(delegateU)));
    }

    function test_injectionFlag_withLowConfidence_stillHolds() public {
        (uint256 caseId,) = _open(govB);
        _post(juror1, caseId, ABSTAIN, 100, true);
        _assertStatus(caseId, MandateReactive.Status.Held);
    }
}
