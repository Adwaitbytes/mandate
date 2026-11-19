// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {MandateReactive} from "../../src/MandateReactive.sol";
import {MandateFixture} from "../harness/MandateFixture.sol";

/// @notice Juror weight learning under random bounds and random veto/override histories. Logs are injected straight
/// into the reactive contract (as the system contract) to keep each run cheap; the relay path is covered elsewhere.
contract WeightsFuzzTest is MandateFixture {
    uint256 internal constant PC_TOPIC = 0x7d84a6263ae0d98d3329bd7b46bb4e8d6f98cd35a7adb45c274c8b7fd5ebd5e0;

    function _newCase(uint256 pid) internal returns (uint256 caseId) {
        bytes memory data = abi.encode(
            pid,
            proposer,
            new address[](1),
            new uint256[](1),
            new string[](1),
            new bytes[](1),
            block.number + 30,
            block.number + 930,
            "fuzz"
        );
        system.trigger(address(rc), _log(CHAIN_B, address(govB), PC_TOPIC, 0, 0, 0, 1, data));
        caseId = rc.caseCount();
    }

    function _verdict(uint256 caseId, address juror, uint8 support) internal {
        bytes memory data = abi.encode(support, uint16(9000), false, keccak256(abi.encode(caseId, juror)), 0, 0);
        system.trigger(address(rc), _log(BASE, address(docket), rc.VERDICT_TOPIC(), caseId, uint160(juror), 0, 3, data));
    }

    function _ownerAction(uint256 caseId, bool veto, uint8 support) internal {
        if (veto) {
            system.trigger(address(rc), _log(BASE, address(docket), rc.VETOED_TOPIC(), caseId, 0, 0, 2, ""));
        } else {
            system.trigger(
                address(rc),
                _log(BASE, address(docket), rc.OVERRIDDEN_TOPIC(), caseId, 0, 0, 2, abi.encode(uint256(support)))
            );
        }
    }

    function _bounds(uint32 min, uint32 initial, uint32 max, uint32 step)
        internal
        returns (MandateReactive.WeightBounds memory b)
    {
        b.min = uint32(bound(min, 1, 1000));
        b.initial = uint32(bound(initial, b.min, b.min + 2000));
        b.max = uint32(bound(max, b.initial, b.initial + 5000));
        b.step = uint32(bound(step, 1, 3000));
        vm.prank(owner);
        rc.setWeightBounds(b);
    }

    function testFuzz_weightsStayWithinBounds(uint32 min, uint32 initial, uint32 max, uint32 step, uint256 seed)
        public
    {
        MandateReactive.WeightBounds memory b = _bounds(min, initial, max, step);
        address[3] memory js = [juror1, juror2, juror3];
        for (uint256 k; k < 10; ++k) {
            uint256 caseId = _newCase(k + 1);
            for (uint256 j; j < 3; ++j) {
                if (uint256(keccak256(abi.encode(seed, k, j, "skip"))) % 5 == 0) continue;
                _verdict(caseId, js[j], uint8(uint256(keccak256(abi.encode(seed, k, j))) % 3));
            }
            uint256 r = uint256(keccak256(abi.encode(seed, k, "action")));
            _ownerAction(caseId, r % 2 == 0, uint8((r >> 8) % 3));
            for (uint256 j; j < 3; ++j) {
                uint32 w = rc.weightOf(js[j]);
                assertGe(w, b.min);
                assertLe(w, b.max);
            }
        }
        assertEq(system.revertedReactions(), 0);
    }

    function testFuzz_override_movesEachJurorOneStepTowardOwner(
        uint32 min,
        uint32 initial,
        uint32 max,
        uint32 step,
        uint8 s1,
        uint8 s2,
        uint8 s3,
        uint8 ownerSupport
    ) public {
        MandateReactive.WeightBounds memory b = _bounds(min, initial, max, step);
        ownerSupport = ownerSupport % 3;
        uint8[3] memory sup = [s1 % 3, s2 % 3, s3 % 3];
        address[3] memory js = [juror1, juror2, juror3];
        uint256 caseId = _newCase(1);
        for (uint256 j; j < 3; ++j) {
            _verdict(caseId, js[j], sup[j]);
        }
        _ownerAction(caseId, false, ownerSupport);
        for (uint256 j; j < 3; ++j) {
            uint256 expected = sup[j] == ownerSupport
                ? (uint256(b.initial) + b.step >= b.max ? b.max : b.initial + b.step)
                : (uint256(b.initial) <= uint256(b.min) + b.step ? b.min : b.initial - b.step);
            assertEq(rc.weightOf(js[j]), expected);
        }
    }

    function testFuzz_veto_rewardsDissent(uint8 decided, uint8 dissent) public {
        decided = decided % 3;
        dissent = uint8((uint256(decided) + 1 + (dissent % 2)) % 3);
        uint256 caseId = _newCase(1);
        _verdict(caseId, juror1, decided);
        _verdict(caseId, juror2, decided);
        _verdict(caseId, juror3, dissent);
        assertTrue(rc.getCase(caseId).hasDecision);
        _ownerAction(caseId, true, 0);
        assertEq(rc.weightOf(juror1), 75);
        assertEq(rc.weightOf(juror2), 75);
        assertEq(rc.weightOf(juror3), 125);
        assertEq(uint8(rc.getCase(caseId).status), uint8(MandateReactive.Status.Vetoed));
    }

    function testFuzz_ownerActsOnce(uint8 support) public {
        uint256 caseId = _newCase(1);
        _verdict(caseId, juror1, FOR);
        _ownerAction(caseId, false, support % 3);
        uint32 w = rc.weightOf(juror1);
        _ownerAction(caseId, false, support % 3);
        _ownerAction(caseId, true, 0);
        assertEq(rc.weightOf(juror1), w, "second owner action ignored");
    }

    function testFuzz_boundsChange_clampsStoredWeightsOnRead(uint32 newMax) public {
        uint256 caseId = _newCase(1);
        _verdict(caseId, juror1, FOR);
        _ownerAction(caseId, false, FOR);
        assertEq(rc.weightOf(juror1), 125);
        newMax = uint32(bound(newMax, 100, 124));
        vm.prank(owner);
        rc.setWeightBounds(MandateReactive.WeightBounds({min: 25, initial: 100, max: newMax, step: 25}));
        assertEq(rc.weightOf(juror1), newMax);
    }
}
