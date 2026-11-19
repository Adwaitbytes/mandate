# Mandate contracts: security review

Fresh-context adversarial review of `contracts/src` against MASTER_PROMPT sections 7 and 10, the Reactive docs in `ref/reactive-docs`, and `docs/JUROR_INTERFACE.md`. Date: 2026-11-19. No source files were modified.

Proof-of-concept tests are in `contracts/test/security/`. Each one asserts the secure behaviour, so each one **fails against the current code**. They stay red until the fix lands. Run them with:

```
forge test --match-path 'test/security/*'
```

Result at review time: 6 tests, 6 failing for the intended reason. The existing suite (145 tests) still passes.

**After fixes (2026-11-19): all 6 PoCs pass; full suite 179 tests green.** Resolution lines follow each finding.

| ID | Severity | Title | PoC |
|---|---|---|---|
| H-1 | High | A veto, override or injection flag that arrives during `Casting` is dropped, and the vote is cast later anyway | `VetoBypass.t.sol::test_vetoWhileCastInFlight_mustPreventVote` |
| H-2 | High | After weight learning, one juror key outvotes every other juror combined | `WeightAndWindow.t.sol::test_singleJurorMustNotOutvoteAllOthers` |
| H-3 | High | A late verdict flips the decision inside the veto window without restarting it | `WeightAndWindow.t.sol::test_decisionChangeInWindow_mustRestartVetoWindow` |
| M-1 | Medium | A delayed cast request still votes after a veto. The Delegate cannot be told to cancel | `VetoBypass.t.sol::test_staleCastRequestAfterVeto_mustNotVote` |
| M-2 | Medium | Held and Open cases never expire, so anyone can fill `MAX_ACTIVE_CASES` and stop all new cases | `CapacityGriefing.t.sol` |
| M-3 | Medium | Any single injection flag stops the vote: one juror key can stop all voting, and a proposer can bait the jurors to avoid an automated vote | (design) |
| M-4 | Medium | Compound Bravo governors never receive a vote. The return value fails to decode, the whole call reverts, and every retry is billed | `BravoGovernor.t.sol` |
| M-5 | Medium | The operator config has no safety floors (veto window 0, quorum 1) and applies to cases already in flight | (config) |
| M-6 | Medium | Anyone can create demo proposals with no throttle, which drains lREACT, Docket ETH, Delegate ETH and juror quotas | (economic) |
| L-1..L-8 | Low | Veto latency at window close, refusal mapping, weight-step overflow, clock misdeclaration, cron cost, faucet Sybil, `setDelegate` mid-flight, unbounded `withdraw` | |
| I-1..I-4 | Info | Off-chain trust boundary | |

The rest of the attack surface checked out. See "Checked and fine" at the end.

---

## H-1. A veto, override or injection flag during `Casting` is dropped, and the vote goes out later

**Resolution (2026-11-19): fixed.** Casting is no longer terminal for owner actions. A veto in Casting or Waiting sends `Delegate.cancel` (tracked until `Cancelled`, resent on ticks, abandoned after `maxAttempts`) and finishes the case Vetoed; `NotActive` and resends stop. An override that changes the support cancels first and then requests a new cast at a higher seq. Injection flags are counted in every status; a held case in Casting or Waiting is cancelled, and the hold is re-checked before every cast, retry and resend. A late `Cast` acknowledgement still records the truth. Tests: `VetoBypass.t.sol::test_vetoWhileCastInFlight_mustPreventVote` (green) and five `test_H1_*` in `test/security/Fixes.t.sol`.

**Location.** `src/MandateReactive.sol:574-578` (veto), `:590-596` (override), `:564` and `:556-563` (verdicts in Casting), `:629-630` and `:821-829` (NotYetActive returns the case to Waiting), `:673-683` (resend).

**Problem.** `_onVeto` treats `Status.Casting` as if the vote had already happened. It sets `ownerActed = true`, emits `OwnerActionTooLate` and returns. But Casting only means a request is in flight. That request can still come back as `NotActive(NotYetActive)`, which `_defer`s the case back to `Waiting`. It can also get no acknowledgement, in which case `_service` resends it. In both cases the vetoed decision is cast later. The Docket has already recorded `ownerAction = Veto`, so the owner cannot veto again (`OwnerAlreadyActed`). The UI shows "vetoed" while a vote is pending.

