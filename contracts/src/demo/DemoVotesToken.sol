// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {Time} from "@openzeppelin/contracts/utils/types/Time.sol";

/// @title DemoVotesToken
/// @notice Testnet votes token for the demo DAO with a public, rate-limited faucet. The ERC-6372 clock is chosen at
/// deployment: block numbers (OpenZeppelin default) or timestamps, so the same governor code runs in both modes.
contract DemoVotesToken is ERC20, ERC20Permit, ERC20Votes {
    uint256 public constant FAUCET_AMOUNT = 1000 ether;
    uint256 public constant FAUCET_COOLDOWN = 1 hours;

    /// @notice True when `clock()` returns timestamps.
    bool public immutable TIMESTAMP_CLOCK;

    mapping(address account => uint256) public lastClaimAt;

    event FaucetClaimed(address indexed account, address indexed delegatee, uint256 amount);

    error FaucetCooldown(uint256 availableAt);
    error ZeroAddress();

    constructor(string memory name_, string memory symbol_, bool timestampClock_)
        ERC20(name_, symbol_)
        ERC20Permit(name_)
    {
        TIMESTAMP_CLOCK = timestampClock_;
    }

    /// @notice Mints `FAUCET_AMOUNT` to the caller once per cooldown. Self-delegates on first claim when the caller
    /// has no delegate yet, so the tokens count as votes immediately.
    function faucet() external {
        address current = delegates(msg.sender);
        _claim(current == address(0) ? msg.sender : current);
    }

    /// @notice Mints `FAUCET_AMOUNT` to the caller and delegates the caller's votes to `delegatee`.
    function faucetAndDelegate(address delegatee) external {
        if (delegatee == address(0)) revert ZeroAddress();
        _claim(delegatee);
    }

    /// @notice ERC-6372 clock: timestamps or block numbers, fixed at deployment.
    function clock() public view override returns (uint48) {
        return TIMESTAMP_CLOCK ? Time.timestamp() : Time.blockNumber();
    }

    /// @notice ERC-6372 clock: timestamps or block numbers, fixed at deployment.
    // solhint-disable-next-line func-name-mixedcase
    function CLOCK_MODE() public view override returns (string memory) {
        return TIMESTAMP_CLOCK ? "mode=timestamp" : "mode=blocknumber&from=default";
    }

    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }

    function _claim(address delegatee) private {
        uint256 last = lastClaimAt[msg.sender];
        if (last != 0 && block.timestamp < last + FAUCET_COOLDOWN) revert FaucetCooldown(last + FAUCET_COOLDOWN);
        lastClaimAt[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
        if (delegates(msg.sender) != delegatee) _delegate(msg.sender, delegatee);
        emit FaucetClaimed(msg.sender, delegatee, FAUCET_AMOUNT);
    }

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        super._update(from, to, value);
    }
}
