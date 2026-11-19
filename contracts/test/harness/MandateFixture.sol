// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Delegate} from "../../src/Delegate.sol";
import {DelegateFactory} from "../../src/DelegateFactory.sol";
import {Docket} from "../../src/Docket.sol";
import {MandateReactive} from "../../src/MandateReactive.sol";
import {DemoGovernor} from "../../src/demo/DemoGovernor.sol";
import {DemoVotesToken} from "../../src/demo/DemoVotesToken.sol";
import {MockCallbackProxy} from "./MockCallbackProxy.sol";
import {MockSystemContract} from "./MockSystemContract.sol";
import {Relay} from "./Relay.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {IReactive} from "@reactive/src/interfaces/IReactive.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Full local deployment: Reactive (this EVM's chain id), Base Sepolia (Docket, block-clock DAO) and
/// Unichain Sepolia (timestamp-clock DAO), wired the way the deploy scripts wire the live system.
abstract contract MandateFixture is Test {
    uint256 internal constant BASE = 84_532;
    uint256 internal constant UNI = 1301;
    /// @dev Block-clock DAO on Unichain Sepolia (1 s blocks); timestamp-clock DAO on Base Sepolia, whose 200 ms
    /// blocks make block-counted windows awkward. Docket on Base Sepolia.
    uint256 internal constant CHAIN_B = UNI;
    uint256 internal constant CHAIN_T = BASE;
    address payable internal constant SYSTEM_ADDR = payable(0x8888888888888888888888888888888888888888);
    uint256 internal constant CRON10 = 0x04463f7c1651e6b9774d7f85c85bb94654e3c46ca79b0c16fb16d4183307b687;
    uint256 internal constant REACTIVE_IGNORE = 0xa65f96fc951c35ead38878e0f0b7a3c744a6f5ccc1476b313353ce31712313ad;

    uint48 internal constant BLOCK_DELAY = 30; // blocks, 30 s at 1 s blocks
    uint32 internal constant BLOCK_PERIOD = 1800; // blocks, 30 min
    uint48 internal constant TS_DELAY = 60; // seconds
    uint32 internal constant TS_PERIOD = 1800; // seconds
    uint32 internal constant BLOCK_TIME_MS = 1000;

    uint8 internal constant AGAINST = 0;
    uint8 internal constant FOR = 1;
    uint8 internal constant ABSTAIN = 2;

    address internal owner = makeAddr("owner");
    address internal proposer = makeAddr("proposer");
    address internal juror1 = makeAddr("juror1");
    address internal juror2 = makeAddr("juror2");
    address internal juror3 = makeAddr("juror3");

    MockSystemContract internal system;
    MockCallbackProxy internal baseProxy;
    MockCallbackProxy internal uniProxy;
    Relay internal relay;

    MandateReactive internal rc;
    Docket internal docket;
    DemoVotesToken internal tokenB;
    DemoVotesToken internal tokenT;
    DemoGovernor internal govB;
    DemoGovernor internal govT;
    DelegateFactory internal factoryB;
    DelegateFactory internal factoryT;
    Delegate internal delegateB;
    Delegate internal delegateT;

    uint256 private _descNonce;

    function setUp() public virtual {
        vm.warp(1_790_000_000);
        vm.roll(1000);

        MockSystemContract impl = new MockSystemContract();
        vm.etch(SYSTEM_ADDR, address(impl).code);
        system = MockSystemContract(SYSTEM_ADDR);
        baseProxy = new MockCallbackProxy();
        uniProxy = new MockCallbackProxy();
        relay = new Relay(system);
        relay.setProxy(BASE, baseProxy);
        relay.setProxy(UNI, uniProxy);

        vm.deal(owner, 100 ether);
        vm.prank(owner);
        rc = new MandateReactive{value: 1 ether}(owner, CRON10, 0);
        docket = new Docket(IPayable(payable(address(baseProxy))), address(rc), owner);

        tokenB = new DemoVotesToken("Mandate Demo Votes", "MDV", false);
        govB = new DemoGovernor("Mandate Demo DAO (blocks)", IVotes(address(tokenB)), BLOCK_DELAY, BLOCK_PERIOD, 1);
        tokenT = new DemoVotesToken("Mandate Demo Votes T", "MDVT", true);
        govT = new DemoGovernor("Mandate Demo DAO (seconds)", IVotes(address(tokenT)), TS_DELAY, TS_PERIOD, 1);

        factoryB = new DelegateFactory(IPayable(payable(address(uniProxy))));
        factoryT = new DelegateFactory(IPayable(payable(address(baseProxy))));
        vm.startPrank(owner);
        delegateB = Delegate(payable(factoryB.create{value: 0.1 ether}(address(rc))));
        delegateT = Delegate(payable(factoryT.create{value: 0.1 ether}(address(rc))));
        vm.stopPrank();

        relay.setChain(address(docket), BASE);
        relay.setChain(address(govB), CHAIN_B);
        relay.setChain(address(delegateB), CHAIN_B);
        relay.setChain(address(govT), CHAIN_T);
        relay.setChain(address(delegateT), CHAIN_T);

        vm.startPrank(owner);
        rc.setDocket(BASE, address(docket));
        rc.watchGovernor(CHAIN_B, address(govB), MandateReactive.ClockMode.BlockNumber, BLOCK_TIME_MS);
        rc.watchGovernor(CHAIN_T, address(govT), MandateReactive.ClockMode.Timestamp, 0);
        rc.setDelegate(CHAIN_B, address(delegateB));
        rc.setDelegate(CHAIN_T, address(delegateT));
        address[] memory js = new address[](3);
        js[0] = juror1;
        js[1] = juror2;
        js[2] = juror3;
        docket.addJurors(js);
        docket.setMandate(keccak256("Vote against anything that raises emissions."), "ipfs://mandate-v1");
        tokenB.faucetAndDelegate(address(delegateB));
        tokenT.faucetAndDelegate(address(delegateT));
        vm.stopPrank();

        _advance(10);
        vm.recordLogs();
        relay.pump();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Helpers

    /// @dev Moves wall time and the block clock together (1 s blocks, the block-clock DAO's chain).
    function _advance(uint256 secs) internal {
        vm.warp(block.timestamp + secs);
        vm.roll(block.number + secs);
    }

    function _proposeRaw(DemoGovernor gov, string memory description) internal returns (uint256 proposalId) {
        address[] memory targets = new address[](1);
        targets[0] = address(gov);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeCall(gov.votingDelay, ());
        vm.prank(proposer);
        proposalId = gov.propose(targets, values, calldatas, description);
    }

    /// @dev Proposes, lets the relay deliver everything, returns the case id.
    function _open(DemoGovernor gov) internal returns (uint256 caseId, uint256 proposalId) {
        proposalId = _proposeRaw(gov, string.concat("Demo proposal #", vm.toString(++_descNonce)));
        relay.pump();
        caseId = rc.caseIdOf(gov == govB ? CHAIN_B : CHAIN_T, address(gov), proposalId);
    }

    function _post(address juror, uint256 caseId, uint8 support, uint16 confidence, bool injection) internal {
        _postOnly(juror, caseId, support, confidence, injection);
        relay.pump();
    }

    /// @dev Posts on the Docket without relaying, so a test can `expectEmit` on the following `relay.pump()`.
    function _postOnly(address juror, uint256 caseId, uint8 support, uint16 confidence, bool injection) internal {
        vm.prank(juror);
        docket.postVerdict(
            caseId,
            support,
            confidence,
            keccak256(abi.encode("rationale", juror, caseId)),
            keccak256("model"),
            keccak256("prompt"),
            injection
        );
    }

    function _post(address juror, uint256 caseId, uint8 support) internal {
        _post(juror, caseId, support, 9000, false);
    }

    function _tick() internal {
        relay.tick();
    }

    function _status(uint256 caseId) internal view returns (MandateReactive.Status) {
        return rc.getCase(caseId).status;
    }

    function _assertStatus(uint256 caseId, MandateReactive.Status expected) internal view {
        assertEq(uint8(_status(caseId)), uint8(expected), "case status");
    }

    /// @dev Advances past the veto window and ticks.
    function _closeWindow() internal {
        _advance(rc.config().vetoWindow + 1);
        _tick();
    }

    function _veto(uint256 caseId) internal {
        vm.prank(owner);
        docket.veto(caseId);
        relay.pump();
    }

    function _override(uint256 caseId, uint8 support) internal {
        vm.prank(owner);
        docket.overrideVote(caseId, support);
        relay.pump();
    }

    function _log(
        uint256 chainId,
        address emitter,
        uint256 topic0,
        uint256 topic1,
        uint256 topic2,
        uint256 topic3,
        uint256 opCode,
        bytes memory data
    ) internal view returns (IReactive.LogRecord memory rec) {
        rec.chainId = chainId;
        rec.contractAddress = emitter;
        rec.topic0 = topic0;
        rec.topic1 = topic1;
        rec.topic2 = topic2;
        rec.topic3 = topic3;
        rec.data = data;
        rec.blockNumber = block.number;
        rec.opCode = opCode;
        rec.txHash = uint256(keccak256(abi.encode("manual", data)));
    }

    /// @dev Delivers one record through the mock system contract (gas cap, revert caught).
    function _trigger(IReactive.LogRecord memory rec) internal returns (bool ok) {
        ok = system.trigger(address(rc), rec);
        relay.pump();
    }

    function _setConfig(MandateReactive.Config memory cfg) internal {
        vm.prank(owner);
        rc.setConfig(cfg);
    }
}
