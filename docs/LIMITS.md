# Limits

What Mandate does not protect against, what is untested, and what would have to change before it handles real value. Findings refer to docs/SECURITY_REVIEW.md.

## Trust

- **Jurors are oracles.** A verdict is whatever the registered juror key signs. Quorum (2 by default, 3 on the live deployment) and `minAgreeing` (2) mean one compromised key cannot move a vote alone, but two colluding or identically fooled jurors can. The Docket owner decides who is a juror.
- **Juror independence is not enforced (I-2).** Verdicts are public as soon as they are posted, so a juror can copy earlier ones. Commit-reveal would fix this but changes the Docket ABI and the juror flow; for now the evaluation measures agreement and copy rate instead.
- **Rationale availability (I-1).** Only the rationale hash is on chain. If the host disappears the rationale cannot be audited, although it cannot be forged either. Jurors should publish to a content-addressed location.
- **Operator vs mandate owner (M-5).** The operator (reactive contract owner on Lasna) sets the config within enforced floors: quorum >= 2, minAgreeing >= 2, minConfidence >= 50%, veto window >= the `MIN_VETO_WINDOW` fixed at deploy. It cannot cast or veto. It can still choose a looser policy within those floors, watch extra governors, or close cases. The deploy env sets operator and mandate owner to the same address, and they should stay the same person.

## Injection policy (M-3, I-4)

- With the default `injectionFlagsToHold = 1`, any single juror can stop every automated vote by flagging everything. This is deliberate (fail closed): the owner can override a held case, and held cases now expire instead of consuming capacity for good. A deployment that prefers availability sets the threshold to 2.
- A proposer can still bait the jurors with text addressed to an AI voter, so the case is held and no automated vote is cast. The owner must override by hand before `voteEnd`. An off-chain alert per held case is needed and is not built yet.
- A text that fools every model into not flagging and voting the same way is out of reach of any on-chain check.

## Delivery and timing

- **Cancel race (M-1 residual).** A cancel stops only cast requests that have not executed yet. If an older request executes on the governor chain before the cancel arrives (reordered delivery), the vote stands, and the reactive contract records it as Cast. `Delegate.setPaused` is the owner's hard stop.
- **Veto latency (L-1).** The window closes on Reactive time. A veto sent in the last seconds reaches the reactive contract only after Base inclusion plus Reactive delivery, so the cast may already be out. The UI must stop presenting the veto as effective some margin before `endsAt`. Measured on the live run (docs/FIRST_CASES.md): a veto reached Lasna 1 to 2 s after Base inclusion, and the cast request came 3 to 62 s after the window's end, on the first cron tick; the site stops offering the veto 20 s before `endsAt` (docs/DECISIONS.md).
- **Clock declaration (L-4).** `watchGovernor` trusts the operator's clock mode. A wrong declaration makes timestamp-mode cases expire without voting, or delays block-mode casts by a bad estimate. Read `CLOCK_MODE()` from the governor's verified source before wiring.
- **Cron cost (L-5).** One deferred case keeps cron billed until voting opens. Cron100 is the deploy default; cron turns off whenever nothing is timed.
- **`originTxHash`** is `LogRecord.txHash`. The design assumed it equals the origin transaction hash; on the live run it did in all 15 cases (`CaseCreated` and `CaseOpened` both carry the `propose` transaction, which `make verify` re-checks). Jurors keep a log-scan fallback for a deployment where it does not.
- **Local timing is not real latency.** All tests run in one EVM.

## Capacity and spam (M-2, M-6)

- The global cap is 128 non-terminal cases. Stale cases expire after `caseTtl` (or after `voteEnd` on a timestamp governor), by an oldest-first sweep of 4 per reaction or by anyone calling `expireStale`. A burst of fresh spam can still fill the cap until those cases go stale, so every public governor must be given `setGovernorLimits` values (for example `maxActive` 32 and `maxPerHour` 20 on the demo DAO).
- `react()` cannot see the proposer's voting power, so a governor with threshold 0 can be spammed. The rate limit bounds the cost; the web app's "create a proposal" button needs a per-IP relayer limit, and a runway monitor for lREACT, Docket ETH and Delegate ETH is still to be built.
- The demo faucet has a lifetime cap, but within it Sybil addresses can still out-vote the Delegate on demo proposals. This is demo-only.

## Gas headroom (measured in the harness)

- Worst cron tick (24 cases scanned, 4 callbacks): 657,568 gas of the 900,000 cap. ProposalCreated: 368k to 379k, flat from 10 B to 30 KB of description. The mock system contract emits callback requests as events; the real one may cost more per request, so re-measure on Lasna with `get_rc_health` and traces.
- Destination peak (openCase or cast): 166,689 gas against 370,000 forwarded after the proxy's 130k reserve.

## Not built

- Multi-mandate (one reactive contract serves one mandate).
- Mainnet radar (wildcard `ProposalCreated` subscription).
- Commit-reveal for verdicts.
