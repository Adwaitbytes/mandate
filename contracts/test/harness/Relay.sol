// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {MockCallbackProxy} from "./MockCallbackProxy.sol";
import {MockSystemContract} from "./MockSystemContract.sol";
import {IReactive} from "@reactive/src/interfaces/IReactive.sol";
import {Vm} from "forge-std/Vm.sol";

/// @title Relay
/// @notice Emulates Omni delivery inside one EVM so the whole Mandate loop runs in `forge test`.
///
/// Three chains share one EVM. Every origin or destination contract is registered with the chain id it lives on;
/// the relay stamps that id onto the logs it reads from `vm.getRecordedLogs()`, matches them against the system
/// contract's live subscriptions (equality and wildcards), calls `react()` as the system contract, then hands each
/// requested callback to that destination chain's proxy. It repeats until nothing new happens.
///
/// Tests can hold callbacks to drop, duplicate or reorder them, replay logs, and fire cron ticks.
///
/// Local timing is not real latency: everything here happens in one transaction at one timestamp. Timers are driven
/// by `vm.warp`, and the governor's block clock by `vm.roll`.
contract Relay {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address public constant CRON_EMITTER = 0x0000000000000000000000000000000000fffFfF;
    uint256 public constant MAX_ROUNDS = 64;
    bytes32 public constant CALLBACK_REQUEST_TOPIC = keccak256("CallbackRequest(uint256,address,address,uint64,bytes)");

    MockSystemContract public immutable system;

    mapping(address emitter => uint256 chainId) public chainOf;
    mapping(uint256 chainId => MockCallbackProxy) public proxyOf;

    bool public holdCallbacks;
    MockSystemContract.Request[] internal _held;

    uint256 public routedLogs;
    uint256 public callbacksDelivered;
    uint256 public lastTxHash;
    uint256 private _nonce;

    constructor(MockSystemContract system_) {
        system = system_;
    }

    function setChain(address emitter, uint256 chainId) external {
        chainOf[emitter] = chainId;
    }

    function setProxy(uint256 chainId, MockCallbackProxy proxy) external {
        proxyOf[chainId] = proxy;
    }

    function setHoldCallbacks(bool hold) external {
        holdCallbacks = hold;
    }

    /// @notice Routes recorded logs and delivers callbacks until quiescent.
    function pump() public returns (uint256 rounds) {
        for (; rounds < MAX_ROUNDS; ++rounds) {
            if (!route(VM.getRecordedLogs())) return rounds;
        }
        revert("Relay: no quiescence");
    }

    /// @notice Delivers the given logs (from registered emitters) to every subscribed reactive contract, once each,
    /// and hands every `CallbackRequest` the system contract emitted to the destination proxy (or holds it).
    /// Exposed so tests can replay a batch (duplicate delivery) or deliver batches out of order.
    /// @dev All logs in one call share a synthetic origin tx hash: one batch is one origin transaction. Logs produced
    /// while routing are recorded and handled by the next `pump` round, like a later block.
    function route(Vm.Log[] memory logs) public returns (bool any) {
        uint256 txHash = uint256(keccak256(abi.encode("origin-tx", ++_nonce)));
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter == address(system) && l.topics.length == 4 && l.topics[0] == CALLBACK_REQUEST_TOPIC) {
                any = true;
                (uint64 gasLimit, bytes memory payload) = abi.decode(l.data, (uint64, bytes));
                MockSystemContract.Request memory req = MockSystemContract.Request(
                    address(uint160(uint256(l.topics[2]))),
                    uint256(l.topics[1]),
                    address(uint160(uint256(l.topics[3]))),
                    gasLimit,
                    payload
                );
                if (holdCallbacks) _held.push(req);
                else _deliver(req);
                continue;
            }
            uint256 chainId = chainOf[l.emitter];
            if (chainId == 0) continue;
            lastTxHash = txHash;
            if (_dispatch(_record(l, chainId, txHash, i))) any = true;
        }
    }

    /// @notice Emits one Cron log for every interval (only subscribed ones match) and pumps.
    function tick() external {
        uint256[5] memory topics = [
            uint256(0xf02d6ea5c22a71cffe930a4523fcb4f129be6c804db50e4202fb4e0b07ccb514),
            0x04463f7c1651e6b9774d7f85c85bb94654e3c46ca79b0c16fb16d4183307b687,
            0xb49937fb8970e19fd46d48f7e3fb00d659deac0347f79cd7cb542f0fc1503c70,
            0xe20b31294d84c3661ddc8f423abb9c70310d0cf172aa2714ead78029b325e3f4,
            0xd214e1d84db704ed42d37f538ea9bf71e44ba28bc1cc088b2f5deca654677a56
        ];
        pump();
        for (uint256 i; i < topics.length; ++i) {
            IReactive.LogRecord memory rec;
            rec.chainId = block.chainid;
            rec.contractAddress = CRON_EMITTER;
            rec.topic0 = topics[i];
            rec.data = abi.encode(block.number);
            rec.blockNumber = block.number;
            rec.opCode = 1;
            rec.txHash = uint256(keccak256(abi.encode("cron", block.number, i)));
            _dispatch(rec);
        }
        pump();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Held callbacks

    function heldCount() external view returns (uint256) {
        return _held.length;
    }

    function heldAt(uint256 i) external view returns (MockSystemContract.Request memory) {
        return _held[i];
    }

    /// @notice Delivers held callback `i` and keeps it (so it can be delivered again), then pumps.
    function deliverHeld(uint256 i) external returns (bool ok) {
        ok = _deliver(_held[i]);
        pump();
    }

    /// @notice Drops every held callback.
    function dropHeld() external {
        delete _held;
    }

    /// @notice Delivers and clears every held callback, in reverse order, then pumps.
    function releaseHeldReversed() external {
        MockSystemContract.Request[] memory reqs = _held;
        delete _held;
        for (uint256 i = reqs.length; i > 0; --i) {
            _deliver(reqs[i - 1]);
        }
        pump();
    }

    // ---------------------------------------------------------------------------------------------------------------

    function _dispatch(IReactive.LogRecord memory rec) private returns (bool any) {
        uint256 n = system.subscriptionCount();
        address[] memory seen = new address[](n);
        uint256 seenCount;
        for (uint256 s; s < n; ++s) {
            if (!system.matches(s, rec)) continue;
            address rc = system.subscriptionAt(s).rc;
            bool dup;
            for (uint256 k; k < seenCount; ++k) {
                if (seen[k] == rc) dup = true;
            }
            if (dup) continue;
            seen[seenCount++] = rc;
            system.trigger(rc, rec);
            ++routedLogs;
            any = true;
        }
    }

    function _deliver(MockSystemContract.Request memory req) private returns (bool ok) {
        MockCallbackProxy proxy = proxyOf[req.chainId];
        require(address(proxy) != address(0), "Relay: no proxy for chain");
        ok = proxy.deliver(req.rc, req.recipient, req.gasLimit, req.payload);
        ++callbacksDelivered;
    }

    function _record(Vm.Log memory log_, uint256 chainId, uint256 txHash, uint256 logIndex)
        private
        view
        returns (IReactive.LogRecord memory rec)
    {
        rec.chainId = chainId;
        rec.contractAddress = log_.emitter;
        uint256 n = log_.topics.length;
        if (n > 0) rec.topic0 = uint256(log_.topics[0]);
        if (n > 1) rec.topic1 = uint256(log_.topics[1]);
        if (n > 2) rec.topic2 = uint256(log_.topics[2]);
        if (n > 3) rec.topic3 = uint256(log_.topics[3]);
        rec.data = log_.data;
        rec.blockNumber = block.number;
        rec.opCode = n;
        rec.blockHash = uint256(keccak256(abi.encode("block", block.number)));
        rec.txHash = txHash;
        rec.logIndex = logIndex;
    }
}
