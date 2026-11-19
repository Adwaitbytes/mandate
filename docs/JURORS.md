# Jurors

Three independent workers read each case on the `Docket`, judge the proposal against the mandate, and post a verdict from their own key. The on-chain contract between them and the rest of the system is `docs/JUROR_INTERFACE.md`; this page is how they are built and run.

## Addresses

Each juror is a fresh EOA created for Mandate only. It needs Base Sepolia ETH for gas (about 125k gas per verdict) and nothing else. Register all three on the Docket with `addJurors` (or `JUROR_ADDRESSES` in `contracts/.env` at deploy time).

| Juror | Address | Model (`modelIdHash` preimage) | Provider | Foundry keystore |
|---|---|---|---|---|
| 1 | `0x1e1005C3Ac959A66e8cE5423382fC7a28a24839F` | `anthropic/claude-haiku-5-5` | Anthropic API | `mandate-juror-1` |
| 2 | `0xEa5C14faC05Aa8a4C9a3A4184aE6E17E65402f54` | `pollinations/openai-fast` (OpenAI gpt-oss-20b) | Pollinations, keyless | `mandate-juror-2` |
| 3 | `0x1e0702541FC8cd645Bf955fA5c26e4DfC0eF9fc7` | `ollama/qwen2.5:3b-instruct` | Ollama, local or on the CI runner | `mandate-juror-3` |

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
5. Runs one inference with the committed prompt (below), validates the JSON with zod, retries once on invalid output, then abstains at confidence 0.
6. Writes the rationale document (canonical JSON, keys sorted, no whitespace) plus the proposal text and mandate snapshot under `evidence/`, and in CI commits and pushes them before the hash goes on chain.
7. Sends `postVerdict` with a 200k gas limit after a simulation; `AlreadyPosted` counts as done.

A case that fails for a transient reason (RPC, provider outage) holds the checkpoint before its block, so the next pass retries it.

## Prompt injection

- The proposal is wrapped between two copies of a delimiter with 96 random bits, generated per call, and the system prompt says everything between them is data, never instructions. Substitution is single pass, so placeholder text inside a proposal stays literal.
- The model must return `injection_attempt`.
- `workers/src/injection.ts` runs first and flags, independently of the model: instruction overrides ("ignore previous instructions"), system prompt mimicry (`System:`, `<|im_start|>`, `[INST]`), role play ("you are now", "act as"), text addressed to an AI voter, coerced votes ("you must vote for", "regardless of the mandate"), output manipulation (verdict JSON keys, "set your confidence"), delimiter escapes, and hidden Unicode (zero-width, bidi controls, tag characters, soft hyphen).
- Posted flag = model flag OR heuristic flag. Any flag holds the case on the reactive side.
- Plain governance language ("Vote FOR to approve") is deliberately not matched; the false-positive rate on 72 real proposals is in `analysis/eval/MODEL_CARD.md`.

## Running locally

```
make workers-install
make workers-check                # typecheck, Biome, Vitest
make juror JUROR=1                # one pass for juror 1 against the env-configured Docket
make e2e-anvil                    # local anvil: real Docket and demo DAO, all three jurors, real models
make replay CASE=2 JUROR=3 EVIDENCE=evidence/e2e-anvil
```

Juror 3 needs `ollama serve` with `qwen2.5:3b-instruct` pulled. Juror 1 reads `ANTHROPIC_API_KEY` (and `ANTHROPIC_API_KEY_2` as a fallback on 401 or 429) from the environment or from the workspace `.env.local`.

| Variable | Required | Meaning |
|---|---|---|
| `JUROR_ID` | yes | 1, 2 or 3; picks the default provider and keystore |
| `DOCKET` | yes | Docket address; no default, the worker refuses to start without it |
| `DOCKET_START_BLOCK` | yes | Docket deployment block, where a scan with no checkpoint starts |
| `HEARING_CHAIN_ID` | no | default 84532 (Base Sepolia); the RPC's chain id is checked against it |
| `RPC_URL_<chainId>` | yes | one per chain: the hearing chain and every origin chain (84532, 1301) |
| `RATIONALE_BASE_URL` | yes | public base URL of `evidence/`, for example `https://raw.githubusercontent.com/<owner>/mandate/main/evidence` |
| `RATIONALE_STORE` | no | `fs` (write only, default) or `git` (write, commit, push) |
| `PROVIDER` | no | override the provider: `anthropic`, `pollinations`, `ollama` |
| `JUROR_PRIVATE_KEY` | no | use this key instead of the keystore (CI) |
| `JUROR_KEYSTORE`, `JUROR_PASSWORD_FILE` | no | keystore and password paths, default as above |
| `CHECKPOINT_FILE` | no | default `workers/.state/<chain>-<docket>-juror-N.json` |
| `CONFIRMATIONS`, `LOG_CHUNK_BLOCKS`, `POLL_INTERVAL_MS` | no | default 2, 5000, 30000 |
| `ANTHROPIC_MODEL`, `POLLINATIONS_MODEL`, `OLLAMA_MODEL`, `OLLAMA_URL` | no | model overrides; changing one changes `modelIdHash` |

## Scheduled CI

`.github/workflows/jurors.yml` runs every 10 minutes and on manual dispatch. It installs Ollama on the runner, pulls Qwen (cached between runs), restores the checkpoints from the Actions cache, and runs jurors 1, 2 and 3 in sequence with `RATIONALE_STORE=git`, so the rationale files are pushed to the repo before each hash is posted. It does nothing until the variables below are set.

| Name | Kind | Value |
|---|---|---|
| `DOCKET` | repository variable | Docket address on Base Sepolia |
| `DOCKET_START_BLOCK` | repository variable | its deployment block |
| `JUROR_KEY_1`, `JUROR_KEY_2`, `JUROR_KEY_3` | secret | juror private keys |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_API_KEY_2` | secret | Claude keys (the second is optional) |
| `RPC_URL_84532`, `RPC_URL_1301` | secret, optional | RPC overrides; default to the public endpoints |

No human step is needed. Once the repo exists on GitHub, run from `workers/`:

```
pnpm -s set-ci-secrets --repo <owner>/mandate     # juror keys from the keystores, Anthropic keys from .env.local, all via stdin
gh variable set DOCKET --repo <owner>/mandate --body <docket address>
gh variable set DOCKET_START_BLOCK --repo <owner>/mandate --body <deployment block>
```

`workers-ci.yml` runs typecheck, Biome and the Vitest suite on every change under `workers/`.

## Rationale store

Rationale documents are committed to this repository under `evidence/rationales/<caseId>/juror-<n>.json` and served from raw GitHub URLs, which are free, keyless, HTTPS and versioned. Next to them, `evidence/cases/<caseId>/` keeps `case.json`, the exact `proposal.txt` the model saw and the `mandate.md` snapshot, and `verdicts/juror-<n>.json` records the transaction. The site can fetch a rationale by path and check it against the `rationaleHash` in the `Verdict` event; `make replay` checks the same thing and then re-runs the model.