**Scenario.** This is the default path for a block-clock governor with `blockTimeMs = 0`, and it is also hit when the estimate is early:
1. Jurors decide FOR and the window closes. `_tryCast` sends the first cast while the proposal is still Pending. Status is `Casting`.
2. The owner calls `Docket.veto(caseId)`. `_onVeto` sees `Casting`, logs "too late" and returns.
3. The Delegate answers `NotActive(NotYetActive)`. `_defer` moves the case to `Waiting`.
4. Voting opens. The next tick calls `_tryCast` and the Delegate votes FOR.

The same applies to `overrideVote` with a different support: the override is ignored, and the old support is cast on retry. It also applies to injection flags: `_onVerdict` ignores the flag in Casting (`:564`), the case returns to Waiting, and the flagged case auto-votes. This contradicts JUROR_INTERFACE's statement that a flag holds the case "for good".

The PoC drives exactly steps 1-4 through the relay.

**Fix.** Casting is not terminal. Stop the case and let a late `Cast` acknowledgement record the truth. `_onCastAck` already accepts any non-Cast status.

```solidity
function _onVeto(LogRecord calldata log_) private {
    ...
    c.ownerActed = true;
    if (c.hasDecision) _learn(caseId, c, c.support, false);
    Status s = c.status;
    if (_isTerminal(s)) { emit OwnerActionTooLate(caseId, true); return; }
    if (s == Status.Casting) _requestCancel(caseId, c); // see M-1; a request may still land
    _finish(caseId, Status.Vetoed);                     // NotActive is ignored, resends stop
}
```

For an override during Casting, set `c.support = support; c.overridden = true;`, send a cancel (M-1), and request a new cast. For injection, record `c.injectionSeen = true` in `_onVerdict` whatever the status, and check it in `_onNotActive` and `_service` before any retry or resend:

```solidity
if (c.injectionSeen && !c.overridden) { _hold(caseId, c, HoldReason.Injection); return; }
```

---

## H-2. One juror key outvotes every other juror after weight learning

**Resolution (2026-11-19): fixed.** New `Config.minAgreeing` (floor 2, at most `quorum`): a side wins only with at least that many confident ballots and a weight share above `majorityBps`. Weight can block a side but never carry one alone. Tests: `WeightAndWindow.t.sol::test_singleJurorMustNotOutvoteAllOthers` (green), `Tally.t.sol::test_learnedWeight_canBlockButNotCarry`, `test_minAgreeing_three_needsThreeOnOneSide`.

**Location.** `src/MandateReactive.sol:293` (default bounds 25/100/400), `:394-401` (`setWeightBounds` places no limit on the max/min ratio), `:740-749` (`_winner` compares weight only), `:764-784` (`_learn`).

**Problem.** The spec's headline invariant is "No single model and no single key can move a vote." Weights can range over 16x (25 to 400), and the winner is chosen on weight share alone. After a few owner actions that sided with one juror, that juror's weight is larger than the sum of all the others. From then on it decides every case where any one other juror has posted, even against unanimous opposition. Quorum only counts ballots. It does not require that more than one ballot agrees.

**Scenario.** The owner overrides three cases where juror3 alone agreed with them. The weights become 25 / 25 / 175. On the next case, juror1 and juror2 post FOR and juror3 posts AGAINST: AGAINST has 175 of 225 (78%), so the case is decided AGAINST. Whoever holds juror3's key, whether a compromised provider key, a hacked worker host or a drifting model, now controls every vote. The PoC reproduces this with default settings.

**Fix.** Require independent agreement, not just weight:

```solidity
// Config: uint8 minAgreeing; setConfig: require(minAgreeing >= 2 && minAgreeing <= quorum)
uint256[3] memory count;
...
if (b.confidenceBps >= cfg.minConfidenceBps) { side[b.support] += w; ++count[b.support]; }
...
if (side[s] * BPS > total * majorityBps && count[s] >= cfg.minAgreeing) return (true, s);
```

Optionally, also bound the ratio in `setWeightBounds`, for example `max <= 2 * min * (MAX_JURORS - 1)`, or better, against the registered juror count. `minAgreeing` is the simpler and stronger fix.

---

## H-3. A late verdict flips the decision inside the veto window without restarting it

