// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {MandateReactive} from "../../src/MandateReactive.sol";
import {MandateFixture} from "../harness/MandateFixture.sol";

/// @notice Security review: tally and veto-window guarantees. Both tests FAIL against the current code.
contract WeightAndWindowTest is MandateFixture {
    address internal juror4 = makeAddr("juror4");
    address internal juror5 = makeAddr("juror5");

    /// Three owner overrides where juror3 alone sided with the owner: weights become 25 / 25 / 175.
    function _trainJuror3() internal {
        for (uint256 i; i < 3; ++i) {
            (uint256 caseId,) = _open(govB);
            _post(juror1, caseId, FOR);
            _post(juror2, caseId, FOR);
            _post(juror3, caseId, AGAINST);
            _override(caseId, AGAINST);
        }
        assertEq(rc.weightOf(juror1), 25);
        assertEq(rc.weightOf(juror2), 25);
        assertEq(rc.weightOf(juror3), 175);
    }

    /// H-2: with default bounds (25..400) one juror key can outvote every other juror combined.
    function test_singleJurorMustNotOutvoteAllOthers() public {
        _trainJuror3();
        (uint256 caseId,) = _open(govB);
        _post(juror1, caseId, FOR, 9000, false);
        _post(juror2, caseId, FOR, 9000, false);
        _post(juror3, caseId, AGAINST, 9000, false);
        MandateReactive.Case memory c = rc.getCase(caseId);
        assertFalse(c.hasDecision && c.support == AGAINST, "one juror decided the vote against two");
    }

    /// H-3: a late verdict flips the decision inside the veto window without restarting it, so the owner gets
    /// seconds (or nothing) to veto the decision that is actually cast.
    function test_decisionChangeInWindow_mustRestartVetoWindow() public {
        address[] memory js = new address[](2);
        js[0] = juror4;
        js[1] = juror5;
        vm.prank(owner);
        docket.addJurors(js);
        MandateReactive.Config memory cfg = rc.config();
        cfg.splitPolicy = MandateReactive.SplitPolicy.Abstain;
        _setConfig(cfg);

        (uint256 caseId,) = _open(govT);
        _post(juror1, caseId, FOR);
        _post(juror2, caseId, FOR); // window starts on FOR, owner sees FOR
        _advance(cfg.vetoWindow - 2);
        _post(juror3, caseId, AGAINST);
        _post(juror4, caseId, AGAINST); // FOR -> ABSTAIN
        _post(juror5, caseId, AGAINST); // ABSTAIN -> AGAINST, 2 s before the window closes
        assertEq(rc.getCase(caseId).support, AGAINST);

        _advance(3);
        _tick();
        MandateReactive.Status s = _status(caseId);
        assertTrue(
            s == MandateReactive.Status.Window || s == MandateReactive.Status.Held,
            "flipped decision was sent without a veto window of its own"
        );
    }
}
