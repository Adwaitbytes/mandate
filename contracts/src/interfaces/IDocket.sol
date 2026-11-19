// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title Docket interface: the hearing-chain record of cases, juror verdicts and owner actions.
/// @notice `MandateReactive` subscribes to every event declared here except the juror and mandate housekeeping ones,
/// and reads them by fixed word offsets. Changing the order or types of any non-indexed field is a breaking change
/// for the reactive contract and for the off-chain jurors (see docs/JUROR_INTERFACE.md).
interface IDocket {
    /// @notice A case was opened (or re-acknowledged on a duplicate delivery) for a governor proposal.
    /// @dev Also the acknowledgement `MandateReactive` waits for after requesting `openCase`.
    /// Data words: 0 originChainId, 1 governor, 2 proposalId, 3 voteStart, 4 voteEnd, 5 originTxHash,
    /// 6 delegate, 7 mandateVersion, 8 mandateHash.
    event CaseOpened(
        uint256 indexed caseId,
        uint256 originChainId,
        address governor,
        uint256 proposalId,
        uint256 voteStart,
        uint256 voteEnd,
        bytes32 originTxHash,
        address delegate,
        uint256 mandateVersion,
        bytes32 mandateHash
    );

    /// @notice A registered juror posted its verdict on a case.
    /// @dev Data words: 0 support, 1 confidenceBps, 2 injectionFlag, 3 rationaleHash, 4 modelIdHash, 5 promptHash.
    event Verdict(
        uint256 indexed caseId,
        address indexed juror,
        uint8 support,
        uint16 confidenceBps,
        bool injectionFlag,
        bytes32 rationaleHash,
        bytes32 modelIdHash,
        bytes32 promptHash
    );

    /// @notice The mandate owner vetoed the case: no vote is cast unless one already landed.
    event Vetoed(uint256 indexed caseId);

    /// @notice The mandate owner overrode the case with their own choice of support.
    /// @dev Data word 0: support.
    event Overridden(uint256 indexed caseId, uint8 support);

    /// @notice The mandate text changed. Cases opened afterwards are judged against this version.
    event MandateSet(uint256 indexed version, bytes32 mandateHash, string uri);

    /// @notice A juror address was registered.
    event JurorAdded(address indexed juror);

    /// @notice A juror address was removed. Its past verdicts stay on record.
    event JurorRemoved(address indexed juror);

    /// @notice Callback entry point used by `MandateReactive` through the callback proxy.
    /// @param rvm Reactive contract address, injected by the network over the `address(0)` placeholder.
    /// @param caseId Case identifier assigned by the reactive contract.
    /// @param seq Request sequence number for this case (resends carry a higher number).
    /// @param originChainId Chain id of the governor.
    /// @param governor Governor contract that emitted `ProposalCreated`.
    /// @param proposalId Governor proposal id.
    /// @param voteStart Governor `voteStart` in the governor's clock units.
    /// @param voteEnd Governor `voteEnd` in the governor's clock units.
    /// @param originTxHash Transaction hash of the `ProposalCreated` log on the origin chain.
    /// @param delegate Delegate contract that will cast the vote on the origin chain.
    function openCase(
        address rvm,
        uint256 caseId,
        uint256 seq,
        uint256 originChainId,
        address governor,
        uint256 proposalId,
        uint256 voteStart,
        uint256 voteEnd,
        bytes32 originTxHash,
        address delegate
    ) external;
}