**Resolution (2026-11-19): fixed.** A changed decision inside the window sets `dueAt = now + vetoWindow` and emits `DecisionChanged` and `WindowStarted`; an unchanged one keeps the deadline. Tests: `WeightAndWindow.t.sol::test_decisionChangeInWindow_mustRestartVetoWindow` (green), `Tally.t.sol::test_decisionChangeDuringWindow_restartsWindow`, `test_unchangedDecision_keepsWindowEnd`.

**Location.** `src/MandateReactive.sol:721-727`.

**Problem.** When `_evaluate` runs on a case already in `Window`, it overwrites `c.support` and emits `DecisionChanged`, but leaves `c.dueAt` unchanged. The owner approved FOR by not acting, and AGAINST is cast instead. A juror whose verdict lands at the last second leaves the owner no time to react. Posting late is something any juror can choose to do. With the Abstain split policy, a single tie-making verdict can flip FOR to ABSTAIN. With learned weights (H-2), a single verdict can flip FOR to AGAINST under the default Hold policy.

**Scenario (PoC).** Five jurors, Abstain policy. Juror1 and juror2 post FOR, so the window starts on FOR. With 2 s left, juror3, juror4 and juror5 post AGAINST, and the decision moves to ABSTAIN and then to AGAINST. The next tick sends AGAINST. The owner had about 2 seconds to see and veto the decision that was actually cast.

**Fix.** A changed decision gets a full window of its own:

```solidity
if (c.status == Status.Window) {
    if (winner != c.support) {
        c.support = winner;
        c.dueAt = uint64(block.timestamp + cfg.vetoWindow);
        emit DecisionChanged(caseId, winner);
        emit WindowStarted(caseId, winner, c.dueAt);
    }
    return;
}
```

Each juror posts once and there are at most 16, so the total extension is bounded. An alternative is to lock the decision at window start and ignore later verdicts, which is simpler but discards information.

---

## M-1. A delayed cast request still votes after a veto. There is no cancel path to the Delegate

**Resolution (2026-11-19): fixed, with a residual risk.** `Delegate.cancel(rvm, caseId, seq)` (both guards) raises a per-case `minSeq`; every processed cast request also raises it, so a delayed older request is refused with `Refusal.Superseded`. `Cancelled(caseId, seq)` is the acknowledgement the reactive contract subscribes to. Residual: a request that executes before the cancel arrives still votes (truthfully recorded as Cast); see docs/LIMITS.md. Tests: `VetoBypass.t.sol::test_staleCastRequestAfterVeto_mustNotVote` (green), five cancel and floor tests in `test/unit/Delegate.t.sol`.

**Location.** `src/Delegate.sol:77-135` (only `caseId` idempotence, no per-case cancel or min-seq). `src/MandateReactive.sol:579` (a veto in Waiting finishes locally only).

**Problem.** The design treats delivery as at least once and possibly out of order (spec 7.15). After an unacknowledged request (seq n) is resent (seq n+1) and seq n+1 returns NotYetActive, the case sits in `Waiting`. A veto there is processed normally: the case becomes `Vetoed`. The original seq n request is still in flight. When it lands after voting opens, the Delegate votes, and `_onCastAck` turns `Vetoed` into `Cast`. The same race lets a stale request carry the pre-override support.

**Scenario.** This is the PoC: hold seq 2, resend seq 3, deliver seq 3 (NotYetActive), veto, open voting, deliver seq 2. The vote is cast.

**Fix.** Add a cancel callback and a per-case floor in the Delegate, and send the cancel on every veto or override when `c.seq` shows a cast request was ever made:

```solidity
mapping(uint256 caseId => uint256) public minSeq;
function cancel(address rvm, uint256 caseId, uint256 seq) external onlyServiceProvider onlyCallbackSender(rvm) {
    if (seq > minSeq[caseId]) minSeq[caseId] = seq;
}
// in cast(): if (seq < minSeq[caseId]) { _refuse(caseId, seq, Refusal.Superseded, STATE_UNAVAILABLE); return; }
```

An override then sends `cancel(seq)` followed by a cast at `seq + 1`. Under fully unordered delivery, a message already in flight can still win the race. Document that residual risk, and keep `Delegate.setPaused` as the owner's hard stop.

---

## M-2. Held and Open cases never expire, so anyone can fill `MAX_ACTIVE_CASES`

