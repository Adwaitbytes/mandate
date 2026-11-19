// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IReactive} from "@reactive/src/interfaces/IReactive.sol";
import {ISystemContract} from "@reactive/src/interfaces/ISystemContract.sol";

/// @title MockSystemContract
/// @notice Local stand-in for the Reactive Network system contract. The fixture etches this code at
/// 0x8888888888888888888888888888888888888888 so `AbstractReactive.SYSTEM` resolves to it.
/// @dev Mirrors the documented behaviour that matters for correctness:
/// - subscriptions live here, not in the reactive contract, and need at least one specific criterion;
/// - `unsubscribe` must repeat all six criteria exactly, otherwise it silently does nothing (counted, so tests can
///   assert it never happens);
/// - callback requests under 100k gas are ignored;
/// - `react()` runs with a 900k gas cap and a revert is caught and logged, never bubbled.
/// It does not model fees, debt or latency. Local timing is not real latency.
contract MockSystemContract {
    uint256 public constant REACTIVE_IGNORE = 0xa65f96fc951c35ead38878e0f0b7a3c744a6f5ccc1476b313353ce31712313ad;
    uint256 public constant REACT_GAS_CAP = 900_000;
    uint64 public constant MIN_CALLBACK_GAS = 100_000;

    struct Subscription {
        address rc;
        uint256 chainId;
        address emitter;
        uint256 topic0;
        uint256 topic1;
        uint256 topic2;
        uint256 topic3;
        bool active;
    }

    struct Request {
        address rc;
        uint256 chainId;
        address recipient;
        uint64 gasLimit;
        bytes payload;
    }

    event Subscribed(address indexed rc, uint256 chainId, address emitter, uint256 topic0);
    event Unsubscribed(address indexed rc, uint256 chainId, address emitter, uint256 topic0);
    event CallbackRequest(uint256 indexed chainId, address indexed sender, address indexed recipient, bytes payload);
    event ReactiveContractReverted(address indexed rc, bytes reason);

    Subscription[] internal _subs;
    Request[] internal _pending;

    uint256 public reactions;
    uint256 public revertedReactions;
    uint256 public ignoredCallbacks;
    uint256 public totalCallbackRequests;
    uint256 public unsubscribeMisses;
    uint256 public lastReactGas;
    uint256 public maxReactGas;

    receive() external payable {}

    function subscribe(uint256 chainId, address emitter, uint256 t0, uint256 t1, uint256 t2, uint256 t3) external {
        require(
            chainId != 0 || emitter != address(0) || t0 != REACTIVE_IGNORE || t1 != REACTIVE_IGNORE
                || t2 != REACTIVE_IGNORE || t3 != REACTIVE_IGNORE,
            "MockSystem: no specific criterion"
        );
        _subs.push(Subscription(msg.sender, chainId, emitter, t0, t1, t2, t3, true));
        emit Subscribed(msg.sender, chainId, emitter, t0);
    }

    function unsubscribe(uint256 chainId, address emitter, uint256 t0, uint256 t1, uint256 t2, uint256 t3) external {
        bool removed;
        for (uint256 i; i < _subs.length; ++i) {
            Subscription storage s = _subs[i];
            if (
                s.active && s.rc == msg.sender && s.chainId == chainId && s.emitter == emitter && s.topic0 == t0
                    && s.topic1 == t1 && s.topic2 == t2 && s.topic3 == t3
            ) {
                s.active = false;
                removed = true;
            }
        }
        if (removed) emit Unsubscribed(msg.sender, chainId, emitter, t0);
        else ++unsubscribeMisses;
    }

    function requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0 memory config) external {
        _request(config);
    }

    function requestCallback(ISystemContract.CallbackVersion, bytes memory config) external {
        _request(abi.decode(config, (ISystemContract.CallbackConfiguration_V_1_0)));
    }

    function debt(address) external pure returns (uint256) {
        return 0;
    }

    function depositTo(address) external payable {}

    /// @notice Delivers one log to one reactive contract the way the network does: as the system contract, under the
    /// gas cap, catching reverts.
    function trigger(address rc, IReactive.LogRecord calldata log_) external returns (bool ok) {
        ++reactions;
        uint256 before = gasleft();
        bytes memory ret;
        (ok, ret) = rc.call{gas: REACT_GAS_CAP}(abi.encodeCall(IReactive.react, (log_)));
        uint256 used = before - gasleft();
        lastReactGas = used;
        if (used > maxReactGas) maxReactGas = used;
        if (!ok) {
            ++revertedReactions;
            emit ReactiveContractReverted(rc, ret);
        }
    }

    /// @notice Hands every queued callback request to the caller (the relay) and clears the queue.
    function takePending() external returns (Request[] memory out) {
        out = _pending;
        delete _pending;
    }

    function subscriptionCount() external view returns (uint256) {
        return _subs.length;
    }

    function subscriptionAt(uint256 i) external view returns (Subscription memory) {
        return _subs[i];
    }

    /// @notice Number of active subscriptions `rc` holds that equal the given criteria with ignored topics 1-3.
    function activeCount(address rc, uint256 chainId, address emitter, uint256 topic0) external view returns (uint256 n) {
        for (uint256 i; i < _subs.length; ++i) {
            Subscription storage s = _subs[i];
            if (
                s.active && s.rc == rc && s.chainId == chainId && s.emitter == emitter && s.topic0 == topic0
                    && s.topic1 == REACTIVE_IGNORE && s.topic2 == REACTIVE_IGNORE && s.topic3 == REACTIVE_IGNORE
            ) ++n;
        }
    }

    function activeTotal(address rc) external view returns (uint256 n) {
        for (uint256 i; i < _subs.length; ++i) {
            if (_subs[i].active && _subs[i].rc == rc) ++n;
        }
    }

    /// @notice Whether subscription `i` matches the log (equality or wildcard on every criterion).
    function matches(uint256 i, IReactive.LogRecord memory log_) public view returns (bool) {
        Subscription storage s = _subs[i];
        if (!s.active) return false;
        if (s.chainId != 0 && s.chainId != log_.chainId) return false;
        if (s.emitter != address(0) && s.emitter != log_.contractAddress) return false;
        if (s.topic0 != REACTIVE_IGNORE && s.topic0 != log_.topic0) return false;
        if (s.topic1 != REACTIVE_IGNORE && s.topic1 != log_.topic1) return false;
        if (s.topic2 != REACTIVE_IGNORE && s.topic2 != log_.topic2) return false;
        if (s.topic3 != REACTIVE_IGNORE && s.topic3 != log_.topic3) return false;
        return true;
    }

    function _request(ISystemContract.CallbackConfiguration_V_1_0 memory config) private {
        ++totalCallbackRequests;
        if (config.gasLimit < MIN_CALLBACK_GAS) {
            ++ignoredCallbacks;
            return;
        }
        _pending.push(Request(msg.sender, config.chainId, config.recipient, config.gasLimit, config.payload));
        emit CallbackRequest(config.chainId, msg.sender, config.recipient, config.payload);
    }
}
