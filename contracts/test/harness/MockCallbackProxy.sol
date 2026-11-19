// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title MockCallbackProxy
/// @notice Local stand-in for a destination chain's callback proxy. Overwrites the payload's first argument with the
/// requesting reactive contract's address and calls the recipient as `msg.sender == proxy`, which is what
/// `onlyServiceProvider` and `onlyCallbackSender` check on the real network.
/// @dev Withholds `OVERHEAD_GAS` from the requested limit to model the proxy's accounting reserve, and reports a
/// revert as a `CallbackFailure` instead of bubbling it, as the real proxy does. No fees, no debt, no latency.
contract MockCallbackProxy {
    uint256 public constant OVERHEAD_GAS = 50_000;

    uint256 public delivered;
    uint256 public failures;

    event CallbackDelivered(address indexed recipient, address indexed rvm, bool success);
    event CallbackFailure(address indexed recipient, bytes revertData);

    error NotAContract(address recipient);
    error InsufficientGas(uint64 gasLimit);
    error PayloadTooShort();

    receive() external payable {}

    function debt(address) external pure returns (uint256) {
        return 0;
    }

    function depositTo(address) external payable {}

    function deliver(address rvm, address recipient, uint64 gasLimit, bytes calldata payload) external returns (bool ok) {
        if (recipient.code.length == 0) revert NotAContract(recipient);
        if (gasLimit <= OVERHEAD_GAS) revert InsufficientGas(gasLimit);
        if (payload.length < 36) revert PayloadTooShort();
        bytes memory data = payload;
        assembly ("memory-safe") {
            // data + 32 is the selector; the first argument word starts 4 bytes later.
            mstore(add(data, 36), rvm)
        }
        bytes memory ret;
        (ok, ret) = recipient.call{gas: gasLimit - OVERHEAD_GAS}(data);
        ++delivered;
        if (!ok) {
            ++failures;
            emit CallbackFailure(recipient, ret);
        }
        emit CallbackDelivered(recipient, rvm, ok);
    }
}
