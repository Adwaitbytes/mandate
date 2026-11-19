// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Delegate} from "../../src/Delegate.sol";
import {Docket} from "../../src/Docket.sol";
import {MandateReactive} from "../../src/MandateReactive.sol";
import {DemoGovernor} from "../../src/demo/DemoGovernor.sol";
import {MandateFixture} from "../harness/MandateFixture.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";

/// @notice Whole-loop tests: propose on the demo governor -> relay ProposalCreated -> react -> Docket.openCase ->
/// jurors -> tally -> veto window via cron ticks -> Delegate.cast -> governor records the vote.
contract EndToEndTest is MandateFixture {
    function test_blockClockGovernor_fullLoop_castsFor() public {
        (uint256 caseId, uint256 pid) = _open(govB);
        assertEq(caseId, 1);
        _assertStatus(caseId, MandateReactive.Status.Open);

        Docket.CaseRecord memory dc = docket.getCase(caseId);
        assertEq(dc.proposalId, pid);
        assertEq(dc.governor, address(govB));
        assertEq(dc.originChainId, CHAIN_B);
        assertEq(dc.delegate, address(delegateB));
        assertEq(dc.voteStart, govB.proposalSnapshot(pid));
        assertEq(dc.voteEnd, govB.proposalDeadline(pid));
        assertEq(dc.mandateVersion, 1);
        assertTrue(dc.originTxHash != bytes32(0));
        assertEq(rc.getCase(caseId).mandateVersion, 1);

        _post(juror1, caseId, FOR);
        _assertStatus(caseId, MandateReactive.Status.Open);
        _post(juror2, caseId, FOR);
        _assertStatus(caseId, MandateReactive.Status.Window);
        assertTrue(rc.cronActive());

        _closeWindow();
        _assertStatus(caseId, MandateReactive.Status.Cast);
        assertTrue(govB.hasVoted(pid, address(delegateB)));
        (uint256 against, uint256 forVotes, uint256 abstain) = govB.proposalVotes(pid);
        assertEq(forVotes, tokenB.FAUCET_AMOUNT());
        assertEq(against + abstain, 0);
        assertFalse(rc.cronActive(), "cron off once nothing is timed");
        assertEq(rc.activeCases(), 0);

        Delegate.Receipt memory r = delegateB.receiptOf(caseId);
        assertTrue(r.cast);
        assertEq(r.support, FOR);
        assertEq(r.weight, tokenB.FAUCET_AMOUNT());
    }

    function test_timestampClockGovernor_fullLoop_castsAgainst() public {
        (uint256 caseId, uint256 pid) = _open(govT);
        _post(juror1, caseId, AGAINST);
        _post(juror3, caseId, AGAINST);
        _assertStatus(caseId, MandateReactive.Status.Window);
        _closeWindow();
        _assertStatus(caseId, MandateReactive.Status.Cast);
        (uint256 against,,) = govT.proposalVotes(pid);
        assertEq(against, tokenT.FAUCET_AMOUNT());
        assertEq(uint8(govT.state(pid)), uint8(IGovernor.ProposalState.Active));
    }
}