**Resolution (2026-11-19): fixed.** `caseTtl` now applies to every non-terminal case, and a case on a declared timestamp governor is also stale after `voteEnd`. An oldest-first sweep closes up to 4 stale cases on every `ProposalCreated` and every tick; `expireStale(ids)` lets anyone close stale cases; `setGovernorLimits` adds a per-governor `maxActive`. Tests: `CapacityGriefing.t.sol` (green), `test_M2_*` in `Fixes.t.sol`.

**Location.** `src/MandateReactive.sol:482` (capacity check), `:905` (`_markOpened` removes the case from the timed set), `:756` (`_hold` removes it too), `:658` (`caseTtl` is only checked for timed cases).

**Problem.** `caseTtl` is enforced only inside `_service`, which runs only for timed cases. Open cases (waiting for jurors) and Held cases (injection or split) are not timed, so they stay in `activeCases` until the operator calls `closeCase` one id at a time. Once 128 cases are active, every new `ProposalCreated` on every watched governor is skipped with `SkipReason.Capacity`. The skip is permanent, because there is no replay.

**Scenario.** The demo governors have `proposalThreshold = 0` (`src/demo/DemoGovernor.sol:30`), so the attacker needs no tokens. They submit 128 proposals whose text addresses an AI voter. The honest jurors flag them, and every case is Held for good. Days later, past `caseTtl` and every `voteEnd`, a legitimate proposal is still skipped. Cases also leak organically: a mandate with version 0 (jurors refuse to post), a juror outage, or proposals that ended before quorum. The capacity is global, so spam on the demo DAO also blocks cases on any real governor the same contract watches. The PoC reproduces this.

**Fix.** Expire stale untimed cases without the operator:

```solidity
/// Anyone may close cases past caseTtl (a normal transaction on the Reactive Network).
function expireStale(uint256[] calldata ids) external {
    uint256 ttl = _config.caseTtl;
    for (uint256 i; i < ids.length; ++i) {
        Case storage c = _cases[ids[i]];
        if (c.status != Status.None && !_isTerminal(c.status) && block.timestamp > uint256(c.createdAt) + ttl) {
            _finish(ids[i], Status.Expired);
        }
    }
    _syncCron();
}
```

Also evict lazily in `_onProposalCreated` when at capacity, give each governor its own cap so one permissionless governor cannot starve the others, and consider a proposer allowlist or rate limit (M-6).

---

## M-3. One injection flag stops the vote: one juror key can stop all voting, and proposers can avoid an automated vote

**Resolution (2026-11-19): owner-set policy chosen.** `Config.injectionFlagsToHold` (1 to `quorum`, default 1). The default stays fail-safe, as the spec requires ("a flagged case never auto-votes"): freezing a vote is recoverable by override, while an automated vote on a text that one model judged manipulative is not. A deployment that fears one juror key freezing every case sets 2. Held cases now expire (M-2), so they no longer consume capacity for good. Residual effects are in docs/LIMITS.md. Tests: `test_M3_*` in `Fixes.t.sol`.

**Location.** `src/MandateReactive.sol:556-560`. JUROR_INTERFACE section 4: "When in doubt, flag. Any single flag holds the case for good."

**Problem.** The rule does what the spec asks (a flagged case never auto-votes), and it is safe against a forced vote. It has two exploitable effects:
- **One key can stop all voting.** One compromised or drifting juror that flags every case stops every automated vote. "No single key can move a vote" holds, but a single key can stop every vote.
- **A proposer can avoid an automated vote.** A hostile proposer who expects Mandate users to vote AGAINST, for example on a treasury drain, adds one line addressed to "the AI voter". The case is Held, no automated AGAINST is cast, and the proposal benefits from the missing opposition unless every owner overrides by hand in time. Each held case also uses capacity permanently (M-2).

**Fix.** Keep "never auto-vote toward the requested side" and stop a single flag from freezing the case:
- Require a quorum of flags (for example `injectionFlags >= 2`) for a permanent hold. A single flag starts a mandatory owner-review window instead.
- Add a per-mandate injection policy: `Hold`, or `CastAgainst` / `CastAbstain` after the window. A proposal that tries to manipulate AI voters is a reasonable signal for AGAINST.
- Alert the owner off-chain on every Held case, with the deadline taken from `voteEnd`.

---

## M-4. Compound Bravo governors never receive a vote

**Resolution (2026-11-19): fixed.** `state`, `hasVoted` and `castVoteWithReason` are low-level calls; empty return data from the cast is accepted (weight recorded as 0) and a missing `hasVoted` falls through. `MockGovernor`'s Bravo mode now returns nothing. Tests: `BravoGovernor.t.sol` (green), `Delegate.t.sol::test_bravoEmptyReturn_recordsZeroWeight`, `test_governorWithoutStateFunction_reportsUnavailable`.

