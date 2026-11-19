// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {MandateReactive} from "../../src/MandateReactive.sol";
import {IDelegate} from "../../src/interfaces/IDelegate.sol";
import {IDocket} from "../../src/interfaces/IDocket.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";
import {Test} from "forge-std/Test.sol";

/// @dev Compound Governor Bravo's declaration, copied from GovernorBravoInterfaces.sol (compound-protocol). Solidity
/// `uint` is `uint256`, so the canonical signature is the same as OpenZeppelin's.
interface IGovernorBravoEvents {
    event ProposalCreated(
        uint256 id,
        address proposer,
        address[] targets,
        uint256[] values,
        string[] signatures,
        bytes[] calldatas,
        uint256 startBlock,
        uint256 endBlock,
        string description
    );
}

/// @notice Pins every topic constant the reactive contract filters on to the declaring interface.
contract TopicsTest is Test {
    MandateReactive internal rc;

    function setUp() public {
        rc = new MandateReactive(address(this), 0x04463f7c1651e6b9774d7f85c85bb94654e3c46ca79b0c16fb16d4183307b687);
    }

    function test_proposalCreatedTopic_matchesOpenZeppelinAndBravo() public view {
        assertEq(rc.PROPOSAL_CREATED_TOPIC(), uint256(IGovernor.ProposalCreated.selector));
        assertEq(rc.PROPOSAL_CREATED_TOPIC(), uint256(IGovernorBravoEvents.ProposalCreated.selector));
        assertEq(rc.PROPOSAL_CREATED_TOPIC(), 0x7d84a6263ae0d98d3329bd7b46bb4e8d6f98cd35a7adb45c274c8b7fd5ebd5e0);
    }

    function test_docketTopics_matchInterface() public view {
        assertEq(rc.CASE_OPENED_TOPIC(), uint256(IDocket.CaseOpened.selector));
        assertEq(rc.VERDICT_TOPIC(), uint256(IDocket.Verdict.selector));
        assertEq(rc.VETOED_TOPIC(), uint256(IDocket.Vetoed.selector));
        assertEq(rc.OVERRIDDEN_TOPIC(), uint256(IDocket.Overridden.selector));
    }

    function test_delegateTopics_matchInterface() public view {
        assertEq(rc.CAST_TOPIC(), uint256(IDelegate.Cast.selector));
        assertEq(rc.NOT_ACTIVE_TOPIC(), uint256(IDelegate.NotActive.selector));
    }

    function test_cronTopics_matchDocs() public view {
        assertEq(rc.CRON1_TOPIC(), uint256(keccak256("Cron1(uint256)")));
        assertEq(rc.CRON10_TOPIC(), uint256(keccak256("Cron10(uint256)")));
        assertEq(rc.CRON100_TOPIC(), uint256(keccak256("Cron100(uint256)")));
        assertEq(rc.CRON1000_TOPIC(), uint256(keccak256("Cron1000(uint256)")));
        assertEq(rc.CRON10000_TOPIC(), uint256(keccak256("Cron10000(uint256)")));
    }

    function test_constructor_rejectsUnknownCronTopic() public {
        vm.expectRevert(abi.encodeWithSelector(MandateReactive.InvalidCronTopic.selector, uint256(123)));
        new MandateReactive(address(this), 123);
    }
}
