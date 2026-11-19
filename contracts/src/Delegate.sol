// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IDelegate} from "./interfaces/IDelegate.sol";
import {IGovernorLike} from "./interfaces/IGovernorLike.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AbstractCallback} from "@reactive/src/base/AbstractCallback.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";

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

    /// @notice Lowest cast sequence number still accepted per case: raised by every processed cast request and by
    /// `cancel`, so a delayed, older request can never act after a newer one or after a veto (security review M-1).
    mapping(uint256 caseId => uint256) public minSeq;

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
        if (_precheck(caseId, seq, governor, proposalId, support)) {
            _castVote(caseId, seq, governor, proposalId, support, reason);
        }
    }

    /// @return proceed False when the request was answered without voting (re-ack, refusal or a vote found).
    function _precheck(uint256 caseId, uint256 seq, address governor, uint256 proposalId, uint8 support)
        private
        returns (bool proceed)
    {
        Receipt storage r = _receipts[caseId];
        if (r.cast) {
            emit Cast(caseId, r.governor, r.proposalId, seq, r.support, r.weight);
            return false;
        }
        if (seq < minSeq[caseId]) return _refuse(caseId, seq, Refusal.Superseded, STATE_UNAVAILABLE);
        minSeq[caseId] = seq;
        if (paused) return _refuse(caseId, seq, Refusal.Paused, STATE_UNAVAILABLE);
        if (support > MAX_SUPPORT) return _refuse(caseId, seq, Refusal.InvalidSupport, STATE_UNAVAILABLE);

        (bool stateOk, uint256 st) = _proposalState(governor, proposalId);
        if (!stateOk) return _refuse(caseId, seq, Refusal.StateUnavailable, STATE_UNAVAILABLE);
        if (st == STATE_PENDING) return _refuse(caseId, seq, Refusal.NotYetActive, STATE_PENDING);
        if (st != STATE_ACTIVE) {
            return _refuse(caseId, seq, Refusal.Ended, st > type(uint8).max ? STATE_UNAVAILABLE : uint8(st));
        }

        // A vote that landed outside this contract's bookkeeping is still a vote: acknowledge it instead of
        // reverting on a double vote. Governors without `hasVoted` (Bravo) fail this call and fall through.
        if (_alreadyVoted(governor, proposalId)) {
            _record(r, governor, proposalId, support, 0);
            emit Cast(caseId, governor, proposalId, seq, support, 0);
            return false;
        }
        return true;
    }

    function _castVote(
        uint256 caseId,
        uint256 seq,
        address governor,
        uint256 proposalId,
        uint8 support,
        string calldata reason
    ) private {
        (bool ok, bytes memory ret) =
            governor.call(abi.encodeCall(IGovernorLike.castVoteWithReason, (proposalId, support, reason)));
        if (!ok) {
            emit CastRevertData(caseId, seq, ret);
            _refuse(caseId, seq, Refusal.CastReverted, STATE_ACTIVE);
            return;
        }
        // OpenZeppelin returns the weight; Bravo returns nothing.
        uint256 weight = ret.length >= 32 ? abi.decode(ret, (uint256)) : 0;
        _record(_receipts[caseId], governor, proposalId, support, weight);
        emit Cast(caseId, governor, proposalId, seq, support, weight);
    }

    function _proposalState(address governor, uint256 proposalId) private view returns (bool ok, uint256 st) {
        bytes memory ret;
        (ok, ret) = governor.staticcall(abi.encodeCall(IGovernorLike.state, (proposalId)));
        if (!ok || ret.length < 32) return (false, 0);
        st = abi.decode(ret, (uint256));
    }

    function _alreadyVoted(address governor, uint256 proposalId) private view returns (bool) {
        (bool ok, bytes memory ret) =
            governor.staticcall(abi.encodeCall(IGovernorLike.hasVoted, (proposalId, address(this))));
        return ok && ret.length >= 32 && abi.decode(ret, (uint256)) != 0;
    }

    /// @inheritdoc IDelegate
    /// @dev Idempotent. If the vote already landed, the `Cast` acknowledgement is re-emitted so the reactive
    /// contract records the truth.
    function cancel(address rvm, uint256 caseId, uint256 seq) external onlyServiceProvider onlyCallbackSender(rvm) {
        if (seq > minSeq[caseId]) minSeq[caseId] = seq;
        emit Cancelled(caseId, seq);
        Receipt storage r = _receipts[caseId];
        if (r.cast) emit Cast(caseId, r.governor, r.proposalId, seq, r.support, r.weight);
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

    function _record(Receipt storage r, address governor, uint256 proposalId, uint8 support, uint256 weight) private {
        r.cast = true;
        r.support = support;
        r.castAt = uint64(block.timestamp);
        r.governor = governor;
        r.proposalId = proposalId;
        r.weight = weight;
    }

    /// @return Always false, so a refusal reads as `return _refuse(...)` in `_precheck`.
    function _refuse(uint256 caseId, uint256 seq, Refusal reason, uint8 proposalState) private returns (bool) {
        emit NotActive(caseId, seq, uint8(reason), proposalState);
        return false;
    }
}
