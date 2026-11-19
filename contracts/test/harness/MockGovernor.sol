// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @notice Scriptable governor for Delegate unit tests: state, hasVoted, cast reverts and a Bravo-like mode without
/// `hasVoted`.
contract MockGovernor {
    uint8 public currentState = 1;
    bool public stateReverts;
    bool public castReverts;
    bool public bravoLike;
    bool public alreadyVoted;
    uint256 public votes;
    uint256 public lastProposal;
    uint8 public lastSupport;
    string public lastReason;
    uint256 public weight = 42;

    function setState(uint8 s) external {
        currentState = s;
    }

    function setStateReverts(bool v) external {
        stateReverts = v;
    }

    function setCastReverts(bool v) external {
        castReverts = v;
    }

    function setBravoLike(bool v) external {
        bravoLike = v;
    }

    function setAlreadyVoted(bool v) external {
        alreadyVoted = v;
    }

    function state(uint256) external view returns (uint8) {
        require(!stateReverts, "unknown proposal");
        return currentState;
    }

    function hasVoted(uint256, address) external view returns (bool) {
        require(!bravoLike, "no such function");
        return alreadyVoted;
    }

    function castVoteWithReason(uint256 proposalId, uint8 support, string calldata reason) external returns (uint256) {
        require(!castReverts, "GovernorAlreadyCastVote");
        ++votes;
        lastProposal = proposalId;
        lastSupport = support;
        lastReason = reason;
        return weight;
    }
}
