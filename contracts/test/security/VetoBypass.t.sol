// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {MandateReactive} from "../../src/MandateReactive.sol";
import {MandateFixture} from "../harness/MandateFixture.sol";

/// @notice Security review: an owner veto that arrives before any vote exists must stop the vote.
/// Both tests assert the secure behaviour and FAIL against the current code.
contract VetoBypassTest is MandateFixture {
    function setUp() public override {
        super.setUp();
        // Block-clock governor with no declared block time: the first cast request goes out while the proposal is
        // still Pending, which is the documented "retry on NotYetActive" path.
        vm.startPrank(owner);
        rc.watchGovernor(CHAIN_B, address(govB), MandateReactive.ClockMode.BlockNumber, 0);
        MandateReactive.Config memory c = rc.config();
        c.vetoWindow = 10;
        rc.setConfig(c);
        vm.stopPrank();
    }

    /// H-1: veto lands while the case is Casting. It is logged as "too late", the Delegate answers NotYetActive,
    /// the case goes back to Waiting and the vetoed vote is cast on the next tick after voting opens.
    function test_vetoWhileCastInFlight_mustPreventVote() public {
        (uint256 caseId, uint256 pid) = _open(govB);
        _post(juror1, caseId, FOR);
        _post(juror2, caseId, FOR);

        relay.setHoldCallbacks(true);
        _advance(11);
        _tick(); // window over: cast requested, still in flight
        _assertStatus(caseId, MandateReactive.Status.Casting);

        _veto(caseId); // owner vetoes; no vote exists anywhere yet

        relay.setHoldCallbacks(false);
        relay.deliverHeld(0); // proposal still Pending -> NotActive(NotYetActive) -> Waiting
        _advance(120); // voting opens
        _tick();

        assertFalse(govB.hasVoted(pid, address(delegateB)), "a vetoed case cast a vote");
    }

    /// M-1: a stale, delayed cast request (older seq) still executes after the owner vetoed in Waiting. The Delegate
    /// has no way to learn that the case was vetoed.
    function test_staleCastRequestAfterVeto_mustNotVote() public {
        (uint256 caseId, uint256 pid) = _open(govB);
        _post(juror1, caseId, FOR);
        _post(juror2, caseId, FOR);

        relay.setHoldCallbacks(true);
        _advance(11);
        _tick(); // seq 2 in flight (held[0])
        vm.warp(block.timestamp + rc.config().resendAfter); // no ack: resend, block clock unchanged
        _tick(); // seq 3 in flight (held[1])
        relay.deliverHeld(1); // seq 3 -> NotYetActive -> Waiting
        _assertStatus(caseId, MandateReactive.Status.Waiting);

        _veto(caseId);
        _assertStatus(caseId, MandateReactive.Status.Vetoed);

        vm.roll(block.number + 120); // voting opens on the governor chain
        relay.deliverHeld(0); // the delayed seq 2 request finally lands

        assertFalse(govB.hasVoted(pid, address(delegateB)), "stale request voted after veto");
    }
}