**Location.** `src/interfaces/IGovernorLike.sol:13` (declares `returns (uint256)`), `src/Delegate.sol:128`.

**Problem.** Compound `GovernorBravoDelegate.castVoteWithReason` returns nothing. A `try ... returns (uint256 weight)` that succeeds with empty returndata fails to decode in the caller's frame, and `catch` does not catch decode failures. The whole `cast` reverts, which rolls back the vote the governor just recorded. The proxy logs a billed `CallbackFailure`, no acknowledgement arrives, the reactive contract resends until `maxAttempts`, and the case ends `Failed`. The NatSpec says Bravo is supported. The existing `MockGovernor.bravoLike` mode still returns a `uint256`, so the tests do not catch this.

**Fix.** Use a low-level call and accept empty returndata. For Bravo, read the vote with `getReceipt(proposalId, voter).hasVoted` instead of `hasVoted`:

```solidity
(bool ok, bytes memory ret) =
    governor.call(abi.encodeCall(IGovernorLike.castVoteWithReason, (proposalId, support, reason)));
if (ok) {
    uint256 weight = ret.length >= 32 ? abi.decode(ret, (uint256)) : 0;
    _record(r, governor, proposalId, support, weight);
    emit Cast(caseId, governor, proposalId, seq, support, weight);
} else {
    emit CastRevertData(caseId, seq, ret);
    _refuse(caseId, seq, Refusal.CastReverted, st);
}
```

Also make `MockGovernor`'s Bravo mode return nothing.

---

## M-5. Operator config has no safety floors and applies to cases in flight

**Resolution (2026-11-19): fixed, operator role documented.** `setConfig` floors: quorum >= 2, minAgreeing >= 2, minConfidenceBps >= 5000, injectionFlagsToHold in 1..quorum, vetoWindow >= `MIN_VETO_WINDOW` (immutable constructor argument, deploy script requires it, 300 s or more live). The config is snapshotted per case at creation (`caseConfig(caseId)`). Operator and mandate owner should be the same person; the deploy env defaults them to the same address and docs/LIMITS.md says so. Tests: `test_M5_configFloors`, `test_M5_configIsSnapshottedPerCase`.

**Location.** `src/MandateReactive.sol:380-391`. `script/DeployMandate.s.sol` deploys with `MANDATE_OPERATOR` and `MANDATE_OWNER` as separate roles.

**Problem.** `setConfig` accepts `vetoWindow = 0`, `quorum = 1`, `minConfidenceBps = 0` and `majorityBps = 5000`. The operator, who the constructor NatSpec says "holds no vote power", can set quorum 1 and window 0. One juror verdict then casts a vote on the next tick with no chance to veto. The new values apply to open cases at their next evaluation. Operator plus one juror key moves a vote. If operator and mandate owner are different people, this breaks the two-party model.

**Fix.** Enforce floors in `setConfig`: `quorum >= 2`, `vetoWindow >= 5 minutes`, `minConfidenceBps >= 5000`. Snapshot the config into the case when it opens. Also either require operator == mandate owner, or make tally-relevant settings Docket-owner actions that reach the reactive contract as Docket events, like veto and override.

---

## M-6. Unthrottled proposal spam drains lREACT, Docket ETH, Delegate ETH and juror quotas

**Resolution (2026-11-19): per-governor rate limit chosen.** `setGovernorLimits(chainId, governor, maxActive, maxPerHour)` uses a rolling hour per governor. A proposer allowlist was rejected: the demo must let a judge propose without a wallet, and on real DAOs the proposer threshold is the governor's own policy. The relayer per-IP limit and the runway monitor belong to the web and ops layers and are listed in docs/LIMITS.md. Test: `test_M6_perGovernorRateLimit_resetsHourly`.

**Location.** `src/demo/DemoGovernor.sol:30` (threshold 0). `src/MandateReactive.sol:470` (the proposer is parsed and then discarded). `:489-499` (every accepted proposal costs a react, an `openCase` callback at 500k gas billed to the Docket, three juror inferences and transactions, three Verdict reacts, cron ticks, and cast callbacks billed to the Delegate).

