// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {Test} from "forge-std/Test.sol";
import {DemoGovernor} from "../../src/demo/DemoGovernor.sol";
import {DemoVotesToken} from "../../src/demo/DemoVotesToken.sol";

contract DemoDaoTest is Test {
    DemoVotesToken internal blockToken;
    DemoVotesToken internal tsToken;
    DemoGovernor internal blockGov;
    DemoGovernor internal tsGov;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        vm.warp(1_790_000_000);
        vm.roll(100);
        blockToken = new DemoVotesToken("B", "B", false);
        tsToken = new DemoVotesToken("T", "T", true);
        blockGov = new DemoGovernor("BG", IVotes(address(blockToken)), 30, 900, 1);
        tsGov = new DemoGovernor("TG", IVotes(address(tsToken)), 60, 1800, 1);
    }

    function _propose(DemoGovernor gov, address who) internal returns (uint256) {
        address[] memory t = new address[](1);
        t[0] = address(gov);
        uint256[] memory v = new uint256[](1);
        bytes[] memory c = new bytes[](1);
        vm.prank(who);
        return gov.propose(t, v, c, "demo");
    }

    function test_clockModes() public view {
        assertEq(blockToken.clock(), block.number);
        assertEq(blockToken.CLOCK_MODE(), "mode=blocknumber&from=default");
        assertEq(tsToken.clock(), block.timestamp);
        assertEq(tsToken.CLOCK_MODE(), "mode=timestamp");
        assertEq(blockGov.clock(), block.number);
        assertEq(tsGov.clock(), block.timestamp);
        assertEq(tsGov.CLOCK_MODE(), "mode=timestamp");
    }

    function test_faucet_selfDelegatesOnFirstClaim() public {
        vm.prank(alice);
        blockToken.faucet();
        assertEq(blockToken.balanceOf(alice), blockToken.FAUCET_AMOUNT());
        assertEq(blockToken.delegates(alice), alice);
        vm.roll(block.number + 1);
        assertEq(blockToken.getVotes(alice), blockToken.FAUCET_AMOUNT());
    }

    function test_faucet_keepsExistingDelegate() public {
        vm.prank(alice);
        blockToken.faucetAndDelegate(bob);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(alice);
        blockToken.faucet();
        assertEq(blockToken.delegates(alice), bob);
        assertEq(blockToken.getVotes(bob), 2 * blockToken.FAUCET_AMOUNT());
    }

    function test_faucet_rateLimited() public {
        vm.prank(alice);
        blockToken.faucet();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DemoVotesToken.FaucetCooldown.selector, block.timestamp + 1 hours));
        blockToken.faucet();
        vm.warp(block.timestamp + 1 hours);
        vm.prank(alice);
        blockToken.faucet();
        assertEq(blockToken.balanceOf(alice), 2 * blockToken.FAUCET_AMOUNT());
    }

    function test_faucetAndDelegate_rejectsZero() public {
        vm.expectRevert(DemoVotesToken.ZeroAddress.selector);
        blockToken.faucetAndDelegate(address(0));
    }

    function test_anyoneCanPropose_thresholdZero() public {
        assertEq(blockGov.proposalThreshold(), 0);
        uint256 pid = _propose(blockGov, bob);
        assertEq(uint8(blockGov.state(pid)), uint8(IGovernor.ProposalState.Pending));
        assertEq(blockGov.proposalProposer(pid), bob);
    }

    function test_blockGovernor_windowsInBlocks() public {
        uint256 pid = _propose(blockGov, alice);
        assertEq(blockGov.proposalSnapshot(pid), block.number + 30);
        assertEq(blockGov.proposalDeadline(pid), block.number + 30 + 900);
        vm.warp(block.timestamp + 10 days);
        assertEq(uint8(blockGov.state(pid)), uint8(IGovernor.ProposalState.Pending), "time alone does not open it");
        vm.roll(block.number + 31);
        assertEq(uint8(blockGov.state(pid)), uint8(IGovernor.ProposalState.Active));
        vm.roll(block.number + 900);
        assertEq(uint8(blockGov.state(pid)), uint8(IGovernor.ProposalState.Defeated));
    }

    function test_timestampGovernor_windowsInSeconds() public {
        uint256 pid = _propose(tsGov, alice);
        assertEq(tsGov.proposalSnapshot(pid), block.timestamp + 60);
        assertEq(tsGov.proposalDeadline(pid), block.timestamp + 60 + 1800);
        vm.roll(block.number + 10_000);
        assertEq(uint8(tsGov.state(pid)), uint8(IGovernor.ProposalState.Pending), "blocks alone do not open it");
        vm.warp(block.timestamp + 61);
        assertEq(uint8(tsGov.state(pid)), uint8(IGovernor.ProposalState.Active));
        vm.warp(block.timestamp + 1800);
        assertEq(uint8(tsGov.state(pid)), uint8(IGovernor.ProposalState.Defeated));
    }

    function test_delegatedVotesCount_atSnapshot() public {
        vm.prank(alice);
        tsToken.faucetAndDelegate(bob);
        vm.warp(block.timestamp + 1);
        uint256 pid = _propose(tsGov, alice);
        vm.warp(block.timestamp + 61);
        vm.prank(bob);
        uint256 weight = tsGov.castVoteWithReason(pid, 1, "because");
        assertEq(weight, tsToken.FAUCET_AMOUNT());
    }
}
