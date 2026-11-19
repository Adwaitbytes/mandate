# Architecture

Mandate turns a written voting policy into votes. A governor emits `ProposalCreated`; a reactive contract on the Reactive Network opens a case on a hearing chain; three model jurors post verdicts; the reactive contract tallies them by weight, waits out a veto window, and casts the vote through the user's Delegate on the governor's chain.

## Chains and contracts

| Contract | Chain | Base | Role |
|---|---|---|---|
| `MandateReactive` | Reactive Lasna (5318007) | `AbstractReactive`, `Ownable2Step` | Trigger, tally, timers, executor, weight learning |
| `Docket` | Base Sepolia (84532) | `AbstractCallback`, `Ownable2Step` | Cases, juror verdicts, veto and override, mandate versions |
| `Delegate` | each governor chain | `AbstractCallback` | Holds the user's delegated votes, casts by callback |
| `DelegateFactory` | each governor chain | none | One Delegate per (user, reactive contract), CREATE2 |
| `DemoVotesToken`, `DemoGovernor` | Base Sepolia (timestamp clock), Unichain Sepolia (block clock) | OpenZeppelin v5.7.0 | Demo DAO, public faucet, threshold 0 |

## The loop

```
Governor (Base/Unichain)        Reactive (Lasna)                    Docket (Base)              Delegate (governor chain)
ProposalCreated ───────────────▶ react: case Opening ──openCase──▶ CaseOpened
                                 react: Open ◀──────────────────── (ack)
                                                                   Verdict x3 (jurors)
                                 react: tally ◀────────────────────
                                   injection -> Held (never auto-votes)
                                   split -> Abstain or Held (owner setting)
                                   decided -> Window (veto window, cron on)
                                 cron tick: window over
                                   -> cast request ─────────────────────────────────────────▶ cast(): state()==Active?
                                 react: Cast ◀───────────────────────────────────────────────── Cast  (vote recorded)
                                 react: Waiting/Expired/Failed ◀──────────────────────────────── NotActive(reason)
                                                                   Vetoed / Overridden (owner)
                                 react: stop or replace vote, move juror weights
```

### Case states (`MandateReactive.Status`)

| Status | Meaning | Timed (cron) | Leaves by |
|---|---|---|---|
| Opening | `openCase` requested | yes: resend after `resendAfter`, fail after `maxAttempts` | `CaseOpened`, or any `Verdict` for the case |
| Open | collecting verdicts | no | quorum, injection, owner action, `closeCase` |
| Held | injection (sticky) or split under the Hold policy | no | split: a later verdict that decides; any: owner override; `closeCase` |
| Window | decided, veto window running | yes: until `dueAt` | tick at window end, veto, override, injection |
| Waiting | voting not open yet | yes: retry at `dueAt` | tick |
| Casting | `cast` requested | yes: resend, fail after `maxAttempts` | `Cast` or `NotActive` with the current `seq`; veto, override or injection hold (with a cancel) |
| Cast, Vetoed, Expired, Failed | terminal | no | a late `Cast` ack moves any status to Cast |

A case with an unacknowledged `Delegate.cancel` stays timed whatever its status (`cancelPending`), so the cancel is resent until `Cancelled` arrives or `maxAttempts` is spent.

Any non-terminal case expires after its `caseTtl`, or after `voteEnd` on a declared timestamp governor. An oldest-first sweep closes up to 4 stale cases on every `ProposalCreated` and every tick, and anyone can call `expireStale(ids)`.

Cron is subscribed exactly while at least one case is timed (`_syncCron` after every reaction and admin call). A tick scans at most 24 timed cases from a rotating cursor and requests at most 4 callbacks; the rest wait for the next tick. Worst measured tick in the harness: 657,568 gas against the 900,000 cap.

### Tally

The configuration is snapshotted per case when it opens (`caseConfig(caseId)`), so later changes never affect a case in flight. On each verdict:

1. Injection flags are counted in every status. At `injectionFlagsToHold` flags (default 1) the case is held for good, unless the owner overrides it; a cast in flight is cancelled.
2. While the case is Open, Held (split) or Window: fewer than `quorum` verdicts means wait.
3. Each verdict's weight goes to its side if `confidenceBps >= minConfidenceBps`, otherwise to a low-confidence bucket. The denominator is all posted weight.
4. A side wins only if it has at least `minAgreeing` confident ballots **and** `sideWeight * 10000 > totalWeight * majorityBps`. Weight can block a side but never carry one alone.
5. No winner: `splitPolicy` Abstain decides "abstain", Hold parks the case for the owner.
6. The first decision opens the veto window. A changed decision restarts it in full (`WindowStarted` again).

Floors enforced by `setConfig`: quorum >= 2, minAgreeing >= 2 (<= quorum), minConfidence >= 5000, injectionFlagsToHold 1..quorum, vetoWindow >= `MIN_VETO_WINDOW` (immutable, set at deploy).

