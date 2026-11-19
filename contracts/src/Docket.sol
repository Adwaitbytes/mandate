// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {AbstractCallback} from "@reactive/src/base/AbstractCallback.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {IDocket} from "./interfaces/IDocket.sol";

/// @title Docket
/// @notice The hearing-chain record for one mandate. `MandateReactive` opens cases here by callback, registered
/// jurors post one verdict per case, and the mandate owner may veto or override each case once. Every state change
/// emits an event; the reactive contract subscribes to `CaseOpened`, `Verdict`, `Vetoed` and `Overridden`.
/// @dev The Docket does not learn how a case ends. The reactive contract owns the tally, the timers and the vote,
/// and the Delegate's `Cast` event on the governor's chain is the record of the vote itself.
contract Docket is IDocket, AbstractCallback, Ownable2Step {
    /// @notice Upper bound on registered jurors, which also bounds the reactive contract's per-case loops.
    uint256 public constant MAX_JURORS = 16;
    uint16 public constant MAX_CONFIDENCE_BPS = 10_000;
    uint8 public constant MAX_SUPPORT = 2;

    enum OwnerAction {
        None,
        Veto,
        Override
    }

    struct CaseRecord {
        uint64 originChainId;
        uint64 voteStart;
        uint64 voteEnd;
        uint64 openedAt;
        address governor;
        uint32 mandateVersion;
        uint8 verdictCount;
        OwnerAction ownerAction;
        uint8 overrideSupport;
        address delegate;
        uint256 proposalId;
        bytes32 originTxHash;
    }

    struct VerdictRecord {
        bool posted;
        uint8 support;
        uint16 confidenceBps;
        bool injectionFlag;
        uint64 postedAt;
        bytes32 rationaleHash;
        bytes32 modelIdHash;
        bytes32 promptHash;
    }

    struct MandateRecord {
        bytes32 mandateHash;
        uint64 setAt;
        string uri;
    }

    error UnknownCase(uint256 caseId);
    error InvalidCaseId();
    error NotJuror(address account);
    error AlreadyPosted(uint256 caseId, address juror);
    error InvalidSupport(uint8 support);
    error InvalidConfidence(uint16 confidenceBps);
    error ZeroHash();
    error OwnerAlreadyActed(uint256 caseId);
    error JurorAlreadyRegistered(address juror);
    error TooManyJurors();
    error ZeroAddress();
    error EmptyUri();

    mapping(uint256 caseId => CaseRecord) private _cases;
    mapping(uint256 caseId => mapping(address juror => VerdictRecord)) private _verdicts;
    mapping(uint256 version => MandateRecord) private _mandates;
    mapping(address juror => bool) public isJuror;

    uint256[] private _caseIds;
    address[] private _jurors;

    /// @notice Current mandate version; 0 until the owner sets the first mandate.
    uint256 public mandateVersion;

    /// @param callbackProxy_ Callback proxy on this chain.
    /// @param reactive_ `MandateReactive` address on the Reactive Network (the only accepted callback sender).
    /// @param owner_ Mandate owner: manages jurors and the mandate, vetoes and overrides.
    constructor(IPayable callbackProxy_, address reactive_, address owner_)
        payable
        AbstractCallback(callbackProxy_, reactive_)
        Ownable(owner_)
    {
        if (address(callbackProxy_) == address(0) || reactive_ == address(0)) revert ZeroAddress();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Callback

    /// @inheritdoc IDocket
    /// @dev Idempotent: a duplicate delivery re-emits `CaseOpened` with the stored values so a resend after a lost
    /// acknowledgement still produces one. Never reverts for the authorised sender except on caseId 0.
    function openCase(
        address rvm,
        uint256 caseId,
        uint256, /* seq: carried for tracing; idempotence is keyed on caseId */
        uint256 originChainId,
        address governor,
        uint256 proposalId,
        uint256 voteStart,
        uint256 voteEnd,
        bytes32 originTxHash,
        address delegate
    ) external onlyServiceProvider onlyCallbackSender(rvm) {
        if (caseId == 0) revert InvalidCaseId();
        CaseRecord storage c = _cases[caseId];
        if (c.openedAt == 0) {
            c.originChainId = uint64(originChainId);
            c.governor = governor;
            c.proposalId = proposalId;
            c.voteStart = uint64(voteStart);
            c.voteEnd = uint64(voteEnd);
            c.originTxHash = originTxHash;
            c.delegate = delegate;
            c.mandateVersion = uint32(mandateVersion);
            c.openedAt = uint64(block.timestamp);
            _caseIds.push(caseId);
        }
        emit CaseOpened(
            caseId,
            c.originChainId,
            c.governor,
            c.proposalId,
            c.voteStart,
            c.voteEnd,
            c.originTxHash,
            c.delegate,
            c.mandateVersion,
            _mandates[c.mandateVersion].mandateHash
        );
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Jurors

    /// @notice Posts the caller's verdict on a case. One verdict per juror per case, final once posted.
    /// @param caseId Case to rule on.
    /// @param support 0 against, 1 for, 2 abstain.
    /// @param confidenceBps Confidence in basis points, 0 to 10000.
    /// @param rationaleHash keccak256 of the full rationale document stored off-chain. Must be non-zero.
    /// @param modelIdHash keccak256 of the model identifier string.
    /// @param promptHash keccak256 of the exact committed prompt template.
    /// @param injectionFlag True when the proposal text tries to instruct an AI voter. Any flag holds the case.
    function postVerdict(
        uint256 caseId,
        uint8 support,
        uint16 confidenceBps,
        bytes32 rationaleHash,
        bytes32 modelIdHash,
        bytes32 promptHash,
        bool injectionFlag
    ) external {
        if (!isJuror[msg.sender]) revert NotJuror(msg.sender);
        CaseRecord storage c = _cases[caseId];
        if (c.openedAt == 0) revert UnknownCase(caseId);
        if (support > MAX_SUPPORT) revert InvalidSupport(support);
        if (confidenceBps > MAX_CONFIDENCE_BPS) revert InvalidConfidence(confidenceBps);
        if (rationaleHash == bytes32(0)) revert ZeroHash();
        VerdictRecord storage v = _verdicts[caseId][msg.sender];
        if (v.posted) revert AlreadyPosted(caseId, msg.sender);

        v.posted = true;
        v.support = support;
        v.confidenceBps = confidenceBps;
        v.injectionFlag = injectionFlag;
        v.postedAt = uint64(block.timestamp);
        v.rationaleHash = rationaleHash;
        v.modelIdHash = modelIdHash;
        v.promptHash = promptHash;
        unchecked {
            ++c.verdictCount;
        }
        emit Verdict(caseId, msg.sender, support, confidenceBps, injectionFlag, rationaleHash, modelIdHash, promptHash);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Owner

    /// @notice Vetoes a case. The reactive contract stops it unless the vote already went out, and moves juror
    /// weight toward the jurors that disagreed with the vetoed decision.
    function veto(uint256 caseId) external onlyOwner {
        CaseRecord storage c = _ownerActionable(caseId);
        c.ownerAction = OwnerAction.Veto;
        emit Vetoed(caseId);
    }

    /// @notice Overrides a case with the owner's own support. The reactive contract casts it (skipping the veto
    /// window) unless a different vote already went out, and moves weight toward the jurors that agreed.
    function overrideVote(uint256 caseId, uint8 support) external onlyOwner {
        if (support > MAX_SUPPORT) revert InvalidSupport(support);
        CaseRecord storage c = _ownerActionable(caseId);
        c.ownerAction = OwnerAction.Override;
        c.overrideSupport = support;
        emit Overridden(caseId, support);
    }

    /// @notice Publishes a new mandate version.
    /// @param mandateHash keccak256 of the mandate text.
    /// @param uri Where the text is published (for example an IPFS or HTTPS URL).
    function setMandate(bytes32 mandateHash, string calldata uri) external onlyOwner {
        if (mandateHash == bytes32(0)) revert ZeroHash();
        if (bytes(uri).length == 0) revert EmptyUri();
        uint256 version = ++mandateVersion;
        _mandates[version] = MandateRecord({mandateHash: mandateHash, setAt: uint64(block.timestamp), uri: uri});
        emit MandateSet(version, mandateHash, uri);
    }

    /// @notice Registers juror addresses.
    /// @dev check_rc_source reports this and `removeJurors` as CALLBACK_UNGUARDED because the first parameter is an
    /// address array. They are not callback entry points: the proxy never calls them (`openCase` is the only one),
    /// and `onlyOwner` restricts them to the mandate owner. Accepted finding, recorded in docs/DECISIONS.md.
    function addJurors(address[] calldata accounts) external onlyOwner {
        for (uint256 i; i < accounts.length; ++i) {
            address juror = accounts[i];
            if (juror == address(0)) revert ZeroAddress();
            if (isJuror[juror]) revert JurorAlreadyRegistered(juror);
            if (_jurors.length >= MAX_JURORS) revert TooManyJurors();
            isJuror[juror] = true;
            _jurors.push(juror);
            emit JurorAdded(juror);
        }
    }

    /// @notice Removes juror addresses. Their posted verdicts remain.
    function removeJurors(address[] calldata accounts) external onlyOwner {
        for (uint256 i; i < accounts.length; ++i) {
            address juror = accounts[i];
            if (!isJuror[juror]) revert NotJuror(juror);
            isJuror[juror] = false;
            uint256 n = _jurors.length;
            for (uint256 j; j < n; ++j) {
                if (_jurors[j] == juror) {
                    _jurors[j] = _jurors[n - 1];
                    _jurors.pop();
                    break;
                }
            }
            emit JurorRemoved(juror);
        }
    }

    /// @notice Settles any debt to the callback proxy from this contract's balance. Open to anyone.
    function coverDebt() external {
        _coverDebt();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Views

    /// @notice Case details.
    function getCase(uint256 caseId) external view returns (CaseRecord memory) {
        return _cases[caseId];
    }

    /// @notice A juror's verdict on a case (`posted` is false if none).
    function getVerdict(uint256 caseId, address juror) external view returns (VerdictRecord memory) {
        return _verdicts[caseId][juror];
    }

    /// @notice A mandate version.
    function getMandate(uint256 version) external view returns (MandateRecord memory) {
        return _mandates[version];
    }

    /// @notice Registered jurors.
    function jurors() external view returns (address[] memory) {
        return _jurors;
    }

    /// @notice Number of cases opened.
    function caseCount() external view returns (uint256) {
        return _caseIds.length;
    }

    /// @notice Case id by opening order.
    function caseIdAt(uint256 index) external view returns (uint256) {
        return _caseIds[index];
    }

    function _ownerActionable(uint256 caseId) private view returns (CaseRecord storage c) {
        c = _cases[caseId];
        if (c.openedAt == 0) revert UnknownCase(caseId);
        if (c.ownerAction != OwnerAction.None) revert OwnerAlreadyActed(caseId);
    }
}
