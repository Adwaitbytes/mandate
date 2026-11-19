// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IDelegate} from "./interfaces/IDelegate.sol";
import {IDocket} from "./interfaces/IDocket.sol";
import {ProposalCreatedHead} from "./libraries/ProposalCreatedHead.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {AbstractReactive} from "@reactive/src/base/AbstractReactive.sol";
import {IReactive} from "@reactive/src/interfaces/IReactive.sol";
import {ISystemContract} from "@reactive/src/interfaces/ISystemContract.sol";

/// @title MandateReactive
/// @notice The trigger, tally, timer and executor for one mandate. Deployed on the Reactive Network.
///
/// Loop:
///   1. `ProposalCreated` on a watched governor -> case created here -> `Docket.openCase` callback (hearing chain).
///   2. Docket `CaseOpened` acknowledges the case. Jurors post `Verdict`s on the Docket; each one arrives here.
///   3. Any injection flag holds the case for good. Otherwise, once `quorum` verdicts are in, the weighted tally
///      either picks a side or is split. Split follows `splitPolicy` (abstain, or hold for the owner).
///   4. A decided case starts a veto window. When it closes (seen on a cron tick) the contract requests
///      `Delegate.cast` on the governor's chain.
///   5. The Delegate answers with `Cast` (done) or `NotActive` (retry later, give up, or fail).
///   6. Docket `Vetoed` / `Overridden` stop or replace the vote and move juror weight toward the jurors that agreed
///      with the owner, within bounds.
///
/// Delivery is treated as at-least-once and possibly out of order: every callback carries a per-case sequence
/// number, both destination functions are idempotent, every request has an acknowledgement event subscribed here,
/// and a missing acknowledgement triggers a resend on a later cron tick. Cron is subscribed only while at least one
/// case has timed work.
///
/// Clocks: governor `voteStart`/`voteEnd` are in the governor's ERC-6372 clock (blocks or seconds), not this chain's.
/// The Delegate is the authority on whether voting is open (it asks `state()`). This contract only uses the bounds to
/// avoid wasted callbacks when the owner declared the governor's clock: for timestamp governors it waits until
/// `voteStart` and gives up after `voteEnd`; for block governors with a declared block time it estimates when voting
/// opens. Every other timer here uses `block.timestamp` on the Reactive Network.
contract MandateReactive is AbstractReactive, Ownable2Step {
    using Strings for uint256;

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
    /// @notice Ballots tracked per case (matches `Docket.MAX_JURORS`).
    uint256 public constant MAX_BALLOTS_PER_CASE = 16;
    /// @notice Reactive Network ignores callback requests below 100k gas.
    uint64 public constant MIN_CALLBACK_GAS = 100_000;
    uint64 public constant MAX_CALLBACK_GAS = 3_000_000;
    uint32 public constant MAX_WEIGHT = 1_000_000;
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
        Held, // injection flag (sticky) or split under the Hold policy (re-evaluated on new verdicts)
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
        Capacity
    }

    struct Config {
        uint8 quorum; // distinct verdicts needed before tallying
        uint16 minConfidenceBps; // verdicts below this count toward quorum and the denominator, not toward a side
        uint16 majorityBps; // a side needs a weight share strictly above this (5000 = simple majority)
        SplitPolicy splitPolicy;
        uint8 maxAttempts; // sends of one request without an acknowledgement before the case fails
        uint32 vetoWindow; // seconds
        uint32 resendAfter; // seconds without an acknowledgement before resending
        uint32 retryAfter; // seconds between NotYetActive retries
        uint32 caseTtl; // seconds from creation after which timed work is abandoned
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
    }

    struct Case {
        Status status;
        HoldReason hold;
        ClockMode clock;
        uint8 support;
        bool hasDecision;
        bool ownerActed;
        bool overridden;
        uint8 attempts;
        uint32 seq;
        uint32 mandateVersion;
        uint32 blockTimeMs;
        uint64 originChainId;
        uint64 createdAt;
        uint64 dueAt;
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

    // ---------------------------------------------------------------------------------------------------------------
    // Events

    event DocketSet(uint256 indexed chainId, address indexed docket);
    event GovernorWatched(uint256 indexed chainId, address indexed governor, ClockMode clock, uint32 blockTimeMs);
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
    event OwnerActionTooLate(uint256 indexed caseId, bool veto);
    event WeightsUpdated(uint256 indexed caseId, address[] jurors, uint32[] weights);
    event CronToggled(bool active);

    // ---------------------------------------------------------------------------------------------------------------
    // State

    /// @notice Cron topic used for timed work (one of the five protocol intervals).
    uint256 public immutable cronTopic;

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
    mapping(bytes32 key => uint256 caseId) private _caseIdByKey;
    mapping(uint256 caseId => mapping(address juror => Ballot)) private _ballots;
    mapping(address juror => uint32) private _rawWeight;

    uint256[] private _timed;
    mapping(uint256 caseId => uint256 indexPlusOne) private _timedIndex;
    uint256 private _cursor;

    /// @param owner_ Operator on the Reactive Network: wiring, configuration and cleanup. Holds no vote power.
    /// @param cronTopic_ One of the five Cron topics; the tick interval for timed work.
    constructor(address owner_, uint256 cronTopic_) payable Ownable(owner_) {
        if (
            cronTopic_ != CRON1_TOPIC && cronTopic_ != CRON10_TOPIC && cronTopic_ != CRON100_TOPIC
                && cronTopic_ != CRON1000_TOPIC && cronTopic_ != CRON10000_TOPIC
        ) revert InvalidCronTopic(cronTopic_);
        cronTopic = cronTopic_;
        _config = Config({
            quorum: 2,
            minConfidenceBps: 6000,
            majorityBps: 5000,
            splitPolicy: SplitPolicy.Hold,
            maxAttempts: 3,
            vetoWindow: 10 minutes,
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

    /// @notice Stops watching a governor. Cases already open continue.
    function unwatchGovernor(uint256 chainId, address governor) external onlyOwner {
        Watch storage w = _watches[_key(chainId, governor)];
        if (!w.active) return;
        delete _watches[_key(chainId, governor)];
        _sub(chainId, governor, PROPOSAL_CREATED_TOPIC, false);
        emit GovernorUnwatched(chainId, governor);
    }

    /// @notice Sets the Delegate that votes on `chainId` and subscribes to its acknowledgements.
    /// @dev Replacing a Delegate drops the old one's subscriptions; change it only when no case on that chain is
    /// waiting for an acknowledgement, or those cases will resend to the old Delegate and fail after maxAttempts.
    function setDelegate(uint256 chainId, address delegate_) external onlyOwner {
        if (chainId == 0) revert ZeroAddress();
        address previous = delegateOf[chainId];
        if (previous == delegate_) return;
        if (previous != address(0)) {
            _sub(chainId, previous, CAST_TOPIC, false);
            _sub(chainId, previous, NOT_ACTIVE_TOPIC, false);
        }
        delegateOf[chainId] = delegate_;
        if (delegate_ != address(0)) {
            _sub(chainId, delegate_, CAST_TOPIC, true);
            _sub(chainId, delegate_, NOT_ACTIVE_TOPIC, true);
        }
        emit DelegateSet(chainId, delegate_);
    }

    /// @notice Replaces the tally and timer configuration. Applies to every case from its next evaluation on.
    function setConfig(Config calldata config_) external onlyOwner {
        if (
            config_.quorum == 0 || config_.quorum > MAX_BALLOTS_PER_CASE || config_.minConfidenceBps > BPS
                || config_.majorityBps < BPS / 2 || config_.majorityBps >= BPS || config_.maxAttempts == 0
                || config_.vetoWindow > 7 days || config_.resendAfter == 0 || config_.retryAfter == 0
                || config_.caseTtl < config_.vetoWindow || config_.openCaseGas < MIN_CALLBACK_GAS
                || config_.openCaseGas > MAX_CALLBACK_GAS || config_.castGas < MIN_CALLBACK_GAS
                || config_.castGas > MAX_CALLBACK_GAS
        ) revert InvalidConfig();
        _config = config_;
        emit ConfigUpdated(config_);
    }

    /// @notice Replaces the juror weight bounds. Stored weights are clamped into the new bounds when read.
    function setWeightBounds(WeightBounds calldata bounds_) external onlyOwner {
        if (
            bounds_.min == 0 || bounds_.min > bounds_.initial || bounds_.initial > bounds_.max
                || bounds_.max > MAX_WEIGHT || bounds_.step == 0
        ) revert InvalidWeightBounds();
        _bounds = bounds_;
        emit WeightBoundsUpdated(bounds_);
    }

    /// @notice Closes a non-terminal case as Expired (cleanup for cases whose jurors or owner never came back).
    function closeCase(uint256 caseId) external onlyOwner {
        Status s = _cases[caseId].status;
        if (s == Status.None) revert UnknownCase(caseId);
        if (_isTerminal(s)) revert CaseFinished(caseId);
        _finish(caseId, Status.Expired);
        _syncCron();
    }

    /// @notice Settles any debt to the system contract from this contract's balance. Open to anyone so a third party
    /// can revive the contract.
    function coverDebt() external {
        _coverDebt();
    }

    /// @notice Withdraws native balance not needed for fees.
    function withdraw(uint256 amount, address payable to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Views

    function config() external view returns (Config memory) {
        return _config;
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
        Watch memory w = _watches[_key(log_.chainId, log_.contractAddress)];
        if (!w.active) return;

        (bool ok, uint256 proposalId,, uint64 voteStart, uint64 voteEnd) = ProposalCreatedHead.read(log_.data);
        if (!ok) {
            emit ProposalSkipped(log_.chainId, log_.contractAddress, 0, SkipReason.Malformed);
            return;
        }

        bytes32 caseKey = _caseKey(log_.chainId, log_.contractAddress, proposalId);
        SkipReason reason;
        bool skip = true;
        if (_caseIdByKey[caseKey] != 0) reason = SkipReason.Duplicate;
        else if (docket == address(0)) reason = SkipReason.NoDocket;
        else if (delegateOf[log_.chainId] == address(0)) reason = SkipReason.NoDelegate;
        else if (activeCases >= MAX_ACTIVE_CASES) reason = SkipReason.Capacity;
        else skip = false;
        if (skip) {
            emit ProposalSkipped(log_.chainId, log_.contractAddress, proposalId, reason);
            return;
        }

        uint256 caseId = ++caseCount;
        _caseIdByKey[caseKey] = caseId;
        ++activeCases;
        _initCase(caseId, log_, w);
        Case storage c = _cases[caseId];
        c.proposalId = proposalId;
        c.voteStart = voteStart;
        c.voteEnd = voteEnd;
        _announce(caseId);
        _addTimed(caseId);
        _requestOpen(caseId);
    }

    function _announce(uint256 caseId) private {
        Case storage c = _cases[caseId];
        emit CaseCreated(caseId, c.originChainId, c.governor, c.proposalId, c.voteStart, c.voteEnd, c.originTxHash);
        emit CaseStatusChanged(caseId, Status.Opening);
    }

    function _initCase(uint256 caseId, LogRecord calldata log_, Watch memory w) private {
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
        emit BallotRecorded(caseId, juror, uint8(support), uint16(confidence), injection, weightOf(juror));

        // A verdict can only exist for a case the Docket opened, so it doubles as the open acknowledgement when the
        // CaseOpened log arrives later than the verdict.
        if (c.status == Status.Opening) _markOpened(caseId, c);

        Status s = c.status;
        if (
            injection && !c.overridden
                && (s == Status.Open || s == Status.Held || s == Status.Window || s == Status.Waiting)
        ) {
            _hold(caseId, c, HoldReason.Injection);
        } else if (s == Status.Open || s == Status.Held || s == Status.Window) {
            _evaluate(caseId, c);
        }
        // Waiting, Casting and terminal cases keep the ballot for weight learning only: the decision is locked.
    }

    function _onVeto(LogRecord calldata log_) private {
        if (log_.opCode != 2) return;
        uint256 caseId = log_.topic1;
        Case storage c = _cases[caseId];
        if (c.status == Status.None || c.ownerActed) return;
        c.ownerActed = true;
        if (c.hasDecision) _learn(caseId, c, c.support, false);
        Status s = c.status;
        if (s == Status.Casting || _isTerminal(s)) {
            emit OwnerActionTooLate(caseId, true);
            return;
        }
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
        if (s == Status.Casting || _isTerminal(s)) {
            if (!(s != Status.Expired && s != Status.Failed && s != Status.Vetoed && c.support == support)) {
                emit OwnerActionTooLate(caseId, false);
            }
            return;
        }
        if (s == Status.Opening) _markOpened(caseId, c);
        c.support = uint8(support);
        c.hasDecision = true;
        c.overridden = true;
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
        // The vote is on the governor: that is the truth even if this contract had already given up on the case.
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
        if (reason == uint256(IDelegate.Refusal.NotYetActive)) {
            _defer(caseId, c, block.timestamp + _config.retryAfter);
        } else if (reason == uint256(IDelegate.Refusal.Ended)) {
            _finish(caseId, Status.Expired);
        } else {
            _finish(caseId, Status.Failed);
        }
    }

    function _onTick() private {
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
            if (_service(ids[i], budget)) --budget;
        }
    }

    /// @return requested True when a callback was requested.
    function _service(uint256 caseId, uint256 budget) private returns (bool requested) {
        if (_timedIndex[caseId] == 0) return false; // finished earlier in this tick
        Case storage c = _cases[caseId];
        if (block.timestamp > uint256(c.createdAt) + _config.caseTtl) {
            _finish(caseId, Status.Expired);
            return false;
        }
        if (block.timestamp < c.dueAt || budget == 0) return false;
        Status s = c.status;
        if (s == Status.Opening) {
            if (c.attempts >= _config.maxAttempts) {
                _finish(caseId, Status.Failed);
                return false;
            }
            _requestOpen(caseId);
            return true;
        }
        if (s == Status.Window || s == Status.Waiting) return _tryCast(caseId, c);
        if (s == Status.Casting) {
            if (c.attempts >= _config.maxAttempts) {
                _finish(caseId, Status.Failed);
                return false;
            }
            if (c.clock == ClockMode.Timestamp && block.timestamp > c.voteEnd) {
                _finish(caseId, Status.Expired);
                return false;
            }
            _requestCast(caseId, c);
            return true;
        }
        _removeTimed(caseId);
        return false;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Tally

    function _evaluate(uint256 caseId, Case storage c) private {
        if (c.hold == HoldReason.Injection) return;
        Config memory cfg = _config;
        uint256 n = c.jurors.length;
        if (n < cfg.quorum) return;

        WeightBounds memory bounds = _bounds;
        uint256[3] memory side;
        uint256 low;
        uint256 total;
        for (uint256 i; i < n; ++i) {
            address juror = c.jurors[i];
            Ballot storage b = _ballots[caseId][juror];
            uint256 w = _weightOf(juror, bounds);
            total += w;
            if (b.confidenceBps >= cfg.minConfidenceBps) side[b.support] += w;
            else low += w;
        }
        emit TallyUpdated(caseId, side[0], side[1], side[2], low, n);

        (bool decisive, uint8 winner) = _winner(side, total, cfg.majorityBps);
        if (!decisive) {
            if (cfg.splitPolicy == SplitPolicy.Hold) {
                _hold(caseId, c, HoldReason.Split);
                return;
            }
            winner = ABSTAIN;
        }

        if (c.status == Status.Window) {
            if (winner != c.support) {
                c.support = winner;
                emit DecisionChanged(caseId, winner);
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

    /// @dev With majorityBps >= 5000 at most one side can clear the bar.
    function _winner(uint256[3] memory side, uint256 total, uint16 majorityBps)
        private
        pure
        returns (bool decisive, uint8 winner)
    {
        for (uint8 s; s <= ABSTAIN; ++s) {
            if (side[s] * BPS > total * majorityBps) return (true, s);
        }
        return (false, 0);
    }

    function _hold(uint256 caseId, Case storage c, HoldReason reason) private {
        if (c.status == Status.Held && c.hold == reason) return;
        c.status = Status.Held;
        c.hold = reason;
        c.hasDecision = false;
        _removeTimed(caseId);
        emit CaseStatusChanged(caseId, Status.Held);
        emit CaseHeld(caseId, reason);
    }

    /// @dev Moves each juror that took part one step toward (agreed) or away from (disagreed) the owner.
    /// Veto: a juror agreed with the owner when its support differs from the vetoed decision.
    /// Override: a juror agreed when its support equals the owner's.
    function _learn(uint256 caseId, Case storage c, uint8 ownerSupport, bool agreeOnEqual) private {
        uint256 n = c.jurors.length;
        if (n == 0) return;
        WeightBounds memory bounds = _bounds;
        address[] memory jurors = new address[](n);
        uint32[] memory weights = new uint32[](n);
        for (uint256 i; i < n; ++i) {
            address juror = c.jurors[i];
            bool same = _ballots[caseId][juror].support == ownerSupport;
            uint32 w = _weightOf(juror, bounds);
            if (same == agreeOnEqual) {
                w = w + bounds.step >= bounds.max ? bounds.max : w + bounds.step;
            } else {
                w = w <= bounds.min + bounds.step ? bounds.min : w - bounds.step;
            }
            _rawWeight[juror] = w;
            jurors[i] = juror;
            weights[i] = w;
        }
        emit WeightsUpdated(caseId, jurors, weights);
    }

    function _weightOf(address juror, WeightBounds memory bounds) private view returns (uint32) {
        uint32 raw = _rawWeight[juror];
        if (raw == 0) return bounds.initial;
        if (raw < bounds.min) return bounds.min;
        if (raw > bounds.max) return bounds.max;
        return raw;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Callbacks and timers

    function _tryCast(uint256 caseId, Case storage c) private returns (bool requested) {
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
        uint32 seq = ++c.seq;
        uint8 attempt = ++c.attempts;
        c.dueAt = uint64(block.timestamp + _config.resendAfter);
        bytes memory payload = abi.encodeCall(
            IDocket.openCase,
            (
                address(0),
                caseId,
                seq,
                c.originChainId,
                c.governor,
                c.proposalId,
                c.voteStart,
                c.voteEnd,
                bytes32(c.originTxHash),
                c.delegate
            )
        );
        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({
                chainId: docketChainId, recipient: docket, gasLimit: _config.openCaseGas, payload: payload
            })
        );
        emit OpenCaseRequested(caseId, seq, attempt);
    }

    function _requestCast(uint256 caseId, Case storage c) private {
        uint32 seq = ++c.seq;
        uint8 attempt = ++c.attempts;
        c.dueAt = uint64(block.timestamp + _config.resendAfter);
        if (c.status != Status.Casting) {
            c.status = Status.Casting;
            emit CaseStatusChanged(caseId, Status.Casting);
        }
        bytes memory payload = abi.encodeCall(
            IDelegate.cast, (address(0), caseId, seq, c.governor, c.proposalId, c.support, _reason(caseId, c))
        );
        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({
                chainId: c.originChainId, recipient: c.delegate, gasLimit: _config.castGas, payload: payload
            })
        );
        emit CastRequested(caseId, seq, c.support, attempt);
    }

    /// @dev Short, deterministic reason string: case, mandate version, decision path and the rationale hash of the
    /// heaviest juror on the winning side (the full text is published off-chain under that hash).
    function _reason(uint256 caseId, Case storage c) private view returns (string memory) {
        string memory head =
            string.concat("Mandate case ", caseId.toString(), ", mandate v", uint256(c.mandateVersion).toString());
        if (c.overridden) return string.concat(head, ": owner override");
        bytes32 best;
        uint32 bestWeight;
        WeightBounds memory bounds = _bounds;
        uint16 minConfidence = _config.minConfidenceBps;
        uint256 n = c.jurors.length;
        for (uint256 i; i < n; ++i) {
            address juror = c.jurors[i];
            Ballot storage b = _ballots[caseId][juror];
            uint32 w = _weightOf(juror, bounds);
            if (b.support == c.support && b.confidenceBps >= minConfidence && w > bestWeight) {
                best = b.rationaleHash;
                bestWeight = w;
            }
        }
        if (best == bytes32(0)) return string.concat(head, ": split verdict, abstaining");
        return string.concat(head, ": juror quorum, rationale ", uint256(best).toHexString(32));
    }

    function _markOpened(uint256 caseId, Case storage c) private {
        c.status = Status.Open;
        c.attempts = 0;
        _removeTimed(caseId);
        emit CaseStatusChanged(caseId, Status.Open);
    }

    function _finish(uint256 caseId, Status status) private {
        Case storage c = _cases[caseId];
        if (!_isTerminal(c.status)) --activeCases;
        c.status = status;
        _removeTimed(caseId);
        emit CaseStatusChanged(caseId, status);
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