### Governor clocks

`voteStart` and `voteEnd` are in the governor's ERC-6372 clock. The Delegate is the authority: it asks `state(proposalId)` and answers Pending as `NotYetActive` and every later state as `Ended`, so block-number and timestamp governors (and Governor Bravo, which shares the selector and enum order) need no special case. The reactive contract only uses the bounds to avoid wasted callbacks when the operator declared the clock with `watchGovernor`:

- Timestamp governor: wait until `voteStart + 1`, give up locally after `voteEnd`.
- Block governor with a declared block time: estimate when block `voteStart + 1` arrives from the origin block and wait until then. Never used to give up.
- Unknown: ask the Delegate and retry `NotYetActive` every `retryAfter`.

### Delivery guarantees

Delivery is treated as at least once and possibly out of order.

- Every callback carries a per-case `seq`; both destination functions are idempotent per `caseId` and re-emit their acknowledgement on a duplicate.
- Every request has an acknowledgement event the reactive contract subscribes to (`CaseOpened`, `Cast`/`NotActive`, `Cancelled`). A missing one triggers a resend on a later tick.
- A `NotActive` for an older `seq` is ignored. A `Cast` for any `seq` is accepted, because the vote is on the governor.
- The Delegate refuses any cast request older than the newest one it processed or the newest cancel (`minSeq`, refusal `Superseded`). A veto, an override that changes the support, or an injection hold sends a cancel whenever a cast request may still be in flight. A request that already executed cannot be undone (docs/LIMITS.md).
- A `Verdict` that arrives before `CaseOpened` counts as the open acknowledgement.
- `react()` never reverts to filter. Every handler checks `opCode`, data length, the emitting chain and address, and returns early.

### Weight learning

After a veto (if the case had a decision) or an override, each juror that ruled on the case moves one `step` toward the owner if it agreed and one step away if not, clamped to `[min, max]`. Veto: agreed means the juror's support differs from the vetoed decision. Override: agreed means equal to the owner's support. One owner action per case (enforced on the Docket and again on Reactive).

## Functions

### MandateReactive (owner = operator on Lasna)

| Function | Notes |
|---|---|
| `react(LogRecord)` | `onlySystem`. Routes ProposalCreated, cron, Docket and Delegate events |
| `setDocket(chainId, docket)` | once; subscribes CaseOpened, Verdict, Vetoed, Overridden |
| `watchGovernor(chainId, governor, clock, blockTimeMs)` / `unwatchGovernor` | subscribes/unsubscribes ProposalCreated for one governor |
| `setGovernorLimits(chainId, governor, maxActive, maxPerHour)` | per-governor caps, 0 = off |
| `setDelegate(chainId, delegate)` | swaps Cast, NotActive and Cancelled subscriptions; refused while that chain has timed cases |
| `setConfig(Config)` / `setWeightBounds(WeightBounds)` | validated with floors; applies to cases opened afterwards |
| `closeCase(caseId)` | operator cleanup to Expired |
| `expireStale(ids)` | anyone; expires cases past TTL or past `voteEnd` (timestamp governors) |
| `coverDebt()` | open to anyone |
| `withdraw(amount, to)` | owner, keeps `WITHDRAW_FLOOR`; `renounceOwnership` is disabled |
| views | `getCase`, `caseConfig`, `ballotOf`, `caseIdOf`, `watchOf`, `weightOf`, `timedCases`, `config`, `weightBounds` |

Constructor: `(owner, cronTopic, minVetoWindow)`. Defaults: quorum 2, minAgreeing 2, injectionFlagsToHold 1, minConfidence 6000, majority 5000, split Hold, maxAttempts 3, vetoWindow max(600 s, minVetoWindow), resendAfter 180 s, retryAfter 60 s, caseTtl 14 days, openCase gas 500k, cast gas 600k, weights 25/100/400 step 25.

Events: `DocketSet`, `GovernorWatched`, `GovernorLimitsSet`, `GovernorUnwatched`, `DelegateSet`, `ConfigUpdated`, `WeightBoundsUpdated`, `ProposalSkipped`, `CaseCreated`, `CaseStatusChanged`, `OpenCaseRequested`, `BallotRecorded`, `TallyUpdated`, `CaseHeld`, `WindowStarted`, `DecisionChanged`, `CastDeferred`, `CastRequested`, `CastAcknowledged`, `CastRefused`, `CancelRequested`, `CancelAcknowledged`, `CancelAbandoned`, `OwnerActionTooLate`, `WeightsUpdated`, `CronToggled`.

### Docket (owner = mandate owner)

