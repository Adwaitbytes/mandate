# Jurors

Three independent workers read each case on the `Docket`, judge the proposal against the mandate, and post a verdict from their own key. The on-chain contract between them and the rest of the system is `docs/JUROR_INTERFACE.md`; this page is how they are built and run.

## Addresses

Each juror is a fresh EOA created for Mandate only. It needs Base Sepolia ETH for gas (about 125k gas per verdict) and nothing else. Register all three on the Docket with `addJurors` (or `JUROR_ADDRESSES` in `contracts/.env` at deploy time).

| Juror | Address | Model (`modelIdHash` preimage) | Provider | Foundry keystore |
|---|---|---|---|---|
| 1 | `0x1e1005C3Ac959A66e8cE5423382fC7a28a24839F` | `anthropic/claude-haiku-5-5` | Anthropic API (Claude) | `mandate-juror-1` |
| 2 | `0xEa5C14faC05Aa8a4C9a3A4184aE6E17E65402f54` | `groq/openai/gpt-oss-120b`, fallback `pollinations/openai-fast` (gpt-oss-20b) | Groq (OpenAI gpt-oss), Pollinations keyless | `mandate-juror-2` |
| 3 | `0x1e0702541FC8cd645Bf955fA5c26e4DfC0eF9fc7` | `google/gemini-flash-latest` (served version recorded per verdict), fallback `groq/qwen/qwen3.8-27b` | Google Gemini API, Groq | `mandate-juror-3` |

Three model families from three providers: Anthropic Claude, OpenAI gpt-oss, Google Gemini. The `modelIdHash` on chain is the hash of the model that actually answered, so a verdict that juror 2 posts after falling back to Pollinations carries `keccak256("pollinations/openai-fast")`, and the rationale says the same. Juror 3 falls back to Qwen 3.8 27B on Groq, a family neither other juror uses, because Gemini's free tier was overloaded for most of 2026-11-19. Qwen through Ollama (`JUROR_3_PROVIDER=ollama`, default tag `qwen2.5:3b-instruct`) remains a keyless option; the model card shows why it is not the default.

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
5. Scores the proposal text with Prompt Guard (below), runs one inference with the committed prompt, validates the JSON with zod, retries once on invalid output, then abstains at confidence 0.
6. Writes the rationale document (canonical JSON, keys sorted, no whitespace) plus the proposal text and mandate snapshot under `evidence/`, and in CI commits and pushes them before the hash goes on chain.
7. Sends `postVerdict` with a 200k gas limit after a simulation; `AlreadyPosted` counts as done.

A case that fails for a transient reason (RPC, provider outage) holds the checkpoint before its block, so the next pass retries it.

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
make replay CASE=2 JUROR=3 EVIDENCE=evidence/e2e-anvil
```

Keys are read from the environment or from the workspace `.env.local`, never logged: juror 1 `ANTHROPIC_API_KEY` (`ANTHROPIC_API_KEY_2` on 401 or 429), juror 2 `GROQ_API_KEY` (Pollinations needs none), juror 3 `GEMINI_API_KEY` (`GEMINI_API_KEY_2` on 429 or 503 "high demand"). Every juror uses `GROQ_API_KEY` for Prompt Guard. Gemini's free tier is often overloaded; the adapter walks both keys, then backs off up to three times (90 s timeout per call) before the fallback answers, so a juror 3 pass can take several minutes.

| Variable | Required | Meaning |
|---|---|---|
| `JUROR_ID` | yes | 1, 2 or 3; picks the default provider and keystore |
| `DOCKET` | yes | Docket address; no default, the worker refuses to start without it |
| `DOCKET_START_BLOCK` | yes | Docket deployment block, where a scan with no checkpoint starts |
| `HEARING_CHAIN_ID` | no | default 84532 (Base Sepolia); the RPC's chain id is checked against it |
| `RPC_URL_<chainId>` | yes | one per chain: the hearing chain and every origin chain (84532, 1301) |
| `RATIONALE_BASE_URL` | yes | public base URL of `evidence/`: `https://raw.githubusercontent.com/Adwaitbytes/mandate/master/evidence` |
| `RATIONALE_STORE` | no | `fs` (write only, default) or `git` (write, commit, push) |
| `PROVIDER`, `JUROR_<n>_PROVIDER` | no | override the provider: `anthropic`, `groq`, `pollinations`, `gemini`, `ollama` |
| `JUROR_<n>_FALLBACK` | no | fallback as `provider` or `provider:model`; juror 2 `pollinations`, juror 3 `groq:qwen/qwen3.8-27b`; `none` disables |
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

`workers-ci.yml` runs typecheck, Biome and the Vitest suite on every change under `workers/`.

## Rationale store

Rationale documents are committed to this repository under `evidence/rationales/<caseId>/juror-<n>.json` and served from raw GitHub URLs (`https://raw.githubusercontent.com/Adwaitbytes/mandate/master/evidence/rationales/<caseId>/juror-<n>.json`), which are free, keyless, HTTPS and versioned. Next to them, `evidence/cases/<caseId>/` keeps `case.json`, the exact `proposal.txt` the model saw and the `mandate.md` snapshot, and `verdicts/juror-<n>.json` records the transaction. The site can fetch a rationale by path and check it against the `rationaleHash` in the `Verdict` event; `make replay` checks the same thing and then re-runs the model.
