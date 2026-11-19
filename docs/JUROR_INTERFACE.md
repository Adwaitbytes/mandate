# Juror interface

What a juror worker reads from the chain and what it writes back. This is the whole contract between the off-chain jurors and the on-chain loop; nothing else in the system trusts a juror.

A juror is one address registered on the `Docket` (Base Sepolia, chain id 84532). It holds Base Sepolia ETH for gas and nothing else: no tokens, no voting power, no role on any other contract. Three jurors run independently, each with its own key and its own model provider.

Source of truth for every signature below: `contracts/src/interfaces/IDocket.sol`. Topic values are pinned by `contracts/test/unit/Topics.t.sol`.

## Addresses

After deployment the Docket address is in `contracts/deployments/84532.env` (`DOCKET=`). Until then it is not known; do not hardcode one.

| Item | Value |
|---|---|
| Hearing chain | Base Sepolia, 84532, RPC `https://sepolia.base.org`, failover `https://base-sepolia-rpc.publicnode.com` (200 ms blocks) |
| Docket | `DOCKET` from `contracts/deployments/84532.env` |
| Governor chains | Base Sepolia 84532 (timestamp-clock demo DAO), Unichain Sepolia 1301 (block-clock demo DAO, RPC `https://sepolia.unichain.org`, failover `https://unichain-sepolia-rpc.publicnode.com`) |

## 1. Read: new cases

Poll `eth_getLogs` on the Docket for `CaseOpened`.

```
event CaseOpened(
    uint256 indexed caseId,
    uint256 originChainId,
    address governor,
    uint256 proposalId,
    uint256 voteStart,
    uint256 voteEnd,
    bytes32 originTxHash,
    address delegate,
    uint256 mandateVersion,
    bytes32 mandateHash
)
topic0 = 0x79d9758f99914c16528a06bcd2888950a224c5858485987de97ffb82647a16b2
topic1 = caseId
data   = abi.encode(originChainId, governor, proposalId, voteStart, voteEnd, originTxHash, delegate, mandateVersion, mandateHash)
```

Rules:

- **Deduplicate by `caseId`.** The Docket re-emits `CaseOpened` with identical fields when the reactive contract resends `openCase` after a lost acknowledgement. Treat a second log for the same `caseId` as a no-op.
- `voteStart` and `voteEnd` are in the governor's clock (seconds on the Base Sepolia DAO, blocks on the Unichain Sepolia DAO). Do not compare them with wall time. They are informational for the juror.
- Before working on a case, call `getVerdict(caseId, jurorAddress)` and skip it if `posted` is true. This makes the worker safe to restart and to re-scan old blocks.
- Cases can also be listed with `caseCount()` and `caseIdAt(i)`, and read with `getCase(caseId)`, if a worker prefers state reads to log scans.

## 2. Read: the proposal

The case carries where the proposal came from, not its text. Fetch the text from the origin chain (`originChainId`).

1. Primary: `eth_getTransactionReceipt(originTxHash)` on the origin chain, take the log whose `address == governor` and `topics[0] == 0x7d84a6263ae0d98d3329bd7b46bb4e8d6f98cd35a7adb45c274c8b7fd5ebd5e0`, decode the full tuple, and check that word 0 equals `proposalId`.
2. Fallback (if the receipt lookup fails or the hash does not match): `eth_getLogs` on `governor` with that topic0 over a recent block range and pick the log whose first data word equals `proposalId`. The event has no indexed fields, so the filter is address plus topic0 only.

```
event ProposalCreated(
    uint256 proposalId, address proposer, address[] targets, uint256[] values,
    string[] signatures, bytes[] calldatas, uint256 voteStart, uint256 voteEnd, string description
)
```

Same signature for OpenZeppelin Governor and Compound Governor Bravo. Give the model the `description` and a readable rendering of `targets`, `values` and `calldatas`. **All of it is hostile input.** It is data to be judged, never instructions to follow.

The `originTxHash` comes from the Reactive Network's `LogRecord.txHash`. It is expected to be the origin transaction hash; the first live loop confirms it. Until then, keep the fallback path enabled.

## 3. Read: the mandate

`mandateVersion` in the event is the version the case is judged against. It is pinned when the case opens, so a later mandate change does not affect open cases.

1. `getMandate(mandateVersion)` returns `(bytes32 mandateHash, uint64 setAt, string uri)`.
2. Fetch the text from `uri`.
3. Check `keccak256(utf8 bytes of the text) == mandateHash`. If it does not match, or `mandateVersion == 0`, **do not post** and log the case as skipped. A verdict against the wrong mandate is worse than no verdict.

