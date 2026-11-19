// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IDelegate} from "./interfaces/IDelegate.sol";
import {IDocket} from "./interfaces/IDocket.sol";
import {MandateLogic} from "./libraries/MandateLogic.sol";
import {ProposalCreatedHead} from "./libraries/ProposalCreatedHead.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {AbstractReactive} from "@reactive/src/base/AbstractReactive.sol";
import {IReactive} from "@reactive/src/interfaces/IReactive.sol";
import {ISystemContract} from "@reactive/src/interfaces/ISystemContract.sol";

/// @title MandateReactive
/// @notice The trigger, tally, timer and executor for one mandate. Deployed on the Reactive Network.
///
/// Loop:
///   1. `ProposalCreated` on a watched governor -> case created here -> `Docket.openCase` callback (hearing chain).
///   2. Docket `CaseOpened` acknowledges the case. Jurors post `Verdict`s on the Docket; each one arrives here.
///   3. Injection flags at or above the case's threshold hold the case for good. Otherwise, once `quorum` verdicts
///      are in, a side wins only with `minAgreeing` confident ballots and a weight share above `majorityBps`. A split
///      follows `splitPolicy` (abstain, or hold for the owner).
///   4. A decision opens a veto window; a changed decision opens a fresh one. When it closes (cron tick) the
///      contract requests `Delegate.cast` on the governor's chain.
///   5. The Delegate answers `Cast` (done) or `NotActive` (retry, give up, or fail).
///   6. Docket `Vetoed` / `Overridden`, or an injection hold, stop the vote at any point before it lands: a cast in
///      flight is followed by `Delegate.cancel`, which the Delegate acknowledges with `Cancelled`. Owner actions move
///      juror weight toward the jurors that agreed with the owner, within bounds.
///
/// Delivery is treated as at-least-once and possibly out of order: every callback carries a per-case sequence
/// number, destination functions are idempotent and refuse requests older than one already processed, every request
/// has an acknowledgement event subscribed here, and a missing acknowledgement triggers a resend on a later cron
/// tick. Cron is subscribed only while at least one case has timed work.
///
/// Configuration is snapshotted per case when it opens, so changing it never affects a case in flight.
///
/// Clocks: governor `voteStart`/`voteEnd` are in the governor's ERC-6372 clock (blocks or seconds), not this chain's.
/// The Delegate is the authority on whether voting is open (it asks `state()`). This contract only uses the bounds to
/// avoid wasted callbacks when the operator declared the governor's clock. Every other timer uses
/// `block.timestamp` on the Reactive Network.
contract MandateReactive is AbstractReactive, Ownable2Step {
    // ---------------------------------------------------------------------------------------------------------------
    // Constants

    /// @notice topic0 of `ProposalCreated(uint256,address,address[],uint256[],string[],bytes[],uint256,uint256,string)`,
    /// shared by OpenZeppelin Governor and Compound Governor Bravo.
    uint256 public constant PROPOSAL_CREATED_TOPIC = 0x7d84a6263ae0d98d3329bd7b46bb4e8d6f98cd35a7adb45c274c8b7fd5ebd5e0;
    /// @dev Event topics are spelled out as signature hashes because `Event.selector` is not a compile-time constant;
    /// test/unit/Topics.t.sol pins each one to the interface's selector.
    uint256 public constant CASE_OPENED_TOPIC = uint256(
        keccak256("CaseOpened(uint256,uint256,address,uint256,uint256,uint256,bytes32,address,uint256,bytes32)")
    );
    uint256 public constant VERDICT_TOPIC =
        uint256(keccak256("Verdict(uint256,address,uint8,uint16,bool,bytes32,bytes32,bytes32)"));
    uint256 public constant VETOED_TOPIC = uint256(keccak256("Vetoed(uint256)"));
    uint256 public constant OVERRIDDEN_TOPIC = uint256(keccak256("Overridden(uint256,uint8)"));
    uint256 public constant CAST_TOPIC = uint256(keccak256("Cast(uint256,address,uint256,uint256,uint8,uint256)"));
    uint256 public constant NOT_ACTIVE_TOPIC = uint256(keccak256("NotActive(uint256,uint256,uint8,uint8)"));
    uint256 public constant CANCELLED_TOPIC = uint256(keccak256("Cancelled(uint256,uint256)"));

    /// @notice Legacy system address that emits Cron events on the Reactive Network.
    address public constant CRON_EMITTER = 0x0000000000000000000000000000000000fffFfF;
    uint256 public constant CRON1_TOPIC = 0xf02d6ea5c22a71cffe930a4523fcb4f129be6c804db50e4202fb4e0b07ccb514;
    uint256 public constant CRON10_TOPIC = 0x04463f7c1651e6b9774d7f85c85bb94654e3c46ca79b0c16fb16d4183307b687;
    uint256 public constant CRON100_TOPIC = 0xb49937fb8970e19fd46d48f7e3fb00d659deac0347f79cd7cb542f0fc1503c70;
    uint256 public constant CRON1000_TOPIC = 0xe20b31294d84c3661ddc8f423abb9c70310d0cf172aa2714ead78029b325e3f4;
    uint256 public constant CRON10000_TOPIC = 0xd214e1d84db704ed42d37f538ea9bf71e44ba28bc1cc088b2f5deca654677a56;

    /// @notice Non-terminal cases allowed at once. Bounds storage growth and the timed set.
    uint256 public constant MAX_ACTIVE_CASES = 128;
    /// @notice Timed cases examined per cron tick (rotating cursor), keeping a tick well under the 900k gas cap.
    uint256 public constant SCAN_PER_TICK = 24;
    /// @notice Callbacks requested per cron tick at most; the rest wait for the next tick.
    uint256 public constant MAX_CALLBACKS_PER_TICK = 4;
    /// @notice Stale cases closed per reaction by the oldest-first sweep.
    uint256 public constant SWEEP_PER_REACTION = 4;
    /// @notice Ballots tracked per case (matches `Docket.MAX_JURORS`).
    uint256 public constant MAX_BALLOTS_PER_CASE = MandateLogic.MAX_BALLOTS_PER_CASE;
    /// @notice Reactive Network ignores callback requests below 100k gas.
    uint64 public constant MIN_CALLBACK_GAS = MandateLogic.MIN_CALLBACK_GAS;
    uint64 public constant MAX_CALLBACK_GAS = MandateLogic.MAX_CALLBACK_GAS;
    uint32 public constant MAX_WEIGHT = MandateLogic.MAX_WEIGHT;
    /// @notice Configuration floors: no operator setting lets fewer than two jurors, or one juror, decide a vote.
    uint8 public constant MIN_QUORUM = MandateLogic.MIN_QUORUM;
    uint8 public constant MIN_AGREEING = MandateLogic.MIN_AGREEING;
    uint16 public constant MIN_CONFIDENCE_FLOOR_BPS = MandateLogic.MIN_CONFIDENCE_FLOOR_BPS;
    /// @notice Balance `withdraw` always leaves behind for fees.
    uint256 public constant WITHDRAW_FLOOR = 0.5 ether;
    uint16 internal constant BPS = 10_000;
    uint8 internal constant ABSTAIN = 2;

    // ---------------------------------------------------------------------------------------------------------------
    // Types

    enum ClockMode {
        Unknown,
        BlockNumber,
        Timestamp
    }

    /// @dev Terminal: Cast, Vetoed, Expired, Failed.
    enum Status {
        None,
        Opening, // openCase requested, waiting for CaseOpened (timed: resend)
        Open, // collecting verdicts
        Held, // injection hold (sticky) or split under the Hold policy (re-evaluated on new verdicts)
        Window, // decided, veto window running (timed)
        Waiting, // window over, voting not open yet (timed: retry)
        Casting, // cast requested, waiting for Cast/NotActive (timed: resend)
        Cast,
        Vetoed,
        Expired,
        Failed
    }

    enum HoldReason {
        None,
        Injection,
        Split
    }

    enum SplitPolicy {
        Abstain,
        Hold
    }

    enum SkipReason {
        Malformed,
        Duplicate,
        NoDelegate,
        NoDocket,
        Capacity,
        GovernorCapacity,
        RateLimited
    }

    struct Config {
        uint8 quorum; // distinct verdicts needed before tallying (>= 2)
        uint8 minAgreeing; // confident ballots a side needs to win (>= 2, <= quorum)
        uint8 injectionFlagsToHold; // distinct injection flags that hold the case (>= 1, <= quorum)
        uint16 minConfidenceBps; // below this a ballot counts toward quorum and the denominator only (>= 5000)
        uint16 majorityBps; // a side needs a weight share strictly above this (5000 = simple majority)
        SplitPolicy splitPolicy;
        uint8 maxAttempts; // sends of one request without an acknowledgement before giving up
        uint32 vetoWindow; // seconds, >= MIN_VETO_WINDOW
        uint32 resendAfter; // seconds without an acknowledgement before resending
        uint32 retryAfter; // seconds between NotYetActive retries
        uint32 caseTtl; // seconds from creation after which any non-terminal case may be expired
        uint64 openCaseGas;
        uint64 castGas;
    }

    struct WeightBounds {
        uint32 min;
        uint32 initial;
        uint32 max;
        uint32 step;
    }

    struct Watch {
        bool active;
        ClockMode clock;
        uint32 blockTimeMs; // declared average block time for BlockNumber governors, 0 if unknown
        uint16 maxActive; // non-terminal cases from this governor at once, 0 = only the global cap
        uint16 maxPerHour; // cases created from this governor per rolling hour, 0 = unlimited
        uint16 activeCount;
        uint16 hourCount;
        uint64 hourStart;
    }

    struct Case {
        Status status;
        HoldReason hold;
        ClockMode clock;
        uint8 support;
        bool hasDecision;
        bool ownerActed;
        bool overridden;
        bool castRequested; // a cast request has gone out at least once
        bool cancelPending; // a cancel is in flight and unacknowledged (keeps the case timed)
        uint8 attempts;
        uint8 cancelAttempts;
        uint8 injectionFlags;
        uint32 seq;
        uint32 cancelSeq;
        uint32 mandateVersion;
        uint32 blockTimeMs;
        uint64 originChainId;
        uint64 createdAt;
        uint64 dueAt;
        uint64 cancelDueAt;
        uint64 voteStart;
        uint64 voteEnd;
        address governor;
        address delegate;
        uint256 proposalId;
        uint256 originBlock;
        uint256 originTxHash;
        address[] jurors;
    }

    struct Ballot {
        bool posted;
        uint8 support;
        uint16 confidenceBps;
        bool injection;
        bytes32 rationaleHash;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Errors

    error InvalidCronTopic(uint256 topic);
    error DocketAlreadySet();
    error ZeroAddress();
    error InvalidConfig();
    error InvalidWeightBounds();
    error UnknownCase(uint256 caseId);
    error CaseFinished(uint256 caseId);
    error DelegateInUse(uint256 chainId, uint256 caseId);
    error ReserveFloor(uint256 balanceAfter, uint256 floor);
    error RenounceDisabled();

    // ---------------------------------------------------------------------------------------------------------------
    // Events

    event DocketSet(uint256 indexed chainId, address indexed docket);
    event GovernorWatched(uint256 indexed chainId, address indexed governor, ClockMode clock, uint32 blockTimeMs);
    event GovernorLimitsSet(uint256 indexed chainId, address indexed governor, uint16 maxActive, uint16 maxPerHour);
    event GovernorUnwatched(uint256 indexed chainId, address indexed governor);
    event DelegateSet(uint256 indexed chainId, address indexed delegate);
    event ConfigUpdated(Config config);
    event WeightBoundsUpdated(WeightBounds bounds);
    event ProposalSkipped(uint256 indexed chainId, address indexed governor, uint256 proposalId, SkipReason reason);
    event CaseCreated(
        uint256 indexed caseId,
        uint256 indexed originChainId,
        address indexed governor,
        uint256 proposalId,
        uint64 voteStart,
        uint64 voteEnd,
        uint256 originTxHash
    );
    event CaseStatusChanged(uint256 indexed caseId, Status status);
    event OpenCaseRequested(uint256 indexed caseId, uint32 seq, uint8 attempt);
    event BallotRecorded(
        uint256 indexed caseId,
        address indexed juror,
        uint8 support,
        uint16 confidenceBps,
        bool injection,
        uint32 weight
    );
    event TallyUpdated(
        uint256 indexed caseId,
        uint256 againstWeight,
        uint256 forWeight,
        uint256 abstainWeight,
        uint256 lowConfidenceWeight,
        uint256 ballots
    );
    event CaseHeld(uint256 indexed caseId, HoldReason reason);
    event WindowStarted(uint256 indexed caseId, uint8 support, uint64 endsAt);
    event DecisionChanged(uint256 indexed caseId, uint8 support);
    event CastDeferred(uint256 indexed caseId, uint64 until);
    event CastRequested(uint256 indexed caseId, uint32 seq, uint8 support, uint8 attempt);
    event CastAcknowledged(uint256 indexed caseId, uint256 seq, uint8 support, uint256 weight);
    event CastRefused(uint256 indexed caseId, uint256 seq, uint8 reason);
    event CancelRequested(uint256 indexed caseId, uint32 seq, uint8 attempt);
    event CancelAcknowledged(uint256 indexed caseId, uint256 seq);
    event CancelAbandoned(uint256 indexed caseId, uint32 seq);
    event OwnerActionTooLate(uint256 indexed caseId, bool veto);
    event WeightsUpdated(uint256 indexed caseId, address[] jurors, uint32[] weights);
    event CronToggled(bool active);

    // ---------------------------------------------------------------------------------------------------------------
    // State

    /// @notice Cron topic used for timed work (one of the five protocol intervals).
    uint256 public immutable cronTopic;
    /// @notice Shortest veto window the operator may configure, fixed at deployment (security review M-5).
    uint32 public immutable MIN_VETO_WINDOW;

    uint256 public docketChainId;
    address public docket;
    mapping(uint256 chainId => address) public delegateOf;

    /// @notice Cases created so far; ids start at 1.
    uint256 public caseCount;
    /// @notice Cases not yet in a terminal status.
    uint256 public activeCases;
    bool public cronActive;

    Config private _config;
    WeightBounds private _bounds;

    mapping(bytes32 key => Watch) private _watches;
    mapping(uint256 caseId => Case) private _cases;
    mapping(uint256 caseId => Config) private _caseConfig;
    mapping(bytes32 key => uint256 caseId) private _caseIdByKey;
    mapping(uint256 caseId => mapping(address juror => Ballot)) private _ballots;
    mapping(address juror => uint32) private _rawWeight;

    uint256[] private _timed;
    mapping(uint256 caseId => uint256 indexPlusOne) private _timedIndex;
    uint256 private _cursor;
    uint256 private _sweepCursor = 1;

    /// @param owner_ Operator on the Reactive Network: wiring, configuration and cleanup. Holds no vote power.
    /// @param cronTopic_ One of the five Cron topics; the tick interval for timed work.
    /// @param minVetoWindow_ Floor for `vetoWindow`, in seconds. Deploy with at least 300 on a live network.
    constructor(address owner_, uint256 cronTopic_, uint32 minVetoWindow_) payable Ownable(owner_) {
        if (
            cronTopic_ != CRON1_TOPIC && cronTopic_ != CRON10_TOPIC && cronTopic_ != CRON100_TOPIC
                && cronTopic_ != CRON1000_TOPIC && cronTopic_ != CRON10000_TOPIC
        ) revert InvalidCronTopic(cronTopic_);
        cronTopic = cronTopic_;
        MIN_VETO_WINDOW = minVetoWindow_;
        _config = Config({
            quorum: 2,
            minAgreeing: 2,
            injectionFlagsToHold: 1,
            minConfidenceBps: 6000,
            majorityBps: 5000,
            splitPolicy: SplitPolicy.Hold,
            maxAttempts: 3,
            vetoWindow: minVetoWindow_ > 10 minutes ? minVetoWindow_ : 10 minutes,
            resendAfter: 3 minutes,
            retryAfter: 1 minutes,
            caseTtl: 14 days,
            openCaseGas: 500_000,
            castGas: 600_000
        });
        _bounds = WeightBounds({min: 25, initial: 100, max: 400, step: 25});
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Reactive entry point

    /// @inheritdoc IReactive
    /// @dev Never reverts to filter: anything unexpected returns early. Routes on topic0, then checks the emitter.
    function react(LogRecord calldata log_) external onlySystem {
        uint256 topic0 = log_.topic0;
        if (topic0 == PROPOSAL_CREATED_TOPIC) {
            _onProposalCreated(log_);
        } else if (topic0 == cronTopic) {
            if (log_.chainId == block.chainid && log_.contractAddress == CRON_EMITTER) _onTick();
        } else if (log_.contractAddress == docket && log_.chainId == docketChainId && docket != address(0)) {
            if (topic0 == VERDICT_TOPIC) _onVerdict(log_);
            else if (topic0 == CASE_OPENED_TOPIC) _onCaseOpened(log_);
            else if (topic0 == VETOED_TOPIC) _onVeto(log_);
            else if (topic0 == OVERRIDDEN_TOPIC) _onOverride(log_);
        } else if (topic0 == CAST_TOPIC) {
            _onCastAck(log_);
        } else if (topic0 == NOT_ACTIVE_TOPIC) {
            _onNotActive(log_);
        } else if (topic0 == CANCELLED_TOPIC) {
            _onCancelled(log_);
        }
        _syncCron();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Owner wiring and configuration (transactions on the Reactive Network)

    /// @notice Sets the Docket once and subscribes to its four events.
    function setDocket(uint256 chainId, address docket_) external onlyOwner {
        if (docket != address(0)) revert DocketAlreadySet();
        if (docket_ == address(0) || chainId == 0) revert ZeroAddress();
        docketChainId = chainId;
        docket = docket_;
        _sub(chainId, docket_, CASE_OPENED_TOPIC, true);
        _sub(chainId, docket_, VERDICT_TOPIC, true);
        _sub(chainId, docket_, VETOED_TOPIC, true);
        _sub(chainId, docket_, OVERRIDDEN_TOPIC, true);
        emit DocketSet(chainId, docket_);
    }

    /// @notice Watches (or re-configures) a governor and subscribes to its `ProposalCreated`.
    /// @param clock The governor's ERC-6372 clock, if known. Used only to save callbacks; the Delegate decides.
    /// @param blockTimeMs Average block time for a BlockNumber governor, 0 if unknown.
    function watchGovernor(uint256 chainId, address governor, ClockMode clock, uint32 blockTimeMs) external onlyOwner {
        if (governor == address(0) || chainId == 0) revert ZeroAddress();
        Watch storage w = _watches[_key(chainId, governor)];
        if (!w.active) {
            w.active = true;
            _sub(chainId, governor, PROPOSAL_CREATED_TOPIC, true);
        }
        w.clock = clock;
        w.blockTimeMs = blockTimeMs;
        emit GovernorWatched(chainId, governor, clock, blockTimeMs);
    }

    /// @notice Per-governor caps so one permissionless governor cannot starve the others or drain funds
    /// (security review M-2, M-6). 0 disables a limit.
    function setGovernorLimits(uint256 chainId, address governor, uint16 maxActive, uint16 maxPerHour)
        external
        onlyOwner
    {
        Watch storage w = _watches[_key(chainId, governor)];
        w.maxActive = maxActive;
        w.maxPerHour = maxPerHour;
        emit GovernorLimitsSet(chainId, governor, maxActive, maxPerHour);
    }

    /// @notice Stops watching a governor. Cases already open continue; per-governor counters are kept.
    function unwatchGovernor(uint256 chainId, address governor) external onlyOwner {
        Watch storage w = _watches[_key(chainId, governor)];
        if (!w.active) return;
        w.active = false;
        _sub(chainId, governor, PROPOSAL_CREATED_TOPIC, false);
        emit GovernorUnwatched(chainId, governor);
    }

    /// @notice Sets the Delegate that votes on `chainId` and subscribes to its acknowledgements.
    /// @dev Refused while any case on that chain has timed work, since its acknowledgements would be lost
    /// (security review L-7).
    function setDelegate(uint256 chainId, address delegate_) external onlyOwner {
        if (chainId == 0) revert ZeroAddress();
        address previous = delegateOf[chainId];
        if (previous == delegate_) return;
        uint256 n = _timed.length;
        for (uint256 i; i < n; ++i) {
            if (_cases[_timed[i]].originChainId == chainId) revert DelegateInUse(chainId, _timed[i]);
        }
        if (previous != address(0)) _subDelegate(chainId, previous, false);
        delegateOf[chainId] = delegate_;
        if (delegate_ != address(0)) _subDelegate(chainId, delegate_, true);
        emit DelegateSet(chainId, delegate_);
    }

    /// @notice Replaces the configuration for cases opened from now on. Cases already open keep their snapshot.
    /// Floors are checked in `MandateLogic.applyConfig`.
    function setConfig(Config calldata config_) external onlyOwner {
        MandateLogic.applyConfig(_config, config_, MIN_VETO_WINDOW);
    }

    /// @notice Replaces the juror weight bounds. Stored weights are clamped into the new bounds when read.
    function setWeightBounds(WeightBounds calldata bounds_) external onlyOwner {
        MandateLogic.applyWeightBounds(_bounds, bounds_);
    }

    /// @notice Closes a non-terminal case as Expired (cleanup before its TTL).
    function closeCase(uint256 caseId) external onlyOwner {
        Status s = _cases[caseId].status;
        if (s == Status.None) revert UnknownCase(caseId);
        if (_isTerminal(s)) revert CaseFinished(caseId);
        _finish(caseId, Status.Expired);
        _syncCron();
    }

    /// @notice Expires the given cases if they are past their TTL (or past `voteEnd` on a timestamp governor).
    /// Open to anyone, so a full contract can always be freed without the operator (security review M-2).
    function expireStale(uint256[] calldata caseIds) external {
        for (uint256 i; i < caseIds.length; ++i) {
            Case storage c = _cases[caseIds[i]];
            if (c.status != Status.None && !_isTerminal(c.status) && _isStale(caseIds[i], c)) {
                _finish(caseIds[i], Status.Expired);
            }
        }
        _syncCron();
    }

    /// @notice Settles any debt to the system contract from this contract's balance. Open to anyone so a third party
    /// can revive the contract.
    function coverDebt() external {
        _coverDebt();
    }

    /// @notice Withdraws native balance, always leaving `WITHDRAW_FLOOR` for fees.
    function withdraw(uint256 amount, address payable to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = address(this).balance;
        if (amount > balance || balance - amount < WITHDRAW_FLOOR) {
            revert ReserveFloor(amount > balance ? 0 : balance - amount, WITHDRAW_FLOOR);
        }
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Disabled: an ownerless contract could never be reconfigured or cleaned up.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Views

    function config() external view returns (Config memory) {
        return _config;
    }

    /// @notice The configuration snapshot a case runs under.
    function caseConfig(uint256 caseId) external view returns (Config memory) {
        return _caseConfig[caseId];
    }

    function weightBounds() external view returns (WeightBounds memory) {
        return _bounds;
    }

    function getCase(uint256 caseId) external view returns (Case memory) {
        return _cases[caseId];
    }

    function ballotOf(uint256 caseId, address juror) external view returns (Ballot memory) {
        return _ballots[caseId][juror];
    }

    function caseIdOf(uint256 chainId, address governor, uint256 proposalId) external view returns (uint256) {
        return _caseIdByKey[_caseKey(chainId, governor, proposalId)];
    }

    function watchOf(uint256 chainId, address governor) external view returns (Watch memory) {
        return _watches[_key(chainId, governor)];
    }

    /// @notice Current weight of a juror (initial weight if it never took part in a veto or override).
    function weightOf(address juror) public view returns (uint32) {
        return _weightOf(juror, _bounds);
    }

    /// @notice Case ids with timed work (the reason cron is on).
    function timedCases() external view returns (uint256[] memory) {
        return _timed;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Handlers

    function _onProposalCreated(LogRecord calldata log_) private {
        if (log_.opCode != 1) return;
        Watch storage w = _watches[_key(log_.chainId, log_.contractAddress)];
        if (!w.active) return;

        (bool ok, uint256 proposalId,, uint64 voteStart, uint64 voteEnd) = ProposalCreatedHead.read(log_.data);
        if (!ok) {
            emit ProposalSkipped(log_.chainId, log_.contractAddress, 0, SkipReason.Malformed);
            return;
        }

        _sweep();
        bytes32 caseKey = _caseKey(log_.chainId, log_.contractAddress, proposalId);
        (bool skip, SkipReason reason) = _admission(caseKey, log_.chainId, w);
        if (skip) {
            emit ProposalSkipped(log_.chainId, log_.contractAddress, proposalId, reason);
            return;
        }

        uint256 caseId = ++caseCount;
        _caseIdByKey[caseKey] = caseId;
        ++activeCases;
        ++w.activeCount;
        ++w.hourCount;
        _caseConfig[caseId] = _config;
        _initCase(caseId, log_, w);
        Case storage c = _cases[caseId];
        c.proposalId = proposalId;
        c.voteStart = voteStart;
        c.voteEnd = voteEnd;
        _announce(caseId);
        _addTimed(caseId);
        _requestOpen(caseId);
    }

    function _admission(bytes32 caseKey, uint256 chainId, Watch storage w)
        private
        returns (bool skip, SkipReason reason)
    {
        if (block.timestamp >= uint256(w.hourStart) + 1 hours) {
            w.hourStart = uint64(block.timestamp);
            w.hourCount = 0;
        }
        skip = true;
        if (_caseIdByKey[caseKey] != 0) reason = SkipReason.Duplicate;
        else if (docket == address(0)) reason = SkipReason.NoDocket;
        else if (delegateOf[chainId] == address(0)) reason = SkipReason.NoDelegate;
        else if (activeCases >= MAX_ACTIVE_CASES) reason = SkipReason.Capacity;
        else if (w.maxActive != 0 && w.activeCount >= w.maxActive) reason = SkipReason.GovernorCapacity;
        else if (w.maxPerHour != 0 && w.hourCount >= w.maxPerHour) reason = SkipReason.RateLimited;
        else skip = false;
    }

    function _announce(uint256 caseId) private {
        Case storage c = _cases[caseId];
        emit CaseCreated(caseId, c.originChainId, c.governor, c.proposalId, c.voteStart, c.voteEnd, c.originTxHash);
        emit CaseStatusChanged(caseId, Status.Opening);
    }

    function _initCase(uint256 caseId, LogRecord calldata log_, Watch storage w) private {
        Case storage c = _cases[caseId];
        c.status = Status.Opening;
        c.clock = w.clock;
        c.blockTimeMs = w.blockTimeMs;
        c.originChainId = uint64(log_.chainId);
        c.createdAt = uint64(block.timestamp);
        c.governor = log_.contractAddress;
        c.delegate = delegateOf[log_.chainId];
        c.originBlock = log_.blockNumber;
        c.originTxHash = log_.txHash;
    }

    function _onCaseOpened(LogRecord calldata log_) private {
        if (log_.opCode != 2 || log_.data.length < 9 * 32) return;
        uint256 caseId = log_.topic1;
        Case storage c = _cases[caseId];
        if (c.status == Status.None) return;
        if (c.mandateVersion == 0) c.mandateVersion = uint32(_word(log_.data, 7));
        if (c.status == Status.Opening) _markOpened(caseId, c);
    }

    function _onVerdict(LogRecord calldata log_) private {
        if (log_.opCode != 3 || log_.data.length < 6 * 32) return;
        uint256 caseId = log_.topic1;
        Case storage c = _cases[caseId];
        if (c.status == Status.None) return;
        address juror = address(uint160(log_.topic2));
        uint256 support = _word(log_.data, 0);
        uint256 confidence = _word(log_.data, 1);
        if (support > ABSTAIN || confidence > BPS) return;
        Ballot storage b = _ballots[caseId][juror];
        if (b.posted || c.jurors.length >= MAX_BALLOTS_PER_CASE) return;

        bool injection = _word(log_.data, 2) != 0;
        b.posted = true;
        b.support = uint8(support);
        b.confidenceBps = uint16(confidence);
        b.injection = injection;
        b.rationaleHash = bytes32(_word(log_.data, 3));
        c.jurors.push(juror);
        if (injection) ++c.injectionFlags;
        emit BallotRecorded(caseId, juror, uint8(support), uint16(confidence), injection, weightOf(juror));

        // A verdict can only exist for a case the Docket opened, so it doubles as the open acknowledgement when the
        // CaseOpened log arrives later than the verdict.
        if (c.status == Status.Opening) _markOpened(caseId, c);

        Status s = c.status;
        if (_isTerminal(s)) return;
        if (_injectionHeld(caseId, c)) {
            // Stops the vote at any point before it lands, including a cast already in flight (review H-1).
            _holdForInjection(caseId, c);
        } else if (s == Status.Open || s == Status.Held || s == Status.Window) {
            _evaluate(caseId, c);
        }
        // Waiting and Casting keep the ballot for weight learning only: the decision is locked once a cast went out.
    }

    function _onVeto(LogRecord calldata log_) private {
        if (log_.opCode != 2) return;
        uint256 caseId = log_.topic1;
        Case storage c = _cases[caseId];
        if (c.status == Status.None || c.ownerActed) return;
        c.ownerActed = true;
        if (c.hasDecision) _learn(caseId, c, c.support, false);
        if (_isTerminal(c.status)) {
            emit OwnerActionTooLate(caseId, true);
            return;
        }
        // Casting is not terminal: a request in flight may still be refused or never arrive (review H-1).
        if (c.castRequested) _requestCancel(caseId, c);
        _finish(caseId, Status.Vetoed);
    }

    function _onOverride(LogRecord calldata log_) private {
        if (log_.opCode != 2 || log_.data.length < 32) return;
        uint256 caseId = log_.topic1;
        Case storage c = _cases[caseId];
        uint256 support = _word(log_.data, 0);
        if (c.status == Status.None || c.ownerActed || support > ABSTAIN) return;
        c.ownerActed = true;
        _learn(caseId, c, uint8(support), true);
        Status s = c.status;
        if (s == Status.Cast) {
            if (c.support != support) emit OwnerActionTooLate(caseId, false);
            return;
        }
        if (_isTerminal(s)) {
            emit OwnerActionTooLate(caseId, false);
            return;
        }
        bool sameInFlight = s == Status.Casting && c.support == support;
        c.overridden = true;
        if (sameInFlight) return;
        if (c.castRequested && c.support != support) _requestCancel(caseId, c);
        if (s == Status.Opening) _markOpened(caseId, c);
        c.support = uint8(support);
        c.hasDecision = true;
        c.hold = HoldReason.None;
        _addTimed(caseId);
        _tryCast(caseId, c);
    }

    function _onCastAck(LogRecord calldata log_) private {
        if (log_.opCode != 4 || log_.data.length < 3 * 32) return;
        uint256 caseId = log_.topic1;
        Case storage c = _cases[caseId];
        if (c.status == Status.None || c.status == Status.Cast) return;
        if (log_.chainId != c.originChainId || log_.contractAddress != c.delegate) return;
        uint256 support = _word(log_.data, 1);
        emit CastAcknowledged(caseId, _word(log_.data, 0), uint8(support), _word(log_.data, 2));
        // The vote is on the governor: that is the truth even if this contract had already stopped the case. A
        // pending cancel has nothing left to cancel.
        c.cancelPending = false;
        _finish(caseId, Status.Cast);
    }

    function _onNotActive(LogRecord calldata log_) private {
        if (log_.opCode != 2 || log_.data.length < 3 * 32) return;
        uint256 caseId = log_.topic1;
        Case storage c = _cases[caseId];
        if (c.status != Status.Casting) return;
        if (log_.chainId != c.originChainId || log_.contractAddress != c.delegate) return;
        uint256 seq = _word(log_.data, 0);
        // An answer to an older request says nothing about the current one.
        if (seq != c.seq) return;
        uint256 reason = _word(log_.data, 1);
        emit CastRefused(caseId, seq, uint8(reason));
        if (reason == uint256(IDelegate.Refusal.Superseded)) return;
        if (_injectionHeld(caseId, c)) {
            _hold(caseId, c, HoldReason.Injection);
        } else if (
            reason == uint256(IDelegate.Refusal.NotYetActive) || reason == uint256(IDelegate.Refusal.StateUnavailable)
        ) {
            _defer(caseId, c, block.timestamp + _caseConfig[caseId].retryAfter);
        } else if (reason == uint256(IDelegate.Refusal.Ended)) {
            _finish(caseId, Status.Expired);
        } else {
            _finish(caseId, Status.Failed);
        }
    }

    function _onCancelled(LogRecord calldata log_) private {
        if (log_.opCode != 2 || log_.data.length < 32) return;
        uint256 caseId = log_.topic1;
        Case storage c = _cases[caseId];
        if (!c.cancelPending) return;
        if (log_.chainId != c.originChainId || log_.contractAddress != c.delegate) return;
        uint256 seq = _word(log_.data, 0);
        if (seq < c.cancelSeq) return;
        c.cancelPending = false;
        emit CancelAcknowledged(caseId, seq);
        _retime(caseId, c);
    }

    function _onTick() private {
        _sweep();
        uint256 len = _timed.length;
        if (len == 0) return;
        uint256 scan = len < SCAN_PER_TICK ? len : SCAN_PER_TICK;
        uint256 start = _cursor % len;
        uint256[] memory ids = new uint256[](scan);
        for (uint256 i; i < scan; ++i) {
            ids[i] = _timed[(start + i) % len];
        }
        _cursor = start + scan;
        uint256 budget = MAX_CALLBACKS_PER_TICK;
        for (uint256 i; i < scan; ++i) {
            budget -= _service(ids[i], budget);
        }
    }

    /// @return used Callbacks requested.
    function _service(uint256 caseId, uint256 budget) private returns (uint256 used) {
        if (_timedIndex[caseId] == 0) return 0; // finished earlier in this tick
        Case storage c = _cases[caseId];
        Config storage cfg = _caseConfig[caseId];

        if (c.cancelPending && block.timestamp >= c.cancelDueAt && budget != 0) {
            if (c.cancelAttempts >= cfg.maxAttempts) {
                c.cancelPending = false;
                emit CancelAbandoned(caseId, c.cancelSeq);
            } else {
                _sendCancel(caseId, c);
                ++used;
            }
        }

        Status s = c.status;
        if (s != Status.Opening && s != Status.Window && s != Status.Waiting && s != Status.Casting) {
            _retime(caseId, c);
            return used;
        }
        if (_isStale(caseId, c)) {
            _finish(caseId, Status.Expired);
            return used;
        }
        if (block.timestamp < c.dueAt || budget == used) return used;
        if (s == Status.Opening) {
            if (c.attempts >= cfg.maxAttempts) {
                _finish(caseId, Status.Failed);
                return used;
            }
            _requestOpen(caseId);
            return used + 1;
        }
        if (s == Status.Window || s == Status.Waiting) return _tryCast(caseId, c) ? used + 1 : used;
        // Casting without an acknowledgement.
        if (c.attempts >= cfg.maxAttempts) {
            _finish(caseId, Status.Failed);
            return used;
        }
        if (_injectionHeld(caseId, c)) {
            _holdForInjection(caseId, c);
            return used;
        }
        _requestCast(caseId, c);
        return used + 1;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Tally

    function _evaluate(uint256 caseId, Case storage c) private {
        if (c.hold == HoldReason.Injection) return;
        Config storage cfg = _caseConfig[caseId];
        uint256 n = c.jurors.length;
        if (n < cfg.quorum) return;

        (bool decisive, uint8 winner) = _tally(caseId, c, cfg);
        if (!decisive) {
            if (cfg.splitPolicy == SplitPolicy.Hold) {
                _hold(caseId, c, HoldReason.Split);
                return;
            }
            winner = ABSTAIN;
        }

        if (c.status == Status.Window) {
            if (winner != c.support) {
                // A changed decision gets a full window of its own (review H-3). Each juror posts once and there
                // are at most 16, so the total extension is bounded.
                c.support = winner;
                uint64 restartAt = uint64(block.timestamp + cfg.vetoWindow);
                c.dueAt = restartAt;
                emit DecisionChanged(caseId, winner);
                emit WindowStarted(caseId, winner, restartAt);
            }
            return;
        }
        c.support = winner;
        c.hasDecision = true;
        c.hold = HoldReason.None;
        c.status = Status.Window;
        uint64 endsAt = uint64(block.timestamp + cfg.vetoWindow);
        c.dueAt = endsAt;
        _addTimed(caseId);
        emit CaseStatusChanged(caseId, Status.Window);
        emit WindowStarted(caseId, winner, endsAt);
    }

    /// @dev Tally rules in `MandateLogic.tally`.
    function _tally(uint256 caseId, Case storage c, Config storage cfg) private returns (bool, uint8) {
        return MandateLogic.tally(
            caseId,
            c.jurors,
            _ballots[caseId],
            _rawWeight,
            _bounds,
            cfg.minConfidenceBps,
            cfg.minAgreeing,
            cfg.majorityBps
        );
    }

    function _injectionHeld(uint256 caseId, Case storage c) private view returns (bool) {
        return !c.overridden && c.injectionFlags != 0 && c.injectionFlags >= _caseConfig[caseId].injectionFlagsToHold;
    }

    function _holdForInjection(uint256 caseId, Case storage c) private {
        if (c.castRequested && (c.status == Status.Casting || c.status == Status.Waiting)) _requestCancel(caseId, c);
        _hold(caseId, c, HoldReason.Injection);
    }

    function _hold(uint256 caseId, Case storage c, HoldReason reason) private {
        if (c.status == Status.Held && c.hold == reason) return;
        c.status = Status.Held;
        c.hold = reason;
        c.hasDecision = false;
        _retime(caseId, c);
        emit CaseStatusChanged(caseId, Status.Held);
        emit CaseHeld(caseId, reason);
    }

    /// @dev Weight learning in `MandateLogic.learn`.
    function _learn(uint256 caseId, Case storage c, uint8 ownerSupport, bool agreeOnEqual) private {
        MandateLogic.learn(caseId, c.jurors, _ballots[caseId], _rawWeight, _bounds, ownerSupport, agreeOnEqual);
    }

    function _weightOf(address juror, WeightBounds memory bounds) private view returns (uint32) {
        return MandateLogic.weightOf(_rawWeight[juror], bounds);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Callbacks and timers

    function _tryCast(uint256 caseId, Case storage c) private returns (bool requested) {
        if (_injectionHeld(caseId, c)) {
            _holdForInjection(caseId, c);
            return false;
        }
        uint256 nowTs = block.timestamp;
        if (c.clock == ClockMode.Timestamp) {
            if (nowTs > c.voteEnd) {
                _finish(caseId, Status.Expired);
                return false;
            }
            if (nowTs <= c.voteStart) {
                _defer(caseId, c, uint256(c.voteStart) + 1);
                return false;
            }
        } else if (c.clock == ClockMode.BlockNumber && c.blockTimeMs != 0 && c.voteStart >= c.originBlock) {
            // Voting opens at block voteStart + 1. Estimated from the origin block, never trusted for give-up.
            uint256 eta = uint256(c.createdAt) + ((c.voteStart - c.originBlock + 1) * c.blockTimeMs + 999) / 1000;
            if (nowTs < eta) {
                _defer(caseId, c, eta);
                return false;
            }
        }
        c.attempts = 0;
        _requestCast(caseId, c);
        return true;
    }

    function _defer(uint256 caseId, Case storage c, uint256 until) private {
        c.dueAt = uint64(until);
        if (c.status != Status.Waiting) {
            c.status = Status.Waiting;
            emit CaseStatusChanged(caseId, Status.Waiting);
        }
        _addTimed(caseId);
        emit CastDeferred(caseId, uint64(until));
    }

    function _requestOpen(uint256 caseId) private {
        Case storage c = _cases[caseId];
        Config storage cfg = _caseConfig[caseId];
        uint32 seq = ++c.seq;
        uint8 attempt = ++c.attempts;
        c.dueAt = uint64(block.timestamp + cfg.resendAfter);
        bytes memory payload = MandateLogic.openCasePayload(caseId, c);
        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({
                chainId: docketChainId, recipient: docket, gasLimit: cfg.openCaseGas, payload: payload
            })
        );
        emit OpenCaseRequested(caseId, seq, attempt);
    }

    function _requestCast(uint256 caseId, Case storage c) private {
        Config storage cfg = _caseConfig[caseId];
        uint32 seq = ++c.seq;
        uint8 attempt = ++c.attempts;
        c.castRequested = true;
        c.dueAt = uint64(block.timestamp + cfg.resendAfter);
        if (c.status != Status.Casting) {
            c.status = Status.Casting;
            emit CaseStatusChanged(caseId, Status.Casting);
        }
        bytes memory payload = MandateLogic.castPayload(
            caseId, c, _ballots[caseId], _rawWeight, _bounds, _caseConfig[caseId].minConfidenceBps
        );
        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({
                chainId: c.originChainId, recipient: c.delegate, gasLimit: cfg.castGas, payload: payload
            })
        );
        emit CastRequested(caseId, seq, c.support, attempt);
    }

    /// @dev Tells the Delegate to refuse every cast request for this case with a sequence number below the cancel's
    /// (review M-1). Tracked until `Cancelled` arrives or `maxAttempts` is spent.
    function _requestCancel(uint256 caseId, Case storage c) private {
        c.cancelSeq = ++c.seq;
        c.cancelPending = true;
        c.cancelAttempts = 0;
        _sendCancel(caseId, c);
        _addTimed(caseId);
    }

    function _sendCancel(uint256 caseId, Case storage c) private {
        Config storage cfg = _caseConfig[caseId];
        uint8 attempt = ++c.cancelAttempts;
        c.cancelDueAt = uint64(block.timestamp + cfg.resendAfter);
        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({
                chainId: c.originChainId,
                recipient: c.delegate,
                gasLimit: cfg.castGas,
                payload: abi.encodeCall(IDelegate.cancel, (address(0), caseId, c.cancelSeq))
            })
        );
        emit CancelRequested(caseId, c.cancelSeq, attempt);
    }

    function _markOpened(uint256 caseId, Case storage c) private {
        c.status = Status.Open;
        c.attempts = 0;
        _retime(caseId, c);
        emit CaseStatusChanged(caseId, Status.Open);
    }

    function _finish(uint256 caseId, Status status) private {
        Case storage c = _cases[caseId];
        if (!_isTerminal(c.status)) {
            --activeCases;
            Watch storage w = _watches[_key(c.originChainId, c.governor)];
            if (w.activeCount != 0) --w.activeCount;
        }
        c.status = status;
        _retime(caseId, c);
        emit CaseStatusChanged(caseId, status);
    }

    /// @dev Closes the oldest non-terminal cases that are stale, a few per reaction. Cases are created in time order,
    /// so the sweep stops at the first live one; `expireStale` covers anything it misses (review M-2).
    function _sweep() private {
        uint256 id = _sweepCursor;
        uint256 last = caseCount;
        for (uint256 steps; steps < SWEEP_PER_REACTION && id <= last; ++steps) {
            Case storage c = _cases[id];
            if (!_isTerminal(c.status)) {
                if (!_isStale(id, c)) break;
                _finish(id, Status.Expired);
            }
            ++id;
        }
        _sweepCursor = id;
    }

    function _isStale(uint256 caseId, Case storage c) private view returns (bool) {
        if (block.timestamp > uint256(c.createdAt) + _caseConfig[caseId].caseTtl) return true;
        return c.clock == ClockMode.Timestamp && block.timestamp > c.voteEnd;
    }

    /// @dev Keeps the timed set exact: a case is timed while its status has a timer or a cancel is unacknowledged.
    function _retime(uint256 caseId, Case storage c) private {
        Status s = c.status;
        bool timed =
            c.cancelPending || s == Status.Opening || s == Status.Window || s == Status.Waiting || s == Status.Casting;
        if (timed) _addTimed(caseId);
        else _removeTimed(caseId);
    }

    function _addTimed(uint256 caseId) private {
        if (_timedIndex[caseId] != 0) return;
        _timed.push(caseId);
        _timedIndex[caseId] = _timed.length;
    }

    function _removeTimed(uint256 caseId) private {
        uint256 idx = _timedIndex[caseId];
        if (idx == 0) return;
        uint256 last = _timed[_timed.length - 1];
        _timed[idx - 1] = last;
        _timedIndex[last] = idx;
        _timed.pop();
        delete _timedIndex[caseId];
    }

    /// @dev Cron is billed on every tick, so it is on exactly while some case has timed work.
    function _syncCron() private {
        bool want = _timed.length != 0;
        if (want == cronActive) return;
        cronActive = want;
        _sub(block.chainid, CRON_EMITTER, cronTopic, want);
        emit CronToggled(want);
    }

    function _subDelegate(uint256 chainId, address delegate_, bool on) private {
        _sub(chainId, delegate_, CAST_TOPIC, on);
        _sub(chainId, delegate_, NOT_ACTIVE_TOPIC, on);
        _sub(chainId, delegate_, CANCELLED_TOPIC, on);
    }

    /// @dev Single place that talks to the subscription service, so subscribe and unsubscribe always pass identical
    /// criteria (an unsubscribe that differs in any argument fails silently).
    function _sub(uint256 chainId, address emitter, uint256 topic0, bool on) private {
        if (on) SYSTEM.subscribe(chainId, emitter, topic0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        else SYSTEM.unsubscribe(chainId, emitter, topic0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
    }

    function _isTerminal(Status s) private pure returns (bool) {
        return s == Status.Cast || s == Status.Vetoed || s == Status.Expired || s == Status.Failed;
    }

    function _word(bytes calldata data, uint256 index) private pure returns (uint256 value) {
        assembly ("memory-safe") {
            value := calldataload(add(data.offset, mul(index, 0x20)))
        }
    }

    function _key(uint256 chainId, address emitter) private pure returns (bytes32) {
        return keccak256(abi.encode(chainId, emitter));
    }

    function _caseKey(uint256 chainId, address governor, uint256 proposalId) private pure returns (bytes32) {
        return keccak256(abi.encode(chainId, governor, proposalId));
    }
}
