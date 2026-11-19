// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title The subset of governor functions the Delegate needs.
/// @notice OpenZeppelin Governor and Compound Governor Bravo share these selectors and the order of the
/// ProposalState enum (Pending 0, Active 1, Canceled 2, Defeated 3, Succeeded 4, Queued 5, Expired 6, Executed 7),
/// so one Delegate serves both. Bravo's `castVoteWithReason` returns nothing and Bravo has no `hasVoted`, so the
/// Delegate calls all three with low-level calls and accepts empty return data (security review M-4).
interface IGovernorLike {
    function state(uint256 proposalId) external view returns (uint8);

    function hasVoted(uint256 proposalId, address account) external view returns (bool);

    function castVoteWithReason(uint256 proposalId, uint8 support, string calldata reason) external returns (uint256);
}