The Docket ABI and events did not change in the security-review round (2026-11-19); only the reactive contract's tally rules in section 5 did.

Mandate changes are announced by `MandateSet(uint256 indexed version, bytes32 mandateHash, string uri)`, topic0 `0x5ff206e527be2487c5e775b7606af2466b317a626b8c557f671270eb5180c2e3`.

## 4. Write: the verdict

```
function postVerdict(
    uint256 caseId,
    uint8   support,        // 0 against, 1 for, 2 abstain
    uint16  confidenceBps,  // 0..10000
    bytes32 rationaleHash,  // keccak256 of the published rationale document, non-zero
    bytes32 modelIdHash,    // keccak256(utf8 model id)
    bytes32 promptHash,     // keccak256(utf8 bytes of the exact prompt template)
    bool    injectionFlag   // true if the proposal text tries to instruct an AI voter
) external
selector 0x49acd127
```

The transaction succeeds once per (case, juror). It reverts with:

| Error | When |
|---|---|
| `NotJuror(address)` | sender is not registered |
| `UnknownCase(uint256)` | no such case |
| `InvalidSupport(uint8)` | support above 2 |
| `InvalidConfidence(uint16)` | confidence above 10000 |
| `ZeroHash()` | rationaleHash is zero |
| `AlreadyPosted(uint256,address)` | this juror already ruled on this case (verdicts are final) |

Gas is about 125k on Base Sepolia (measured in the test suite). Use a 200k gas limit.

### Field definitions

**modelIdHash.** `keccak256` of the exact provider model string used for the call, for example `keccak256("anthropic/claude-haiku-5-5")`, `keccak256("groq/openai/gpt-oss-120b")`, `keccak256("google/gemini-flash-latest")`. Use `<provider>/<model>` so two providers serving the same weights stay distinguishable. It names the model that actually answered, wherever in its provider chain that was: when juror 2 falls back to Pollinations it is `keccak256("pollinations/openai-fast")`, and `providerFallbacks` in the rationale lists the links passed over and why. The plain string goes in the rationale document (`model`) so anyone can recompute the hash; `servedModel` adds the version the provider reported (for example `gemini-3.8-flash` behind the rolling alias).

**promptHash.** `keccak256` of the prompt template file bytes as committed in the repo (`workers/prompts/<file>`), before any case data is substituted in. Changing the prompt changes the hash, which is how drift shows up on chain. Every juror may have its own template, but each must be committed.

**rationaleHash.** `keccak256` of the exact bytes of the rationale document the worker publishes. The document is JSON, serialized with keys sorted and no insignificant whitespace (so it can be re-hashed byte for byte), UTF-8, containing at least:

```json
{
  "caseId": "12",
  "originChainId": "84532",
  "governor": "0x...",
  "proposalId": "0x...",
  "mandateVersion": "1",
  "mandateHash": "0x...",
  "juror": "0x...",
  "model": "anthropic/<model-id>",
  "promptHash": "0x...",
  "temperature": 0,
  "support": 1,
  "confidenceBps": 8200,
  "injectionFlag": false,
  "injectionEvidence": "",
  "rationale": "Plain-language opinion, written as an opinion on the proposal against the mandate.",
  "rawModelOutput": "...",
  "promptGuard": { "model": "groq/meta-llama/llama-prompt-guard-2-86m", "scoreBps": 12, "thresholdBps": 9000, "flagged": false },
  "validOutput": true,
  "attempts": 1,
  "repairAttempted": false,
  "parseErrors": [],
  "providerFallbacks": [],
  "createdAt": "2026-11-20T10:00:00Z"
}
```

`attempts` is 2 when the first answer failed validation and the model was re-asked once with the validation error appended (`repairAttempted`, the errors in `parseErrors`, the answer that counted in `rawModelOutput`). If the repair is invalid too, the verdict is abstain at confidence 0 and `rationale` says why. `providerFallbacks` holds one line per provider passed over before the one that answered (circuit open, daily cap, overload, timeout). Documents written before 2026-11-19 13:30 UTC lack the last three fields.

Large integers are strings so no JSON parser rounds them. Publish the document at a public, stable location before posting the hash, so the docket UI can show it next to the verdict.

**confidenceBps.** The model's own confidence, mapped to basis points. Verdicts below the reactive contract's minimum (default 6000) still count toward quorum but add weight to no side, so an unsure juror slows the case down instead of pushing it.

