// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Delegate} from "../../src/Delegate.sol";
import {DelegateFactory} from "../../src/DelegateFactory.sol";
import {IDelegate} from "../../src/interfaces/IDelegate.sol";
import {MockCallbackProxy} from "../harness/MockCallbackProxy.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {Test} from "forge-std/Test.sol";

/// @dev Faithful to Compound GovernorBravoDelegate: `castVoteWithReason` returns nothing and there is no `hasVoted`.
contract BravoShapedGovernor {
    uint256 public votes;

    function state(uint256) external pure returns (uint8) {
        return 1; // Active
    }

    function castVoteWithReason(uint256, uint8, string calldata) external {
        ++votes;
    }
}

/// @notice Security review M-4: the Delegate claims Bravo support but decodes a uint256 from an empty return,
/// which reverts outside the try/catch, rolls back the vote and burns a billed callback every attempt.
/// FAILS against the current code.
contract BravoGovernorTest is Test {
    function test_bravoGovernor_voteLands() public {
        MockCallbackProxy proxy = new MockCallbackProxy();
        DelegateFactory factory = new DelegateFactory(IPayable(payable(address(proxy))));
        address rvm = makeAddr("rvm");
        address user = makeAddr("user");
        vm.prank(user);
        Delegate delegate = Delegate(payable(factory.create(rvm)));
        BravoShapedGovernor gov = new BravoShapedGovernor();

        bytes memory payload = abi.encodeCall(IDelegate.cast, (address(0), 1, 1, address(gov), 7, 1, "reason"));
        bool ok = proxy.deliver(rvm, address(delegate), 600_000, payload);

        assertTrue(ok, "callback reverted on a Bravo governor");
        assertEq(gov.votes(), 1, "vote rolled back");
        assertTrue(delegate.receiptOf(1).cast);
    }
}
