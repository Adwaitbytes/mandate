# Jurors

Three independent workers read each case on the `Docket`, judge the proposal against the mandate, and post a verdict from their own key. The on-chain contract between them and the rest of the system is `docs/JUROR_INTERFACE.md`; this page is how they are built and run.

## Addresses

Each juror is a fresh EOA created for Mandate only. It needs Base Sepolia ETH for gas (about 125k gas per verdict) and nothing else. Register all three on the Docket with `addJurors` (or `JUROR_ADDRESSES` in `contracts/.env` at deploy time).

| Juror | Address | Model (`modelIdHash` preimage) | Provider | Foundry keystore |
|---|---|---|---|---|
| 1 | `0x1e1005C3Ac959A66e8cE5423382fC7a28a24839F` | `anthropic/claude-haiku-5-5` | Anthropic API (Claude) | `mandate-juror-1` |
| 2 | `0xEa5C14faC05Aa8a4C9a3A4184aE6E17E65402f54` | `groq/openai/gpt-oss-120b`, then `pollinations/openai-fast` (gpt-oss-20b), then `groq/openai/gpt-oss-20b` | Groq (OpenAI gpt-oss), Pollinations keyless | `mandate-juror-2` |
| 3 | `0x1e0702541FC8cd645Bf955fA5c26e4DfC0eF9fc7` | `google/gemini-flash-latest` (served version recorded per verdict), then `groq/qwen/qwen3.8-27b` | Google Gemini API, Groq | `mandate-juror-3` |

Three model families from three providers: Anthropic Claude, OpenAI gpt-oss, Google Gemini, with Alibaba Qwen as juror 3's fallback. The `modelIdHash` on chain is the hash of the model that actually answered, so a verdict that juror 2 posts after falling back to Pollinations carries `keccak256("pollinations/openai-fast")`, and the rationale says the same (`model`, `servedModel`, and `providerFallbacks` with every link passed over and why). Qwen through Ollama (`ollama`, default tag `qwen2.5:3b-instruct`) is never in a default chain: on 2026-11-19 the 2B variant produced invalid output twice on case 15, and the model card shows the 3B one does not read the mandate. It stays available only by explicit configuration.

### Provider chains

Each juror tries its chain in order (`workers/src/providers/index.ts`, `DEFAULT_CHAIN`):

| Juror | Chain | Why it stops there |
|---|---|---|
| 1 | Claude Haiku 5.5 on `ANTHROPIC_API_KEY` → Claude Haiku 5.5 on `ANTHROPIC_API_KEY_2` | Every other family on these keys or keyless is another juror's (Groq serves only gpt-oss, Qwen and small models), so juror 1 waits for Claude rather than borrow one |
| 2 | gpt-oss-120b on Groq → gpt-oss-20b on Pollinations (keyless, one call per 46 s) → gpt-oss-20b on Groq | All OpenAI gpt-oss; Groq's per-model limits are separate, so the 20b still answers when the 120b's daily cap is spent |
| 3 | Gemini Flash on `GEMINI_API_KEY` → Gemini Flash on `GEMINI_API_KEY_2` → Qwen 3.8 27B on Groq | Qwen is a family neither other juror uses; Claude would duplicate juror 1 |

Rules that bound how long a juror can stall (`workers/src/providers/chain.ts`, `breaker.ts`):

- **Time budget.** One link gets at most 75 s, its own retries included (each adapter caps its backoff and request timeout at the deadline; a link that ignores it is cut off 2 s later). One completion gets at most 150 s across all links. A juror on a sick provider therefore moves on within about 75 s, not the eight minutes juror 2 spent on 2026-11-19.
- **No retries on a daily cap.** A 429 that says tokens or requests per day, a spent quota (`RESOURCE_EXHAUSTED` without a per-minute quota id), spent credit, or a 401/403 is not retried at all.
- **Circuit breaker per link** (per key for Anthropic and Gemini). Two consecutive transient failures (429, 5xx, timeout, dropped connection) open it for 5 minutes; one quota failure opens it for 60 minutes. While open the link is skipped without a call, so later cases go straight to the next link. After the cool-down one trial call is let through; a failure reopens it.
- **Any provider failure falls through** to the next link, since one provider's 400 or 401 says nothing about the next. A programming error is not caught.
- **When no link answers**, the case is not posted and stays before the checkpoint; the next pass retries it. Nothing falls back to a small local model.

