// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {DeployGovernorChain, DeployHearing, DeployReactive, WireReactive} from "../../script/DeployMandate.s.sol";
import {Delegate} from "../../src/Delegate.sol";
import {Docket} from "../../src/Docket.sol";
import {MandateReactive} from "../../src/MandateReactive.sol";
import {DemoGovernor} from "../../src/demo/DemoGovernor.sol";
import {MockCallbackProxy} from "../harness/MockCallbackProxy.sol";
import {MockSystemContract} from "../harness/MockSystemContract.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Runs the four deploy scripts in-process (one EVM standing in for every chain) with the env they read,
/// so a missing variable or a wiring mistake shows up in CI rather than on a live network.
contract DeployScriptsTest is Test {
    address payable internal constant SYSTEM_ADDR = payable(0x8888888888888888888888888888888888888888);

    function setUp() public {
        vm.etch(SYSTEM_ADDR, address(new MockSystemContract()).code);
        vm.deal(DEFAULT_SENDER, 100 ether);
    }

    function _chainEnv() internal {
        string memory id = vm.toString(block.chainid);
        vm.setEnv("REACTIVE_CHAIN_ID", id);
        vm.setEnv("HEARING_CHAIN_ID", id);
        vm.setEnv("GOVERNOR_CHAIN_ID", id);
    }

    function test_scripts_deployAndWireEndToEnd() public {
        _chainEnv();
        MockCallbackProxy proxy = new MockCallbackProxy();
        vm.setEnv("MANDATE_OPERATOR", vm.toString(DEFAULT_SENDER));
        vm.setEnv("CRON_TOPIC", "0x04463f7c1651e6b9774d7f85c85bb94654e3c46ca79b0c16fb16d4183307b687");
        vm.setEnv("REACTIVE_FUNDING_WEI", "1000000000000000000");
        vm.setEnv("MIN_VETO_WINDOW", "300");
        MandateReactive rc = new DeployReactive().run();
        assertEq(rc.owner(), DEFAULT_SENDER);
        assertEq(address(rc).balance, 1 ether);
        assertEq(rc.MIN_VETO_WINDOW(), 300);

        vm.setEnv("HEARING_CALLBACK_PROXY", vm.toString(address(proxy)));
        vm.setEnv("MANDATE_REACTIVE", vm.toString(address(rc)));
        vm.setEnv("MANDATE_OWNER", vm.toString(DEFAULT_SENDER));
        vm.setEnv("DOCKET_FUNDING_WEI", "10000000000000000");
        vm.setEnv(
            "JUROR_ADDRESSES", "0x0000000000000000000000000000000000000a01,0x0000000000000000000000000000000000000a02"
        );
        vm.setEnv("MANDATE_HASH", vm.toString(keccak256("mandate")));
        vm.setEnv("MANDATE_URI", "ipfs://mandate-v1");
        Docket docket = new DeployHearing().run();
        assertEq(docket.jurors().length, 2);
        assertEq(docket.mandateVersion(), 1);
        assertEq(docket._CALLBACK_SENDER(), address(rc));

        vm.setEnv("GOVERNOR_CALLBACK_PROXY", vm.toString(address(proxy)));
        vm.setEnv("TIMESTAMP_CLOCK", "true");
        vm.setEnv("VOTING_DELAY", "60");
        vm.setEnv("VOTING_PERIOD", "1800");
        vm.setEnv("QUORUM_PERCENT", "1");
        vm.setEnv("DELEGATE_FUNDING_WEI", "10000000000000000");
        vm.setEnv("TOKEN_NAME", "Mandate Demo Votes");
        vm.setEnv("TOKEN_SYMBOL", "MDV");
        vm.setEnv("GOVERNOR_NAME", "Mandate Demo DAO");
        (DemoGovernor gov, Delegate delegate) = new DeployGovernorChain().run();
        assertEq(gov.CLOCK_MODE(), "mode=timestamp");
        assertEq(delegate.owner(), DEFAULT_SENDER);
        assertEq(delegate._CALLBACK_SENDER(), address(rc));

        vm.setEnv("DOCKET", vm.toString(address(docket)));
        vm.setEnv("WATCH_CHAIN_IDS", vm.toString(block.chainid));
        vm.setEnv("WATCH_GOVERNORS", vm.toString(address(gov)));
        vm.setEnv("WATCH_CLOCK_MODES", "2");
        vm.setEnv("WATCH_BLOCK_TIMES_MS", "0");
        vm.setEnv("WATCH_DELEGATES", vm.toString(address(delegate)));
        new WireReactive().run();
        assertEq(rc.docket(), address(docket));
        assertEq(rc.delegateOf(block.chainid), address(delegate));
        assertTrue(rc.watchOf(block.chainid, address(gov)).active);

        // Same test (env is process-wide, parallel tests would race): a script pointed at the wrong chain stops.
        vm.setEnv("REACTIVE_CHAIN_ID", "5318007");
        DeployReactive wrong = new DeployReactive();
        vm.expectRevert(bytes("wrong chain for REACTIVE_CHAIN_ID"));
        wrong.run();
    }
}
