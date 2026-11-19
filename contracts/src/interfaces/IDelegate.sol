// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title Delegate interface: casts votes on a governor's chain on behalf of one user.
interface IDelegate {
    /// @notice Why a cast request did not produce a vote.
    /// @dev The reactive contract maps NotYetActive and StateUnavailable to a retry, Ended to give-up, ignores
    /// Superseded (an older request than one already processed), and maps every other code to a failed case.
    enum Refusal {
        None,
        NotYetActive,
        Ended,
        Paused,
        CastReverted,
        StateUnavailable,
        InvalidSupport,
        Superseded
    }

    /// @notice Acknowledgement: the vote for `caseId` is on record at the governor.
    /// @dev Re-emitted unchanged (except `seq`) on duplicate deliveries. Data words: 0 seq, 1 support, 2 weight.
    event Cast(
        uint256 indexed caseId,
        address indexed governor,
        uint256 indexed proposalId,
        uint256 seq,
        uint8 support,
        uint256 weight
    );

    /// @notice Acknowledgement: the request with this `seq` did not produce a vote.
    /// @dev Data words: 0 seq, 1 reason (Refusal), 2 governor state (255 when unavailable).
    event NotActive(uint256 indexed caseId, uint256 seq, uint8 reason, uint8 proposalState);

    /// @notice Acknowledgement: cast requests for `caseId` with a sequence number below `seq` will be refused.
    /// @dev Data word 0: seq.
    event Cancelled(uint256 indexed caseId, uint256 seq);

    /// @notice Callback entry point: refuse every cast request for `caseId` numbered below `seq`. Sent after a veto,
    /// an override that changes the support, or an injection hold, whenever a cast request may still be in flight.
    function cancel(address rvm, uint256 caseId, uint256 seq) external;

    /// @notice Callback entry point used by `MandateReactive` through the callback proxy.
    /// @param rvm Reactive contract address, injected by the network over the `address(0)` placeholder.
    /// @param caseId Case identifier; casting is idempotent per case and refuses requests older than the newest one
    /// already processed or cancelled.
    /// @param seq Request sequence number, echoed in the acknowledgement.
    /// @param governor Governor to vote on.
    /// @param proposalId Proposal to vote on.
    /// @param support 0 against, 1 for, 2 abstain.
    /// @param reason Reason string passed to `castVoteWithReason`.
    function cast(
        address rvm,
        uint256 caseId,
        uint256 seq,
        address governor,
        uint256 proposalId,
        uint8 support,
        string calldata reason
    ) external;
}
