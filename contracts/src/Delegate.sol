// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {AbstractCallback} from "@reactive/src/base/AbstractCallback.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {IDelegate} from "./interfaces/IDelegate.sol";
import {IGovernorLike} from "./interfaces/IGovernorLike.sol";

/// @title Delegate
/// @notice Holds one user's delegated voting power on one chain and casts votes when `MandateReactive` asks for
/// them through the callback proxy. The user delegates their tokens to this contract from their own wallet; the
/// Delegate never needs custody. Every cast request ends in exactly one acknowledgement event: `Cast` or
/// `NotActive`.
/// @dev Clock handling: `voteStart`/`voteEnd` are in the governor's ERC-6372 clock (block numbers or timestamps).
/// The Delegate never compares them with anything. It asks the governor for `state(proposalId)`, which uses the
/// governor's own clock, and reports Pending as NotYetActive and every post-Active state as Ended. This is what lets
/// one contract serve block-number and timestamp governors.
contract Delegate is IDelegate, AbstractCallback {
    using SafeERC20 for IERC20;

    uint8 private constant STATE_PENDING = 0;
    uint8 private constant STATE_ACTIVE = 1;
    uint8 private constant STATE_UNAVAILABLE = type(uint8).max;
    uint8 private constant MAX_SUPPORT = 2;

    struct Receipt {
        bool cast;
        uint8 support;
        uint64 castAt;
        address governor;
        uint256 proposalId;
        uint256 weight;
    }

    error NotOwner(address caller);
    error ZeroAddress();

    event Paused(bool paused);
    event Withdrawn(address indexed to, uint256 amount);
    event TokenWithdrawn(address indexed token, address indexed to, uint256 amount);
    event HeldVotesDelegated(address indexed token, address indexed delegatee);
    /// @notice Diagnostic companion to `NotActive(..., CastReverted, ...)` carrying the governor's revert data.
    event CastRevertData(uint256 indexed caseId, uint256 seq, bytes revertData);

    /// @notice The user this Delegate votes for.
    address public immutable owner;

    /// @notice When true every cast request is refused with `Refusal.Paused`.
    bool public paused;

    mapping(uint256 caseId => Receipt) private _receipts;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    /// @param callbackProxy_ Callback proxy on this chain.
    /// @param reactive_ `MandateReactive` address (the only accepted callback sender).
    /// @param owner_ The user.
    constructor(IPayable callbackProxy_, address reactive_, address owner_)
        payable
        AbstractCallback(callbackProxy_, reactive_)
    {
        if (address(callbackProxy_) == address(0) || reactive_ == address(0) || owner_ == address(0)) {
            revert ZeroAddress();
        }
        owner = owner_;
    }

    /// @inheritdoc IDelegate
    /// @dev Never reverts for the authorised sender: every outcome is an event, so the reactive contract always gets
    /// an acknowledgement and a failed vote never turns into a silent, billed `CallbackFailure`.
    function cast(
        address rvm,
        uint256 caseId,
        uint256 seq,
        address governor,
        uint256 proposalId,
        uint8 support,
        string calldata reason
    ) external onlyServiceProvider onlyCallbackSender(rvm) {
        Receipt storage r = _receipts[caseId];
        if (r.cast) {
            emit Cast(caseId, r.governor, r.proposalId, seq, r.support, r.weight);
            return;
        }
        if (paused) { _refuse(caseId, seq, Refusal.Paused, STATE_UNAVAILABLE); return; }
        if (support > MAX_SUPPORT) { _refuse(caseId, seq, Refusal.InvalidSupport, STATE_UNAVAILABLE); return; }

        uint8 st;
        try IGovernorLike(governor).state(proposalId) returns (uint8 s) {
            st = s;
        } catch {
            { _refuse(caseId, seq, Refusal.StateUnavailable, STATE_UNAVAILABLE); return; }
        }
        if (st == STATE_PENDING) { _refuse(caseId, seq, Refusal.NotYetActive, st); return; }
        if (st != STATE_ACTIVE) { _refuse(caseId, seq, Refusal.Ended, st); return; }

        // A vote that landed outside this contract's bookkeeping (for example a lost receipt on an older
        // deployment) is still a vote: acknowledge it instead of reverting on a double vote.
        try IGovernorLike(governor).hasVoted(proposalId, address(this)) returns (bool voted) {
            if (voted) {
                _record(r, governor, proposalId, support, 0);
                emit Cast(caseId, governor, proposalId, seq, support, 0);
                return;
            }
        } catch {}

        try IGovernorLike(governor).castVoteWithReason(proposalId, support, reason) returns (uint256 weight) {
            _record(r, governor, proposalId, support, weight);
            emit Cast(caseId, governor, proposalId, seq, support, weight);
        } catch (bytes memory revertData) {
            emit CastRevertData(caseId, seq, revertData);
            _refuse(caseId, seq, Refusal.CastReverted, st);
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Owner

    /// @notice Stops (or resumes) all voting through this Delegate. Revoking the token delegation itself is done
    /// from the token holder's wallet with `token.delegate(...)`.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit Paused(paused_);
    }

    /// @notice Withdraws native balance (callback funding) to `to`.
    /// @dev `amount` comes first so no owner function has the `address`-first shape of a callback entry point.
    function withdraw(uint256 amount, address payable to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        emit Withdrawn(to, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Points the votes of tokens held by this contract (if any were sent here) at `delegatee`. Passing the
    /// owner undelegates them from this contract.
    function delegateHeldVotes(IVotes token, address delegatee) external onlyOwner {
        token.delegate(delegatee);
        emit HeldVotesDelegated(address(token), delegatee);
    }

    /// @notice Withdraws ERC-20 tokens held by this contract.
    function withdrawToken(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        emit TokenWithdrawn(address(token), to, amount);
        token.safeTransfer(to, amount);
    }

    /// @notice Settles any debt to the callback proxy from this contract's balance. Open to anyone.
    function coverDebt() external {
        _coverDebt();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Views

    /// @notice The vote receipt for a case (`cast` is false if no vote went out).
    function receiptOf(uint256 caseId) external view returns (Receipt memory) {
        return _receipts[caseId];
    }

    function _record(Receipt storage r, address governor, uint256 proposalId, uint8 support, uint256 weight)
        private
    {
        r.cast = true;
        r.support = support;
        r.castAt = uint64(block.timestamp);
        r.governor = governor;
        r.proposalId = proposalId;
        r.weight = weight;
    }

    function _refuse(uint256 caseId, uint256 seq, Refusal reason, uint8 proposalState) private {
        emit NotActive(caseId, seq, uint8(reason), proposalState);
    }
}
