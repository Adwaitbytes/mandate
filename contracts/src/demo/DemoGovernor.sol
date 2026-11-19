// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Governor} from "@openzeppelin/contracts/governance/Governor.sol";
import {GovernorCountingSimple} from "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import {GovernorSettings} from "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import {GovernorVotes} from "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import {
    GovernorVotesQuorumFraction
} from "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";

/// @title DemoGovernor
/// @notice Stock OpenZeppelin governor for the demo DAO. Proposal threshold is 0, so anyone can propose. The clock
/// comes from the token (`GovernorVotes`), so delay and period are in blocks for a block-number token and in seconds
/// for a timestamp token.
contract DemoGovernor is
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    GovernorVotes,
    GovernorVotesQuorumFraction
{
    /// @param token_ Votes token; its clock decides this governor's clock.
    /// @param votingDelay_ Delay before voting opens, in clock units.
    /// @param votingPeriod_ Voting duration, in clock units.
    /// @param quorumPercent_ Quorum as a percentage of total supply at the snapshot.
    constructor(string memory name_, IVotes token_, uint48 votingDelay_, uint32 votingPeriod_, uint256 quorumPercent_)
        Governor(name_)
        GovernorSettings(votingDelay_, votingPeriod_, 0)
        GovernorVotes(token_)
        GovernorVotesQuorumFraction(quorumPercent_)
    {}

    function votingDelay() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingDelay();
    }

    function votingPeriod() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingPeriod();
    }

    function quorum(uint256 timepoint) public view override(Governor, GovernorVotesQuorumFraction) returns (uint256) {
        return super.quorum(timepoint);
    }

    function proposalThreshold() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.proposalThreshold();
    }
}
