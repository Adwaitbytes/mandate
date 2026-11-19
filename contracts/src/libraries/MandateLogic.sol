// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {MandateReactive} from "../MandateReactive.sol";
import {IDelegate} from "../interfaces/IDelegate.sol";
import {IDocket} from "../interfaces/IDocket.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title MandateLogic
/// @notice Configuration checks, tally, weight learning and the vote reason for `MandateReactive`, moved into an
/// externally linked library so the reactive contract fits the EIP-170 code size limit (24,576 bytes), which Lasna
/// enforces ("max code size exceeded" on the first live deploy). Called with DELEGATECALL, so every storage write and
/// event lands on the reactive contract exactly as when this code was inline. Events are redeclared here with the
/// same signatures, so their topics are unchanged.
library MandateLogic {
    using Strings for uint256;

    // Floors and bounds; `MandateReactive` re-exports each as a public constant.
    uint8 internal constant MIN_QUORUM = 2;
    uint8 internal constant MIN_AGREEING = 2;
    uint16 internal constant MIN_CONFIDENCE_FLOOR_BPS = 5000;
    uint256 internal constant MAX_BALLOTS_PER_CASE = 16;
    uint64 internal constant MIN_CALLBACK_GAS = 100_000;
    uint64 internal constant MAX_CALLBACK_GAS = 3_000_000;
    uint32 internal constant MAX_WEIGHT = 1_000_000;
    uint16 internal constant BPS = 10_000;
    uint8 internal constant ABSTAIN = 2;

    event ConfigUpdated(MandateReactive.Config config);
    event WeightBoundsUpdated(MandateReactive.WeightBounds bounds);
    event TallyUpdated(
        uint256 indexed caseId,
        uint256 againstWeight,
        uint256 forWeight,
        uint256 abstainWeight,
        uint256 lowConfidenceWeight,
        uint256 ballots
    );
    event WeightsUpdated(uint256 indexed caseId, address[] jurors, uint32[] weights);

    error InvalidConfig();
    error InvalidWeightBounds();

    /// @notice Validates `src` against the floors and stores it in `dst`.
    function applyConfig(MandateReactive.Config storage dst, MandateReactive.Config calldata src, uint32 minVetoWindow)
        external
    {
        if (
            src.quorum < MIN_QUORUM || src.quorum > MAX_BALLOTS_PER_CASE || src.minAgreeing < MIN_AGREEING
                || src.minAgreeing > src.quorum || src.injectionFlagsToHold == 0
                || src.injectionFlagsToHold > src.quorum || src.minConfidenceBps < MIN_CONFIDENCE_FLOOR_BPS
                || src.minConfidenceBps > BPS || src.majorityBps < BPS / 2 || src.majorityBps >= BPS
                || src.maxAttempts == 0 || src.vetoWindow < minVetoWindow || src.vetoWindow > 7 days
                || src.resendAfter == 0 || src.retryAfter == 0 || src.caseTtl < src.vetoWindow
                || src.openCaseGas < MIN_CALLBACK_GAS || src.openCaseGas > MAX_CALLBACK_GAS
                || src.castGas < MIN_CALLBACK_GAS || src.castGas > MAX_CALLBACK_GAS
        ) revert InvalidConfig();
        dst.quorum = src.quorum;
        dst.minAgreeing = src.minAgreeing;
        dst.injectionFlagsToHold = src.injectionFlagsToHold;
        dst.minConfidenceBps = src.minConfidenceBps;
        dst.majorityBps = src.majorityBps;
        dst.splitPolicy = src.splitPolicy;
        dst.maxAttempts = src.maxAttempts;
        dst.vetoWindow = src.vetoWindow;
        dst.resendAfter = src.resendAfter;
        dst.retryAfter = src.retryAfter;
        dst.caseTtl = src.caseTtl;
        dst.openCaseGas = src.openCaseGas;
        dst.castGas = src.castGas;
        emit ConfigUpdated(src);
    }

    /// @notice Validates and stores juror weight bounds.
    function applyWeightBounds(MandateReactive.WeightBounds storage dst, MandateReactive.WeightBounds calldata src)
        external
    {
        if (
            src.min == 0 || src.min > src.initial || src.initial > src.max || src.max > MAX_WEIGHT || src.step == 0
                || src.step > MAX_WEIGHT
        ) revert InvalidWeightBounds();
        dst.min = src.min;
        dst.initial = src.initial;
        dst.max = src.max;
        dst.step = src.step;
        emit WeightBoundsUpdated(src);
    }

    /// @dev A side wins only with at least `minAgreeing` confident ballots and a weight share strictly above
    /// `majorityBps` of all posted weight. The ballot count is what keeps one heavy juror from deciding alone
    /// (review H-2); weight can still block a side but never carry one by itself.
    function tally(
        uint256 caseId,
        address[] storage jurors,
        mapping(address => MandateReactive.Ballot) storage ballots,
        mapping(address => uint32) storage rawWeight,
        MandateReactive.WeightBounds memory bounds,
        uint16 minConfidenceBps,
        uint8 minAgreeing,
        uint16 majorityBps
    ) external returns (bool, uint8) {
        // side[0..2]: confident weight per support, side[3]: low-confidence weight, side[4]: total weight.
        uint256[5] memory side;
        uint256[3] memory count;
        uint256 n = jurors.length;
        for (uint256 i; i < n; ++i) {
            address juror = jurors[i];
            MandateReactive.Ballot storage b = ballots[juror];
            uint256 w = weightOf(rawWeight[juror], bounds);
            side[4] += w;
            if (b.confidenceBps >= minConfidenceBps) {
                side[b.support] += w;
                ++count[b.support];
            } else {
                side[3] += w;
            }
        }
        emit TallyUpdated(caseId, side[0], side[1], side[2], side[3], n);
        for (uint8 s; s <= ABSTAIN; ++s) {
            if (count[s] >= minAgreeing && side[s] * BPS > side[4] * majorityBps) return (true, s);
        }
        return (false, 0);
    }

    /// @dev Moves each juror that took part one step toward (agreed) or away from (disagreed) the owner.
    /// Veto: a juror agreed with the owner when its support differs from the vetoed decision.
    /// Override: a juror agreed when its support equals the owner's.
    function learn(
        uint256 caseId,
        address[] storage caseJurors,
        mapping(address => MandateReactive.Ballot) storage ballots,
        mapping(address => uint32) storage rawWeight,
        MandateReactive.WeightBounds memory bounds,
        uint8 ownerSupport,
        bool agreeOnEqual
    ) external {
        uint256 n = caseJurors.length;
        if (n == 0) return;
        address[] memory jurors = new address[](n);
        uint32[] memory weights = new uint32[](n);
        for (uint256 i; i < n; ++i) {
            address juror = caseJurors[i];
            bool same = ballots[juror].support == ownerSupport;
            // uint256 arithmetic: a step near 2^32 cannot overflow and make react() revert (review L-3).
            uint256 w = weightOf(rawWeight[juror], bounds);
            if (same == agreeOnEqual) {
                w = w + bounds.step >= bounds.max ? bounds.max : w + bounds.step;
            } else {
                w = w <= uint256(bounds.min) + bounds.step ? bounds.min : w - bounds.step;
            }
            rawWeight[juror] = uint32(w);
            jurors[i] = juror;
            weights[i] = uint32(w);
        }
        emit WeightsUpdated(caseId, jurors, weights);
    }

    /// @dev Short, deterministic reason string: case, mandate version, decision path and the rationale hash of the
    /// heaviest juror on the winning side (the full text is published off-chain under that hash).
    function reason(
        uint256 caseId,
        MandateReactive.Case storage c,
        mapping(address => MandateReactive.Ballot) storage ballots,
        mapping(address => uint32) storage rawWeight,
        MandateReactive.WeightBounds memory bounds,
        uint16 minConfidence
    ) internal view returns (string memory) {
        string memory head = string.concat(
            "Mandate case ", caseId.toString(), ", mandate v", uint256(c.mandateVersion).toString()
        );
        if (c.overridden) return string.concat(head, ": owner override");
        bytes32 best;
        uint32 bestWeight;
        uint256 n = c.jurors.length;
        for (uint256 i; i < n; ++i) {
            address juror = c.jurors[i];
            MandateReactive.Ballot storage b = ballots[juror];
            uint32 w = weightOf(rawWeight[juror], bounds);
            if (b.support == c.support && b.confidenceBps >= minConfidence && w > bestWeight) {
                best = b.rationaleHash;
                bestWeight = w;
            }
        }
        if (best == bytes32(0)) return string.concat(head, ": split verdict, abstaining");
        return string.concat(head, ": juror quorum, rationale ", uint256(best).toHexString(32));
    }

    /// @notice `Docket.openCase` payload for the case's current sequence number.
    function openCasePayload(uint256 caseId, MandateReactive.Case storage c) external view returns (bytes memory) {
        return abi.encodeCall(
            IDocket.openCase,
            (
                address(0),
                caseId,
                c.seq,
                c.originChainId,
                c.governor,
                c.proposalId,
                c.voteStart,
                c.voteEnd,
                bytes32(c.originTxHash),
                c.delegate
            )
        );
    }

    /// @notice `Delegate.cast` payload for the case's current sequence number and decision, with its reason.
    function castPayload(
        uint256 caseId,
        MandateReactive.Case storage c,
        mapping(address => MandateReactive.Ballot) storage ballots,
        mapping(address => uint32) storage rawWeight,
        MandateReactive.WeightBounds memory bounds,
        uint16 minConfidence
    ) external view returns (bytes memory) {
        return abi.encodeCall(
            IDelegate.cast,
            (
                address(0),
                caseId,
                c.seq,
                c.governor,
                c.proposalId,
                c.support,
                reason(caseId, c, ballots, rawWeight, bounds, minConfidence)
            )
        );
    }

    /// @dev Stored weight clamped into the current bounds; 0 means the juror never moved (initial weight).
    function weightOf(uint32 raw, MandateReactive.WeightBounds memory bounds) internal pure returns (uint32) {
        if (raw == 0) return bounds.initial;
        if (raw < bounds.min) return bounds.min;
        if (raw > bounds.max) return bounds.max;
        return raw;
    }
}
