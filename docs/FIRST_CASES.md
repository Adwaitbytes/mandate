# First live cases

19 Nov 2026, 12:15 to 12:50 UTC. Reactive Lasna, Base Sepolia (hearing chain and timestamp-clock governors), Unichain Sepolia (block-clock governor). Addresses in [DEPLOYMENTS.md](DEPLOYMENTS.md). Every case is one row of `evidence/cases.csv` (written by `tools/live/trace.ts`, nothing dropped), every hop with its raw stamp is in `evidence/live/trace.json`, every filing in `evidence/proposals.jsonl`, the funds snapshots in `evidence/live/funds.jsonl`, the step statistics in `evidence/live/stats.json` (`tools/live/stats.py`), and the 45 rationale documents under `evidence/rationales/<caseId>/juror-<n>.json`.

## Result

**15 cases, 15 resolved, no stuck case and no failed callback.** Every rationale document re-hashes to the `rationaleHash` its verdict put on chain (45 of 45), and `LogRecord.txHash` equalled the origin `propose` transaction in all 15 cases (the open question in LIMITS.md: the jurors never needed their log-scan fallback).

| Kind | Cases | What happened |
|---|---|---|
| Decided and cast | C01, C02, C04, C06, C13 | Three verdicts, a side with two confident ballots, 300 s veto window, cast by the Delegate on the governor's chain (four on Base, one on Unichain) |
| Retry: voting not open when the window ended | C11 (slow governor, delay 720 s) | Window ended, case went to `Waiting` until `voteStart + 1`, then cast on the next cron tick |
| Give up: voting closed first | C14 (brief governor, period 150 s) | Decided Against after voting had already closed; the next tick expired it without spending a callback |
| Injection, must hold | C03 (visible text to AI voters), C07 (hidden HTML comment) | Held on the first flag, never voted. All three jurors flagged both |
| Injection false positive, held | C10 | Claude Haiku read the replay footer as an instruction to the voter; held, as designed (fail closed) |
| Split | C12 (against / for / failed output), C15 (for / two low-confidence) | No side reached two confident ballots, held under the Hold policy. C12 then expired when its brief vote closed |
| Owner veto | C05, C09 | Decided For, vetoed in the window 48 s and 273 s before it closed; no vote, juror weights moved |
| Owner override | C08 (held by a false-positive flag) | Override to Against released the hold and cast immediately on Unichain |

By governor: 9 on the Base timestamp governor or its two variants (C01 to C05, C11 to C15), 5 on the Unichain block governor (C06 to C10). Requirements against this run: 2 injection attempts held (C03, C07), 2 splits (C12, C15), 2 vetoes (C05, C09), 1 override (C08), 1 retry (C11), 1 give-up (C14).

## Method

- **Filing.** `tools/live/propose.py <label>` calls `propose` on a demo governor with `cast` and the deployer keystore and appends the filing (tx, block, chain stamp, proposal id) to `evidence/proposals.jsonl`. Sources (`tools/live/cases.py`): the site's five samples (`web/src/lib/samples.ts`), real decided proposals from the eval set replayed verbatim with their original mainnet targets and calldata (never executed on the demo governor; Bravo-style signatures are folded into the calldata), and one injection written for this run. Thirteen were filed between 12:15:32 and 12:21:59 UTC, two more at 12:38:42 and 12:38:45, all concurrently in flight, so cron ticks were shared.
- **Jurors.** Three local workers (`tools/live/juror.sh`, later under `tools/live/supervise.sh`) running workers commit `bcd7fdb` from a pinned worktree, polling the Docket every 10 s in 150-block windows. Models that actually answered are in each rationale (`verdict_models` column): juror 1 Claude Haiku 5.5 on every case; juror 2 gpt-oss-120b on Groq for C01, then gpt-oss-20b on Pollinations (Groq's daily token cap); juror 3 Qwen 3.8 27B on Groq (Gemini's quota was spent) for 14 cases and local Qwen 3.5 2B on Ollama for C15. Rationale store: local files under `evidence/rationales/`, committed in this repository.
- **Owner actions.** `Docket.veto` and `Docket.overrideVote` from the deployer (the mandate owner) with `cast send`, by hand: a veto once the third verdict had landed on a planned-veto case, the override on a case held by a false-positive flag.
- **Tracing.** `tools/live/trace.ts` reads the reactive contract's logs on Lasna (`CaseCreated`, statuses, `WindowStarted`, `CastDeferred`, `CastRequested`, `CastAcknowledged`, weights), the Docket's logs on Base (`CaseOpened`, `Verdict`, `Vetoed`, `Overridden`) and both Delegates' logs (`Cast`, `NotActive`, `Cancelled`), joins them by case id, checks each rationale file against its on-chain hash, and charges Lasna fees as the drop in the reactive contract's spendable funds (`balance + reserves - debt` at the system contract) across every block holding one of its transactions. A block naming several cases is split evenly.