| Function | Notes |
|---|---|
| `openCase(rvm, caseId, seq, originChainId, governor, proposalId, voteStart, voteEnd, originTxHash, delegate)` | `onlyServiceProvider` + `onlyCallbackSender(rvm)`, idempotent |
| `postVerdict(caseId, support, confidenceBps, rationaleHash, modelIdHash, promptHash, injectionFlag)` | registered jurors, once per case |
| `veto(caseId)` / `overrideVote(caseId, support)` | owner, one action per case (`override` is a Solidity keyword) |
| `setMandate(hash, uri)` | owner, new version |
| `addJurors(address[])` / `removeJurors(address[])` | owner, max 16 |
| `coverDebt()` | open |

Events: `CaseOpened`, `Verdict`, `Vetoed`, `Overridden`, `MandateSet`, `JurorAdded`, `JurorRemoved`. Juror-facing detail is in `docs/JUROR_INTERFACE.md`.

### Delegate (owner = the user)

| Function | Notes |
|---|---|
| `cast(rvm, caseId, seq, governor, proposalId, support, reason)` | `onlyServiceProvider` + `onlyCallbackSender(rvm)`; never reverts for the authorised sender; emits `Cast` or `NotActive(reason)`; refuses `seq < minSeq[caseId]`; low-level governor calls (Bravo returns nothing) |
| `cancel(rvm, caseId, seq)` | both guards; raises `minSeq`, emits `Cancelled` (and re-emits `Cast` if the vote already landed) |
| `setPaused(bool)` | kill switch; casts are refused with `Paused` |
| `withdraw(amount, to)`, `withdrawToken`, `delegateHeldVotes` | owner; revoking delegation of wallet-held tokens is done on the token |
| `coverDebt()` | open |
| `receiptOf(caseId)` | vote receipt |

Refusal codes: NotYetActive and StateUnavailable (retry), Ended (give up), Superseded (ignored), Paused, CastReverted, InvalidSupport (fail).

## Topics

| Event | topic0 |
|---|---|
| ProposalCreated (OZ and Bravo) | `0x7d84a6263ae0d98d3329bd7b46bb4e8d6f98cd35a7adb45c274c8b7fd5ebd5e0` |
| Docket CaseOpened | `0x79d9758f99914c16528a06bcd2888950a224c5858485987de97ffb82647a16b2` |
| Docket Verdict | `0xebc8826e093d1ceefd93fc69c4f9fd33fdd4bdfdeba4d4ddb3403597f3431e60` |
| Docket Vetoed | `0x2ae00ba9813199478b6f22f0c9b606daa70f8efc319c8d2fa6af63f66ea31763` |
| Docket Overridden | `0x513253cb96c7552e4aa3f5e37d993053c957a21d0ade8ef9e71a0bbaa4ce1bb7` |
| Delegate Cast | `0x1b72dfea265a8d128dced81c2abe75b738f270c555c03cad9b5ae2c1047d3035` |
| Delegate NotActive | `0x418824beda2876be441b358111bdb9eb89c2dced24159b8a56e5bda8e13a4830` |
| Delegate Cancelled | `0xa761582a460180d55522f9f5fdc076390a1f48a7a62a8afbd45c1bb797948edb` |
| Cron100 (deploy default) | `0xb49937fb8970e19fd46d48f7e3fb00d659deac0347f79cd7cb542f0fc1503c70` |

## Deployment order

1. `DeployReactive` on Lasna (payable constructor funds it).
2. `DeployHearing` on Base Sepolia: Docket with the Base Sepolia proxy and the reactive address; jurors; first mandate.
3. `DeployGovernorChain` on Base Sepolia (timestamp) and Unichain Sepolia (blocks): token, governor, factory, the user's Delegate (funded), faucet delegated to it.
4. `WireReactive` on Lasna: `setDocket`, `watchGovernor`, `setDelegate`.

All scripts read every value from env (`contracts/.env.example`), check the chain id, and sign with `--account omni-deployer`. `make deploy-reactive`, `make deploy-hearing`, `make deploy-governor`, `make wire`.

## Local Omni harness (`contracts/test/harness`)

- `MockSystemContract`, etched at `0x8888…8888`: records subscriptions, enforces the at-least-one-criterion rule, makes a mismatched `unsubscribe` a counted silent no-op, ignores callbacks under 100k gas, runs `react()` with a 900k cap and catches reverts, and emits `CallbackRequest` like the real one.
- `MockCallbackProxy`, one per destination chain: overwrites the first payload argument with the requesting reactive contract, withholds 130k gas (the measured `extraGas` + `maxChargeGas` of both testnet proxies), calls the recipient, reports reverts as `CallbackFailure`.
- `Relay`: stamps each registered contract's logs with its chain id, matches them against live subscriptions (equality and wildcards), triggers `react()` as the system contract, delivers `CallbackRequest`s through the right proxy, and repeats until quiet. Tests can hold, drop, duplicate, reorder and replay deliveries and fire cron ticks.

Everything runs in one EVM in one process. Local timing is not real latency.