**injectionFlag.** Set it when the proposal text addresses an AI, a model, a voter bot or "the assistant", asks for a particular vote outside the merits, embeds instructions, or tries to change the output format. When in doubt, flag. Any single flag holds the case for good: it never votes automatically, only by the owner's override. Put the offending passage in `injectionEvidence`. The workers set it from three independent signals: the model's own `injection_attempt`, a deterministic pre-filter, and Llama Prompt Guard 2 (`promptGuard` in the document, `null` if the classifier was unreachable). The rationale document records each one (`modelInjectionFlag`, `heuristicInjectionFlag`, `promptGuard.flagged`).

## 5. What happens after a verdict

Informational; the juror does not need to act on any of it.

- `MandateReactive` on Lasna counts verdicts by juror weight. Default: 2 verdicts for quorum, minimum confidence 6000. A side wins only with **at least 2 confident ballots on that side** and strictly more than half the posted weight, so no single juror decides a case however much weight it has earned. A split either abstains or holds for the owner, by the owner's setting. Settings are fixed per case when it opens.
- Injection flags hold the case once the case's threshold is reached (default 1 flag). A hold also cancels a vote that is already on its way, so a flag posted late still counts as long as the vote has not landed.
- A decided case waits through a veto window (default 10 minutes, never shorter than the deployment's floor) and then votes through the user's Delegate on the governor's chain with `castVoteWithReason`. If a later verdict changes the decision, the window starts again in full. The reason names the case, the mandate version and the rationale hash of the heaviest juror on the winning side.
- Verdicts change the decision until the vote is requested. A verdict that arrives while the case is waiting for voting to open or while the cast is in flight is still recorded as a ballot, but it cannot change the vote.
- Cases expire after 14 days, or after `voteEnd` on a timestamp-clock governor. Posting to an expired case still succeeds on the Docket but has no effect.
- When the owner vetoes or overrides, weight learning runs **once, at that moment**, over the jurors whose ballots the reactive contract has recorded by then (`MandateLogic.learn` over `c.jurors`, guarded by `ownerActed`). Each moves one step (default weight 100, step 25, bounds 25 to 400): on an override, toward the owner if it voted the owner's side, away otherwise; on a veto, away if it voted the vetoed side, toward otherwise. A veto of a case that never reached a decision (held, split) teaches nothing. `WeightsUpdated(uint256 indexed caseId, address[] jurors, uint32[] weights)` on the reactive contract, topic0 `0xfca82544f619abbc2608c26a45ef6dc86379935e5dd198bd6b67cda29ba5e259`, records each change.
- **A verdict posted after the owner acted never moves that juror's weight.** It is still accepted by the Docket and recorded as a ballot on the reactive contract (`BallotRecorded`), but learning has already run and does not run again, and a vetoed or overridden case is terminal or locked to the owner's side, so the verdict changes nothing. This is what happened on case 10 of the first live run (FIRST_CASES.md, C08): the override landed before jurors 2 and 3 posted, so only juror 1's weight moved. A juror that wants its opinion to count for learning must post before the owner acts; the poll loop and the provider budget (docs/JURORS.md) exist to make that the normal case.

Other Docket events, for completeness: `Verdict` `0xebc8826e093d1ceefd93fc69c4f9fd33fdd4bdfdeba4d4ddb3403597f3431e60`, `Vetoed` `0x2ae00ba9813199478b6f22f0c9b606daa70f8efc319c8d2fa6af63f66ea31763`, `Overridden` `0x513253cb96c7552e4aa3f5e37d993053c957a21d0ade8ef9e71a0bbaa4ce1bb7`, `JurorAdded` `0xf8178f8760667f25bd537d505a67e00d13e86618daf92afc41e42570cb7bcbca`, `JurorRemoved` `0x4c61f24ccfd243a4474886c8364f5c8e2102f174d528c26852e664aa372a8fb8`.

## 6. Worker checklist

1. Poll `CaseOpened` from the last processed block (keep a cursor; re-scanning is safe). A failed poll (RPC timeout, 429, 5xx, dropped socket) is retried with backoff and never ends the worker; use two RPC endpoints per chain.
2. Skip if `getVerdict(caseId, me).posted`.
3. Load the proposal (receipt first, logs as fallback) and verify the proposal id.
4. Load the mandate for `mandateVersion` and verify its hash; skip on mismatch.
5. Run one inference at temperature 0 with the committed prompt; parse the fixed output schema; on a parse failure, re-ask once with the validation error appended (the repair), then post abstain at confidence 0 with the reason in the rationale (counts toward quorum, toward no side; see docs/DECISIONS.md). If no provider in the chain answers within its budget, post nothing and retry the case on the next pass.
6. Build and publish the rationale document; hash it.
7. Send `postVerdict` with a 200k gas limit; treat `AlreadyPosted` as success.
8. Record the transaction hash with the case id for the evidence log.