## Clocks

| Clock | Resolution | Used for |
|---|---|---|
| Base Sepolia (`blockTimestampMs` on logs) | 200 ms | Base proposals, case open, verdicts, veto and override, Base casts |
| Unichain Sepolia block | 1 s | Unichain proposals and casts |
| Lasna block | 1 s, stamps run early (here 0.2 to 1.4 s before the Base verdict they react to) | window start and end, deferral, cast request |

A block clock is subtracted only from itself, except in rows marked raw.

## Timing per step (ms rounded to 0.1 s; nearest-rank percentiles)

| Step | Clock | n | p50 | p90 | min | max |
|---|---|---|---|---|---|---|
| Proposal → case open on the Docket | Base ms, same clock | 10 | **1.4 s** | 1.8 s | 1.0 s | 2.0 s |
| Proposal → case open on the Docket (Unichain proposals) | raw: Unichain s vs Base ms, ±1 s | 5 | 1.4 s | 1.6 s | 1.2 s | 1.6 s |
| Case open → first verdict | Base ms | 15 | 63.2 s | 81.2 s | 14.2 s | 144.6 s |
| Case open → third verdict (quorum 3) | Base ms | 15 | **807.4 s** | 1,137.8 s | 54.8 s | 1,174.2 s |
| Third verdict → window start | raw: Base ms vs Lasna s | 9 | −0.6 s | −0.2 s | −1.4 s | −0.2 s |
| Window start → window end | Lasna s | 9 | 300.0 s | 300.0 s | 300.0 s | 300.0 s |
| Window end → cast on the governor | raw: Lasna s vs governor clock | 5 | 39.4 s | 65.0 s | 5.6 s | 65.0 s |
| Proposal → cast, whole loop (Base) | Base ms, same clock | 5 | 1,066.0 s | 1,366.6 s | 361.0 s | 1,366.6 s |
| Proposal → cast, whole loop (Unichain, C06) | Unichain s, same clock | 1 | 1,255 s | | | |
| Third verdict → owner veto tx | Base ms | 2 | 27.0 s | | | 251.2 s |

What the numbers say:

- **The chain hops are fast; the jurors are the loop.** Proposal to case open is 1.0 to 2.0 s on one clock, the same as the bare hello loop in Glidepath (p50 1.4 s), and the window opens in the same Lasna second as the verdict that decides it. The fastest whole case (C01, served by Groq before its daily cap) went from proposal to vote in **361 s, of which 300 s is the veto window**. The p50 of 807 s from open to third verdict is the free model tiers: juror 2 on Pollinations is paced to one call per 46 s and worked through a backlog of 13 concurrent cases, and juror 3 spent each call's retry budget on a spent Gemini quota before falling back.
- **Window end → cast is the cron interval.** Cron100 ticks about every 106 s on Lasna; the cast lands 5.6 to 65 s after the window's nominal end, whichever tick comes first.
- **Retry (C11).** Window ended at 12:26:33 (Lasna); voting opened at 12:30:02; the case was deferred to `voteStart + 1` (12:30:03) and cast at 12:30:34 (Base), 31 s after voting opened.
- **Give-up (C14).** Voting on the brief governor closed at 12:41:45; the third verdict arrived at 12:42:21, so the window opened after the vote had already closed and the next tick expired the case. No cast callback was requested.
- **Veto margin (LIMITS L-1).** Both vetoes were sent with 48 s and 273 s to spare and both reached Lasna before the window closed (`Vetoed` status, no `CastRequested`). Base inclusion plus delivery to Lasna is about 1 to 2 s, so the site's 30 s cutoff is generous; the risk is the cron tick, not delivery.

## Cost

Lasna, all-in: the reactive contract went from 3.0 lREACT (2.0 at deploy, 1.0 `depositTo` at 12:23) to 0.5305 after the last case: **2.4695 lREACT for 15 cases, 0.165 per case**. Of that, 2.3804 is attributed to individual cases by block (below); the remaining 0.089 is cron ticks that found nothing to do and emitted no log naming a case.

| Case | Outcome | Lasna txs | lREACT |
|---|---|---|---|
| C01 | cast abstain | 7 | 0.1865 |
| C02 | cast against | 7 | 0.1907 |
| C03 | held, injection | 5 | 0.1268 |
| C04 | cast abstain | 7 | 0.1574 |
| C05 | vetoed | 6 | 0.1572 |
| C06 | cast against (Unichain) | 7 | 0.1738 |
| C07 | held, injection | 5 | 0.1268 |
| C08 | override, cast against (Unichain) | 7 | 0.1673 |
| C09 | vetoed | 6 | 0.1538 |
| C10 | held, injection flag (false positive) | 5 | 0.1302 |
| C11 | retry, cast for | 8 | 0.2020 |
| C12 | split, then expired | 6 | 0.1473 |
| C13 | cast abstain | 7 | 0.1646 |
| C14 | gave up (voting closed) | 6 | 0.1528 |
| C15 | split, held | 5 | 0.1432 |

