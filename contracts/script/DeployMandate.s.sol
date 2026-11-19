// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Delegate} from "../src/Delegate.sol";
import {DelegateFactory} from "../src/DelegateFactory.sol";
import {Docket} from "../src/Docket.sol";
import {MandateReactive} from "../src/MandateReactive.sol";
import {DemoGovernor} from "../src/demo/DemoGovernor.sol";
import {DemoVotesToken} from "../src/demo/DemoVotesToken.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {Script, console2} from "forge-std/Script.sol";

/// @notice Shared env handling. Every value comes from the environment; a missing one stops the script before any
/// transaction (`vm.env*` reverts). Each script checks it is pointed at the chain the env says it should be.
/// Run with the keystore, never a raw key:
///   forge script script/DeployMandate.s.sol:<Script> --rpc-url $RPC --account omni-deployer --broadcast
/// Order (docs/ARCHITECTURE.md): DeployReactive (Lasna) -> DeployHearing (Base Sepolia) -> DeployGovernorChain (each
/// governor chain) -> WireReactive (Lasna).
abstract contract MandateScript is Script {
    function _expectChain(string memory key) internal view returns (uint256 chainId) {
        chainId = vm.envUint(key);
        require(block.chainid == chainId, string.concat("wrong chain for ", key));
    }

    function _record(string memory name, address value) internal {
        console2.log(name, value);
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".env");
        vm.writeLine(path, string.concat(name, "=", vm.toString(value)));
    }
}

/// @notice Step 1, Reactive Network (Lasna 5318007 or mainnet 1597): the reactive contract, funded at deploy.
/// Env: REACTIVE_CHAIN_ID, MANDATE_OPERATOR, CRON_TOPIC, MIN_VETO_WINDOW (seconds, at least 300 live),
/// REACTIVE_FUNDING_WEI.
contract DeployReactive is MandateScript {
    function run() external returns (MandateReactive rc) {
        _expectChain("REACTIVE_CHAIN_ID");
        address operator = vm.envAddress("MANDATE_OPERATOR");
        uint256 cronTopic = vm.envUint("CRON_TOPIC");
        uint32 minVetoWindow = uint32(vm.envUint("MIN_VETO_WINDOW"));
        uint256 funding = vm.envUint("REACTIVE_FUNDING_WEI");
        vm.startBroadcast();
        rc = new MandateReactive{value: funding}(operator, cronTopic, minVetoWindow);
        vm.stopBroadcast();
        _record("MANDATE_REACTIVE", address(rc));
    }
}

/// @notice Step 2, hearing chain (Base Sepolia 84532): the Docket, its jurors and the first mandate.
/// Env: HEARING_CHAIN_ID, HEARING_CALLBACK_PROXY, MANDATE_REACTIVE, MANDATE_OWNER, DOCKET_FUNDING_WEI,
/// JUROR_ADDRESSES (comma separated), MANDATE_HASH, MANDATE_URI.
/// The broadcaster must be MANDATE_OWNER for the juror and mandate calls; otherwise those two steps are skipped and
/// logged so the owner can run them from their own wallet.
contract DeployHearing is MandateScript {
    function run() external returns (Docket docket) {
        _expectChain("HEARING_CHAIN_ID");
        IPayable proxy = IPayable(payable(vm.envAddress("HEARING_CALLBACK_PROXY")));
        address reactive = vm.envAddress("MANDATE_REACTIVE");
        address owner = vm.envAddress("MANDATE_OWNER");
        uint256 funding = vm.envUint("DOCKET_FUNDING_WEI");
        address[] memory jurors = vm.envAddress("JUROR_ADDRESSES", ",");
        bytes32 mandateHash = vm.envBytes32("MANDATE_HASH");
        string memory mandateUri = vm.envString("MANDATE_URI");
        require(address(proxy).code.length != 0, "callback proxy has no code on this chain");

        vm.startBroadcast();
        docket = new Docket{value: funding}(proxy, reactive, owner);
        // Under `forge script` the broadcasting account is tx.origin.
        if (tx.origin == owner) {
            docket.addJurors(jurors);
            docket.setMandate(mandateHash, mandateUri);
        } else {
            console2.log("broadcaster is not MANDATE_OWNER: add jurors and set the mandate from the owner wallet");
        }
        vm.stopBroadcast();
        _record("DOCKET", address(docket));
    }
}