**Scenario.** A script calls `propose` in a loop on Base Sepolia, where gas is free. Each proposal costs the system several times what it costs the attacker. The reactive contract, Docket and Delegate run out of funds, and an indebted contract silently gets no service (spec 7.9). The free-tier juror quotas run out first. This ends the evidence run the spec warns about.

**Fix.** `react()` cannot read the proposer's voting power, so use the parsed `proposer` directly: add a per-governor proposer allowlist or a per-governor rate limit (`maxCasesPerHour`) inside `_onProposalCreated`. On the demo DAO, set a non-zero `proposalThreshold` and route the public "create a proposal" button through a relayer with a per-IP limit. Add the runway monitor from spec 7.18.

---

## Low

**L-1. Veto latency at window close.** `src/MandateReactive.sol:672` and `:732`. The window end is measured on Reactive time. A veto sent in the last seconds reaches the reactive contract only after it is included on Base and processed by Reactive. The cast may already be requested by then. After H-1 the vote is stopped if it has not landed yet, but a fast cast can still beat the veto. Fix: the UI should stop presenting the veto as effective at `endsAt - margin`. The contract could instead add a grace period equal to the measured log latency before it casts. *Resolution: not fixed; documented in docs/LIMITS.md (UI must stop presenting the veto as effective near `endsAt`).*

**L-2. `StateUnavailable` is documented as a retry but finishes as `Failed`.** `src/interfaces/IDelegate.sol:7` and `src/MandateReactive.sol:633-635`. A transient RPC or governor failure kills the case. Fix: route `StateUnavailable` to `_defer`, the same way as `NotYetActive`. *Resolution: fixed. `StateUnavailable` defers like `NotYetActive` (bounded by `caseTtl`). Test `test_L2_stateUnavailable_retriesInsteadOfFailing`.*

**L-3. A weight step near 2^32 makes `react()` revert on veto or override.** `src/MandateReactive.sol:397`, `:775`, `:777`. `step` has no upper bound, so `w + bounds.step` or `bounds.min + bounds.step` can overflow `uint32`. `_onVeto` then reverts, the veto is never processed, and the vote goes out. Only the owner can set this. Fix: `require(bounds_.step <= bounds_.max - bounds_.min)`. *Resolution: fixed. Weight arithmetic in `uint256`, `step <= MAX_WEIGHT`. Test `test_L3_hugeWeightStep_doesNotRevertOwnerActions`.*

**L-4. A misdeclared clock fails silently.** `src/MandateReactive.sol:799-815`. Declaring `Timestamp` for a block-clock governor compares a block number of about 2e7 with a time of about 1.8e9, and every case expires without a vote. Declaring `BlockNumber` with a block time for a timestamp governor computes an ETA weeks out and keeps cron billing until `caseTtl`. Fix: have the Delegate report `clock()` and `CLOCK_MODE()` in its acknowledgement, or have the deploy script read `CLOCK_MODE()` and refuse a mismatch. *Resolution: not fixed; documented in docs/LIMITS.md (the wiring script runs on Lasna and cannot read the governor's `CLOCK_MODE`; declare it from the governor's verified source).*

**L-5. Cron stays on for the whole voting delay.** `src/MandateReactive.sol:804-813`. One deferred case keeps the cron subscription billed every tick until voting opens. That can be days on a real DAO, up to `caseTtl`. Under spam (M-6), cron never switches off. Fix: pick a long cron interval per deployment, and for long delays switch to a slower cron topic while the earliest `dueAt` is far away. *Resolution: not fixed in code; Cron100 is the deploy default and cron is off whenever nothing is timed. Documented in docs/LIMITS.md.*

**L-6. The demo faucet allows unlimited supply through Sybil addresses.** `src/demo/DemoVotesToken.sol:62-68`. The cooldown is per address, so fresh addresses mint without limit. An attacker can outvote the Delegate on any demo proposal, or inflate the total supply so that `quorumFraction` is never met. Demo-only. Fix: cap the total faucet supply, or use relayer-gated claims. *Resolution: fixed. `MAX_FAUCET_SUPPLY` lifetime cap (10M tokens). Test `test_L6_faucetLifetimeCap`.*

**L-7. `setDelegate` mid-flight.** `src/MandateReactive.sol:363-377`. This is documented. Acknowledgements from the old Delegate are unsubscribed, so its votes land but the cases end `Failed`. Fix: refuse while any case on that chain is `Casting`. *Resolution: fixed. `setDelegate` reverts `DelegateInUse` while any case on that chain is timed. Test `test_L7_setDelegate_refusedWhileChainHasTimedWork`.*