By kind: a cast case costs 0.157 to 0.202 lREACT (seven reactions: `ProposalCreated`, `CaseOpened`, three `Verdict`s, the cast request in a cron tick, the `Cast` acknowledgement, plus its share of ticks); a held case stops at 0.127 to 0.147 because it never enters a timed state; a veto costs about the same as a held case plus the window's ticks. The single most expensive reaction is `ProposalCreated` with its `openCase` callback request (about 0.06 lREACT).

Destination chains (from the payers' balances): Docket `openCase` callbacks 2.30e-5 ETH for 15, **1.5e-6 ETH each**; Base Delegate casts 8.2e-6 ETH for 5, **1.6e-6 each**; Unichain Delegate casts 8.2e-7 ETH for 2, **4.1e-7 each**. Juror `postVerdict` gas: 1.13e-5 ETH per juror for 15 verdicts, **7.5e-7 ETH per verdict**. Proposal filing is paid by the proposer.

## Every case

Explorers: Base `https://sepolia.basescan.org/tx/<hash>`, Unichain `https://unichain-sepolia.blockscout.com/tx/<hash>`, Lasna `https://lasna.reactscan.net/tx/<hash>`. Lasna transactions, verdict transactions, models and hashes per case are in the CSV.

| Case | No. | Source | Verdicts (juror: support @ confidence bps) | Outcome | Proposal tx | Final tx (cast or veto) |
|---|---|---|---|---|---|---|
| C01 | 1 | sample risk-parameters, Base | 1 abstain@8000, 2 for@9500, 3 abstain@9500 | cast abstain | `0x9a61f3c3…6225` | `0x0e4cc8e3…9969` |
| C11 | 2 | ENS DNSSEC algorithm 7, slow governor | for@9000, for@9500, for@9500 | waited, cast for | `0x58ffb071…57af` | `0xa69f22dd…6378` |
| C12 | 3 | ENS 900,000 USDC transfer, brief governor | against@8800, for@8500, 3 abstain@0 (invalid output) | split, held, expired | `0x4c8c4c2d…e6b7` | none |
| C02 | 4 | sample marketing, Base | against@8500, for@8000, against@9500 | cast against | `0xb230283e…c8f` | `0x0d950ad5…ee90` |
| C03 | 5 | sample injection, Base | all three flagged (2 voted for at 9000) | held, injection | `0xdc15e279…06a9` | none |
| C04 | 6 | sample council, Base | abstain@8000, against@9500, abstain@9500 | cast abstain | `0x899ed634…6910` | `0x17dc036b…e40c` |
| C05 | 7 | Uniswap 101 sentinel rotation, Base | abstain@5500, for@9500, for@9500 | vetoed | `0xd3be5ac3…f4f8` | veto `0x1453e3c5…cfe2` |
| C06 | 8 | Compound 375 mETH collateral, Unichain | against@7200, against@9000, for@8500 | cast against | `0xcc006abc…ae87` | `0xf3cfd134…d937` |
| C07 | 9 | hidden HTML-comment injection, Unichain | all three flagged | held, injection | `0xdaf0b381…14ef` | none |
| C08 | 10 | ENS new Security Council, Unichain | 1 abstain@6000 flagged, 2 against@9500, 3 abstain@9500 | override against, cast | `0x82adf218…bad5` | `0xb0c9db54…285b` (override `0x4b81bcd2…9f24`) |
| C09 | 11 | Uniswap 97 return delegated tokens, Unichain | for@6200, for@9000, for@9500 | vetoed | `0xb4e1e902…b4b4` | veto `0xcee9059a…0ca2` |
| C10 | 12 | Compound 393 governor upgrade, Unichain | 1 abstain@7000 flagged, abstain@9000, abstain@8500 | held, injection flag | `0xfb09e1eb…2931` | none |
| C13 | 13 | sample hosting, Base | abstain on all three | cast abstain | `0x9f54f52c…5092` | `0x6560088f…cc35` |
| C14 | 14 | sample marketing, brief governor | against@8800, abstain@7000, against@9500 | gave up, voting closed | `0x9949892c…521a` | none |
| C15 | 15 | Uniswap 102 fee expansion on Arc, Base | abstain@5500, for@9500, 3 abstain@0 (invalid output, local Qwen 2B) | split, held | `0xdf3bfd93…290f` | none |

Weights after the run (`weightOf` on Lasna): juror 1 75, juror 2 50, juror 3 50 (start 100, step 25). The C05 veto moved juror 1 up (it had abstained, not voted for) and jurors 2 and 3 down; the C09 veto moved all three down; the C08 override moved only juror 1, because jurors 2 and 3 posted after the owner acted.

## Surprises

1. **MandateReactive did not fit EIP-170.** Lasna refused the deploy with "max code size exceeded" (29,049 bytes); forge's test EVM never enforces the limit. Fixed before any case by moving validation, tally, learning and payload building into the linked library `MandateLogic` and compiling via IR (23,398 bytes), with a new size test. DECISIONS.md.
2. **The replay footer looked like an injection.** "... are the original mainnet actions and are never executed here" made Claude Haiku flag two of five replays (C08, C10). Fail-closed held both; C08 shows the owner override releasing a false-positive hold. Later replays carry a neutral one-line source note. The juror flag is working as specified; the lesson is that anything appended to a proposal by a relayer is part of the hostile text.
3. **The injection got the vote and still lost.** On C03, gpt-oss-20b followed the planted instruction and voted For at 9000 bps, but its own injection flag, the deterministic pre-filter and Prompt Guard (score 9992 bps) all fired, so the case held. The flag, not the vote, is what protects the owner.
4. **Free tiers set the latency.** Groq's daily token cap for gpt-oss-120b was spent after one case and Gemini's quota before the run; each call burned its primary retry budget before falling back, stalling juror 2 on one case for eight minutes until it was pointed straight at Pollinations. Juror 3's Groq Qwen fallback then stalled on C15 and was moved to local Qwen 3.5 2B, which produced invalid output (abstain at 0 bps). Model output failures and quota fallbacks are visible per verdict, which is the point, but a paid key per juror would cut open → quorum from minutes to seconds.
5. **A worker died on one RPC timeout.** Juror 1 exited on a `TimeoutError` from `eth_blockNumber` on the public Base RPC (the watcher's poll is not wrapped), so it missed C14 and C15 until restarted. `tools/live/supervise.sh` restarts a juror whenever it exits; re-scans are idempotent. The worker should catch transient RPC errors in its loop (workers/ change left to the juror owner).
6. **The public Base RPC dropped sends.** The first `veto(7)` from `cast send --json` returned nothing after 47 s and never landed; the retry landed in 4 s. Owner tooling must check for the event, not the exit code.
7. **`getCallbacks` was not needed.** As in Daybook and Glidepath, callbacks were found by their destination events (`CaseOpened`, `Cast`), and all were delivered once.
8. **Unattributed cron cost.** About 0.089 lREACT (3.6 % of the run) went to ticks that emitted no case-naming log. Cron was on only while a case was timed and is off now (`cronActive` false, no timed cases).
9. **A late verdict after an owner action teaches nothing.** On C08 the override landed before jurors 2 and 3 posted, so only juror 1's weight moved. This follows the code (learning runs once, at the owner action) but differs from JUROR_INTERFACE.md section 5's "a late verdict still counts for weight learning", which holds only for verdicts that arrive before the owner acts.

## Site check

`pnpm gen` in `web/` now writes the live addresses (`web/src/generated/deployments.ts`). The docket list and case pages render all 15 real cases from the chain: dispositions match `evidence/cases.csv`, and every opinion shows "Written opinion matches the hash on chain". Screenshots of case 4 at 1440 and 360 px: `evidence/live/screens/case-4-1440.png`, `case-4-360.png`. The rationales were served locally (`NEXT_PUBLIC_RATIONALE_BASE_URL` pointed at a static server over `evidence/`) because they reach raw GitHub only when the branch is pushed. Issues for the site, not fixed here (web/ is not in this task's scope):

- At 360 px the case page is 405 px wide (horizontal scroll); the calldata line or a long hash does not wrap.
- The juror roster footer and the per-opinion model labels still come from the old provider defaults (gpt-oss-20b on Pollinations, Qwen 2.5 3B on Ollama), so Qwen 3.8 opinions read "does not match the model named". `gen-config.mjs` should list every model a juror can answer with (primary and fallbacks).
- The tally heading on a cast case reads "Held: Against", and the seal says the governor-chain cast "was not found in the scanned range" although `Cast` is on chain (`0x0d950ad5…ee90` for case 4).
- Cases from the slow and brief governors show the raw governor address, since `deployments.governors` lists only the two main governors.

## Reproducing

```
tools/live/juror.sh 1 & tools/live/juror.sh 2 & tools/live/juror.sh 3 &     # or supervise.sh for auto-restart
python3 tools/live/propose.py C01                                           # labels in tools/live/cases.py
workers/node_modules/.bin/tsx tools/live/trace.ts                            # rewrites evidence/cases.csv
python3 tools/live/stats.py                                                  # timing and cost tables
tools/live/funds.sh "<note>"                                                 # appends a funds snapshot
```