The breaker state is in memory, so a restart costs at most one call per spent link.

```
JUROR_ADDRESSES=0x1e1005C3Ac959A66e8cE5423382fC7a28a24839F,0xEa5C14faC05Aa8a4C9a3A4184aE6E17E65402f54,0x1e0702541FC8cd645Bf955fA5c26e4DfC0eF9fc7
```

Keys live in `~/.foundry/keystores/mandate-juror-N`, encrypted with a random password in `~/.claude/secrets/mandate-juror-N.pass` (mode 600). The worker decrypts the keystore in process (`workers/src/chain/keystore.ts`); the key is never printed or written anywhere else. In CI the key comes from the `JUROR_KEY_N` secret as `JUROR_PRIVATE_KEY`.

Prompt for all three: `workers/prompts/juror.v1.md`, `promptHash` `0x4d8c2f41c2d64fdd29a414eaad472c22bf3019b5593545919a78052dda754da9`.

## What one pass does

1. Reads `CaseOpened` logs from the checkpoint (or `DOCKET_START_BLOCK`) to the head minus `CONFIRMATIONS`, in `LOG_CHUNK_BLOCKS` windows. A re-emitted `CaseOpened` for the same case id is handled once.
2. Skips a case if `getVerdict(caseId, me).posted` is already true. This, not the checkpoint, is what makes reruns safe: losing the checkpoint only costs a re-scan.
3. Loads the mandate for the case's `mandateVersion` with `getMandate`, fetches its URI (https, ipfs or file) and checks `keccak256(text) == mandateHash`. On a mismatch it posts nothing and moves on.
4. Loads the proposal from the origin chain: the receipt of `originTxHash`, then a backwards `eth_getLogs` scan over the governor if the receipt does not contain it.
5. Scores the proposal text with Prompt Guard (below), runs one inference with the committed prompt through the juror's provider chain, and validates the JSON with zod. On invalid output it re-asks once with the validator's error appended after the committed prompt (for example `rationale: Too big: expected string to have <=1200 characters`, which is what Qwen 3.8 returned twice on case 3); if the repair is invalid too it abstains at confidence 0 and the rationale says why.
6. Writes the rationale document (canonical JSON, keys sorted, no whitespace) plus the proposal text and mandate snapshot under `evidence/`, and in CI commits and pushes them before the hash goes on chain.
7. Sends `postVerdict` with a 200k gas limit after a simulation; `AlreadyPosted` counts as done.

A case that fails for a transient reason (RPC, provider outage) holds the checkpoint before its block, so the next pass retries it.