/// @notice Step 3, each governor chain: demo votes token, demo governor, Delegate factory and the broadcaster's
/// Delegate (funded for callback fees). The broadcaster claims faucet tokens and delegates them to the Delegate.
/// Env: GOVERNOR_CHAIN_ID, GOVERNOR_CALLBACK_PROXY, MANDATE_REACTIVE, TIMESTAMP_CLOCK (true/false),
/// VOTING_DELAY, VOTING_PERIOD (clock units: seconds for timestamp, blocks otherwise), QUORUM_PERCENT,
/// DELEGATE_FUNDING_WEI, TOKEN_NAME, TOKEN_SYMBOL, GOVERNOR_NAME.
contract DeployGovernorChain is MandateScript {
    function run() external returns (DemoGovernor governor, Delegate delegate) {
        _expectChain("GOVERNOR_CHAIN_ID");
        IPayable proxy = IPayable(payable(vm.envAddress("GOVERNOR_CALLBACK_PROXY")));
        address reactive = vm.envAddress("MANDATE_REACTIVE");
        bool timestampClock = vm.envBool("TIMESTAMP_CLOCK");
        uint48 delay = uint48(vm.envUint("VOTING_DELAY"));
        uint32 period = uint32(vm.envUint("VOTING_PERIOD"));
        uint256 quorumPercent = vm.envUint("QUORUM_PERCENT");
        uint256 funding = vm.envUint("DELEGATE_FUNDING_WEI");
        require(address(proxy).code.length != 0, "callback proxy has no code on this chain");

        vm.startBroadcast();
        DemoVotesToken token =
            new DemoVotesToken(vm.envString("TOKEN_NAME"), vm.envString("TOKEN_SYMBOL"), timestampClock);
        governor = new DemoGovernor(vm.envString("GOVERNOR_NAME"), IVotes(address(token)), delay, period, quorumPercent);
        DelegateFactory factory = new DelegateFactory(proxy);
        delegate = Delegate(payable(factory.create{value: funding}(reactive)));
        token.faucetAndDelegate(address(delegate));
        vm.stopBroadcast();

        _record("VOTES_TOKEN", address(token));
        _record("GOVERNOR", address(governor));
        _record("DELEGATE_FACTORY", address(factory));
        _record("DELEGATE", address(delegate));
    }
}

/// @notice Step 4, Reactive Network: point the reactive contract at the Docket, the governors and the Delegates.
/// Env: REACTIVE_CHAIN_ID, MANDATE_REACTIVE, HEARING_CHAIN_ID, DOCKET, WATCH_CHAIN_IDS, WATCH_GOVERNORS,
/// WATCH_CLOCK_MODES (1 block number, 2 timestamp), WATCH_BLOCK_TIMES_MS, WATCH_DELEGATES (all comma separated and
/// index-aligned).
contract WireReactive is MandateScript {
    function run() external {
        _expectChain("REACTIVE_CHAIN_ID");
        MandateReactive rc = MandateReactive(payable(vm.envAddress("MANDATE_REACTIVE")));
        uint256[] memory chainIds = vm.envUint("WATCH_CHAIN_IDS", ",");
        address[] memory governors = vm.envAddress("WATCH_GOVERNORS", ",");
        uint256[] memory clocks = vm.envUint("WATCH_CLOCK_MODES", ",");
        uint256[] memory blockTimes = vm.envUint("WATCH_BLOCK_TIMES_MS", ",");
        address[] memory delegates = vm.envAddress("WATCH_DELEGATES", ",");
        uint256 n = chainIds.length;
        require(
            governors.length == n && clocks.length == n && blockTimes.length == n && delegates.length == n,
            "WATCH_* lists must have equal length"
        );

        vm.startBroadcast();
        if (rc.docket() == address(0)) rc.setDocket(vm.envUint("HEARING_CHAIN_ID"), vm.envAddress("DOCKET"));
        for (uint256 i; i < n; ++i) {
            require(clocks[i] <= uint256(MandateReactive.ClockMode.Timestamp), "bad clock mode");
            rc.watchGovernor(chainIds[i], governors[i], MandateReactive.ClockMode(clocks[i]), uint32(blockTimes[i]));
            rc.setDelegate(chainIds[i], delegates[i]);
        }
        vm.stopBroadcast();
    }
}
