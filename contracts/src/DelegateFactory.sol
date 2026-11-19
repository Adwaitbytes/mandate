// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Delegate} from "./Delegate.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";

/// @title DelegateFactory
/// @notice Deploys one `Delegate` per (user, reactive contract) on this chain at a deterministic CREATE2 address, so
/// the web app can show a user their Delegate address before it exists.
contract DelegateFactory {
    /// @notice Callback proxy on this chain, baked into every Delegate.
    IPayable public immutable callbackProxy;

    mapping(address owner => mapping(address reactive => address)) public delegateOf;

    event DelegateCreated(address indexed owner, address indexed reactive, address delegate, uint256 funding);

    error ZeroAddress();
    error AlreadyCreated(address delegate);

    constructor(IPayable callbackProxy_) {
        if (address(callbackProxy_) == address(0)) revert ZeroAddress();
        callbackProxy = callbackProxy_;
    }

    /// @notice Deploys the caller's Delegate bound to `reactive`. Any value sent funds its callback fees.
    /// @param reactive The `MandateReactive` that will be allowed to request votes.
    function create(address reactive) external payable returns (address delegate) {
        if (reactive == address(0)) revert ZeroAddress();
        address existing = delegateOf[msg.sender][reactive];
        if (existing != address(0)) revert AlreadyCreated(existing);
        delegate = address(
            new Delegate{salt: _salt(msg.sender, reactive), value: msg.value}(callbackProxy, reactive, msg.sender)
        );
        delegateOf[msg.sender][reactive] = delegate;
        emit DelegateCreated(msg.sender, reactive, delegate, msg.value);
    }

    /// @notice The address `create(reactive)` deploys to for `owner`.
    function predict(address owner, address reactive) external view returns (address) {
        bytes32 initCodeHash =
            keccak256(abi.encodePacked(type(Delegate).creationCode, abi.encode(callbackProxy, reactive, owner)));
        return address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(owner, reactive), initCodeHash)))
            )
        );
    }

    function _salt(address owner, address reactive) private pure returns (bytes32) {
        return keccak256(abi.encode(owner, reactive));
    }
}