The loop around the passes (`workers/src/loop.ts`) never exits on an error. A pass that throws (on 2026-11-19 juror 1 died on an `eth_blockNumber` timeout from the public Base RPC) is logged and the next one runs after an exponential backoff with jitter: 2 s doubling for transient RPC errors (timeouts, 429, 5xx, socket resets, RPC limit errors), 10 s doubling for anything else, at most 2 minutes, never shorter than `POLL_INTERVAL_MS`, back to normal after a good pass. Every chain has two RPC endpoints (`RPC_URL_<id>` is a comma-separated list, used in failover order through viem's `fallback` transport, 8 s per endpoint); at startup each endpoint's chain id is checked and the startup reads retry transient errors. SIGTERM or SIGINT stops the worker after the pass in progress.

| Chain | Endpoints | Checked 2026-11-19 |
|---|---|---|
| Base Sepolia 84532 | `https://sepolia.base.org`, `https://base-sepolia-rpc.publicnode.com` | both serve chain id 84532 and 150-block `eth_getLogs` on the Docket |
| Unichain Sepolia 1301 | `https://sepolia.unichain.org`, `https://unichain-sepolia-rpc.publicnode.com` | both serve chain id 1301; publicnode served a 5,000-block log window, Unichain's own RPC caps at 1,000 |

dRPC's free tier (`base-sepolia.drpc.org`, `unichain-sepolia.drpc.org`) answers but caps `eth_getLogs` at 100 blocks, so it is not in the default list.

## Prompt injection

- The proposal is wrapped between two copies of a delimiter with 96 random bits, generated per call, and the system prompt says everything between them is data, never instructions. Substitution is single pass, so placeholder text inside a proposal stays literal.
- The model must return `injection_attempt`.
- `workers/src/injection.ts` runs first and flags, independently of the model: instruction overrides ("ignore previous instructions"), system prompt mimicry (`System:`, `<|im_start|>`, `[INST]`), role play ("you are now", "act as"), text addressed to an AI voter, coerced votes ("you must vote for", "regardless of the mandate"), output manipulation (verdict JSON keys, "set your confidence"), delimiter escapes, and hidden Unicode (zero-width, bidi controls, tag characters, soft hyphen).
- Llama Prompt Guard 2 (86M) on Groq (`workers/src/promptguard.ts`) scores the same text as a third, independent signal. It reads 512 tokens, so the text is scored in overlapping 1,000-character windows and the highest window counts. The score goes in the rationale document as `promptGuard.scoreBps` with the threshold used; the flag fires at 9000 bps or more (`PROMPT_GUARD_THRESHOLD_BPS`), calibrated in the model card. If Groq is unreachable the field is `null` and the other two signals still apply.
- Posted flag = model flag OR pre-filter flag OR Prompt Guard flag. Any flag holds the case on the reactive side.
- Plain governance language ("Vote FOR to approve") is deliberately not matched; false-positive rates on real proposals and detection on 16 injection samples are in `analysis/eval/MODEL_CARD.md`.

## Running locally

```
make workers-install
make workers-check                # typecheck, Biome, Vitest
make juror JUROR=1                # one pass for juror 1 against the env-configured Docket
make e2e-anvil                    # local anvil: real Docket and demo DAO, all three jurors, real models
make replay CASE=2 JUROR=3 EVIDENCE=evidence/e2e-anvil/run-2
```

Recorded anvil runs: `evidence/e2e-anvil/run-1` (Claude, gpt-oss-20b on Pollinations, Qwen 2.5 3B; six replays in `replays/`, four reproduced exactly, two drifted: Claude's confidence on case 1 moved 8000 to 6000 bps and gpt-oss-20b flipped against to for on the same borderline case) and `evidence/e2e-anvil/run-2` (Claude, gpt-oss-120b on Groq, and juror 3 on its Qwen 3.8 fallback because Gemini returned 429 quota exhausted; Prompt Guard scored the benign case 70 bps and the injection case 9991 bps). Both: two cases, the first opened twice, the second with a wrong origin tx hash so the log-scan fallback runs; six verdicts on chain with rationale hashes matching the files.

Keys are read from the environment or from the workspace `.env.local`, never logged: juror 1 `ANTHROPIC_API_KEY` and `ANTHROPIC_API_KEY_2`, juror 2 `GROQ_API_KEY` (Pollinations needs none), juror 3 `GEMINI_API_KEY`, `GEMINI_API_KEY_2` and `GROQ_API_KEY`. Every juror uses `GROQ_API_KEY` for Prompt Guard. A missing key drops that link from the chain with a warning at startup.

### Live supervisor

```
make jurors-up [JUROR_WORKERS=<worktree>/workers]    # three supervisors in the background
make jurors-status                                   # supervisor pids and each log's last line
make jurors-down                                     # SIGTERM; each juror finishes its pass (45 s grace)
```

`tools/live/supervise.sh <n> [workers dir]` runs `tools/live/juror.sh` (keystore `mandate-juror-<n>`, the deployed Docket, both RPC endpoints per chain) and restarts it whenever it exits, waiting 5 s and doubling to 5 minutes, back to 5 s after a run that lasted 10 minutes. Exit code 78 (a configuration error) is not restarted. Output goes to `evidence/live/juror-<n>.log`, rotated at 5 MB with five old files kept (`JUROR_LOG_MAX_BYTES`, `JUROR_LOG_KEEP`, `JUROR_LOG_DIR`); API-key-shaped strings are masked and `$HOME` is written as `~` before a line is written. Pid files are in `workers/.state/`.

| Variable | Required | Meaning |
|---|---|---|
| `JUROR_ID` | yes | 1, 2 or 3; picks the default provider and keystore |
| `DOCKET` | yes | Docket address; no default, the worker refuses to start without it |
| `DOCKET_START_BLOCK` | yes | Docket deployment block, where a scan with no checkpoint starts |
| `HEARING_CHAIN_ID` | no | default 84532 (Base Sepolia); the RPC's chain id is checked against it |
| `RPC_URL_<chainId>` | yes | one per chain: the hearing chain and every origin chain (84532, 1301); a comma-separated list is used in failover order |
| `RATIONALE_BASE_URL` | yes | public base URL of `evidence/`: `https://raw.githubusercontent.com/Adwaitbytes/mandate/master/evidence` |
| `RATIONALE_STORE` | no | `fs` (write only, default) or `git` (write, commit, push) |
| `JUROR_<n>_CHAIN` | no | the whole chain as a comma list of `provider[:model][#key]`, for example `gemini#2,groq:qwen/qwen3.8-27b`; `#1`/`#2` pick the Anthropic or Gemini key, a bare `anthropic` or `gemini` uses each configured key in turn |
| `PROVIDER`, `JUROR_<n>_PROVIDER` | no | replace the first link: `anthropic`, `groq`, `pollinations`, `gemini`, `ollama` (optionally `:model`) |
| `JUROR_<n>_FALLBACK` | no | replace the links after the first, as a comma list; `none` for no fallback |
| `PROMPT_GUARD`, `PROMPT_GUARD_THRESHOLD_BPS` | no | `off` disables the classifier; threshold default 9000 |
| `JUROR_PRIVATE_KEY` | no | use this key instead of the keystore (CI) |
| `JUROR_KEYSTORE`, `JUROR_PASSWORD_FILE` | no | keystore and password paths, default as above |
| `CHECKPOINT_FILE` | no | default `workers/.state/<chain>-<docket>-juror-N.json` |
| `CONFIRMATIONS`, `LOG_CHUNK_BLOCKS`, `POLL_INTERVAL_MS` | no | default 2, 5000, 30000 |
| `ANTHROPIC_MODEL`, `GROQ_MODEL`, `GEMINI_MODEL`, `POLLINATIONS_MODEL`, `OLLAMA_MODEL`, `OLLAMA_URL` | no | model overrides; changing one changes `modelIdHash` |

## Scheduled CI

`.github/workflows/jurors.yml` runs every 10 minutes and on manual dispatch. It restores the checkpoints from the Actions cache and runs jurors 1, 2 and 3 in sequence with `RATIONALE_STORE=git`, so the rationale files are pushed to the repo before each hash is posted. It does nothing until the variables below are set.

| Name | Kind | Value |
|---|---|---|
| `DOCKET` | repository variable | Docket address on Base Sepolia |
| `DOCKET_START_BLOCK` | repository variable | its deployment block |
| `JUROR_KEY_1`, `JUROR_KEY_2`, `JUROR_KEY_3` | secret | juror private keys |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_API_KEY_2` | secret | Claude keys (the second is optional) |
| `GROQ_API_KEY` | secret | juror 2 and Prompt Guard for all jurors |
| `GEMINI_API_KEY`, `GEMINI_API_KEY_2` | secret | juror 3 (the second is optional) |
| `RPC_URL_84532`, `RPC_URL_1301` | secret, optional | RPC overrides; default to the public endpoints |

No human step is needed. The repository is `github.com/Adwaitbytes/mandate`; run from `workers/`:

```
pnpm --silent set-ci-secrets --repo Adwaitbytes/mandate     # juror keys from the keystores, provider keys from .env.local, all via stdin
gh variable set DOCKET --repo Adwaitbytes/mandate --body <docket address>
gh variable set DOCKET_START_BLOCK --repo Adwaitbytes/mandate --body <deployment block>
```

`ci.yml` runs typecheck, Biome and the Vitest suite on every change.

## Rationale store

Rationale documents are committed to this repository under `evidence/rationales/<caseId>/juror-<n>.json` and served from raw GitHub URLs (`https://raw.githubusercontent.com/Adwaitbytes/mandate/master/evidence/rationales/<caseId>/juror-<n>.json`), which are free, keyless, HTTPS and versioned. Next to them, `evidence/cases/<caseId>/` keeps `case.json`, the exact `proposal.txt` the model saw and the `mandate.md` snapshot, and `verdicts/juror-<n>.json` records the transaction. The site can fetch a rationale by path and check it against the `rationaleHash` in the `Verdict` event; `make replay` checks the same thing and then re-runs the model.