**L-8. `withdraw` is unbounded; `renounceOwnership` is reachable.** `src/MandateReactive.sol:419-423`. The operator can drain the fee reserve and put the contract into debt. Renouncing ownership leaves stuck cases that nobody can close. Fix: keep a minimum reserve, and override `renounceOwnership` to revert. *Resolution: fixed. `withdraw` keeps `WITHDRAW_FLOOR` (0.5 native); `renounceOwnership` reverts. Test `test_L8_withdrawKeepsFloor_andRenounceDisabled`.*

## Off-chain trust boundary (JUROR_INTERFACE.md)

**I-1. The rationale location is not on-chain.** Only the hash is committed, both in the verdict and in the vote reason. If the host disappears, the rationale cannot be audited, although it cannot be forged either. Fix: put a content-addressed URI (an IPFS CID) in the rationale field, or emit it. *Resolution: off-chain; passed to the juror worker (content-addressed rationale URI recommended). Listed in docs/LIMITS.md.*

**I-2. Juror independence is not enforced.** Verdicts are public on posting, so a lazy or colluding juror can copy earlier verdicts and add apparent consensus. That makes H-2 and H-3 worse. Fix: commit and reveal (`commit(hash(verdict, salt))`, then reveal once quorum commits exist), or at least measure copy rate in the evaluation. *Resolution: not fixed (commit-reveal would change the Docket ABI and the juror flow); copy rate to be measured in the evaluation. Listed in docs/LIMITS.md.*

**I-3. The proposal text is bound well. Keep the binding checks.** OZ proposal ids hash the content, and the receipt or log fallback is filtered by `governor` plus topic0 and checked against `proposalId`. For Bravo the id is a counter, so the juror must also check `log.address == governor` on the receipt path. The doc already says this. Do not relax it. *Resolution: no change needed; the binding checks stay in docs/JUROR_INTERFACE.md.*

**I-4. Prompt injection is still a risk that remains.** A single flag is fail-safe against a forced vote (see M-3 for what it costs). A text that fools all three models into not flagging and voting the same way is out of scope for on-chain checks. Keep the injection proposals in the evidence set, as the spec requires. *Resolution: accepted risk, listed in docs/LIMITS.md.*

## Checked and fine

- **Forged inputs.** `react()` is `onlySystem` (`:301`). `Docket.openCase` and `Delegate.cast` have both `onlyServiceProvider` and `onlyCallbackSender`. The proxy injects the requesting reactive contract's address (callback-contracts.md), so another reactive contract cannot drive them.
- **Spoofed `ProposalCreated`.** It is dropped unless `(chainId, emitter)` is watched (`:467-468`), and it is checked before parsing. Docket events need `emitter == docket && chainId == docketChainId` (`:307`). `Cast` and `NotActive` need the chain and Delegate pinned in the case (`:611`, `:623`). Cron needs `CRON_EMITTER` on this chain (`:306`).
- **Malformed head data.** `ProposalCreatedHead.read` checks `length >= 288` before every `calldataload`, rejects a dirty proposer word, values over 64 bits, and `end < start`. It never reverts. `opCode` is checked. Offsets are never followed. The other handlers check `opCode` and length before calling `_word`.
- **Replays and duplicates.** Cases are keyed on `(chainId, governor, proposalId)`. Ballots are recorded once per juror. Stale `NotActive` is dropped by seq. The Delegate is idempotent per case.
- **Tally arithmetic.** `support <= 2` is checked before `side[b.support]`. `majorityBps >= 5000` allows at most one winner. `total > 0` because the minimum weight is at least 1. There is no overflow at `MAX_WEIGHT * 16`.
- **Votes after `voteEnd`.** The Delegate votes only when `state() == Active`, so the governor's own clock decides. Reactive-side expiry is only an optimisation.
- **DelegateFactory CREATE2.** The salt is `keccak(msg.sender, reactive)` and the init code includes `owner = msg.sender`. Nobody else can deploy to, or squat, a user's predicted address.
- **Delegate custody.** The Delegate needs no tokens. Owner-only functions are `withdraw`, `withdrawToken`, `delegateHeldVotes` and `setPaused`. `setPaused` is the owner's hard stop and works against every finding above.
