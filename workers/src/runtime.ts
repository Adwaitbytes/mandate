import { join } from "node:path";
import {
  type Account,
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  defineChain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalJson, type Json, keccakUtf8 } from "./canonical.ts";
import { type CaseOpenedEvent, DocketClient } from "./chain/docket.ts";
import { decryptKeystoreFile } from "./chain/keystore.ts";
import { fetchMandateText, MandateMismatchError, verifyMandate } from "./chain/mandate.ts";
import { fetchProposal } from "./chain/proposal.ts";
import { rpcTransport } from "./chain/rpc.ts";
import { FileCheckpoint } from "./checkpoint.ts";
import {
  bigintEnv,
  ConfigError,
  intEnv,
  type JurorId,
  optionalEnv,
  REPO_DIR,
  requireAddress,
  requireEnv,
  rpcUrlsFor,
  WORKERS_DIR,
} from "./config.ts";
import { judge } from "./judge.ts";
import { retryTransient } from "./loop.ts";
import { loadPromptTemplate, type PromptTemplate } from "./prompt.ts";
import { type InjectionClassifier, promptGuardFromEnv } from "./promptguard.ts";
import { renderProposal } from "./proposal.ts";
import type { Provider } from "./providers/types.ts";
import { buildRationale } from "./rationale.ts";
import { evidencePaths, type RationaleStore, RepoEvidenceStore } from "./store.ts";
import { type CaseResult, type PollSummary, pollOnce } from "./watcher.ts";

export interface JurorRuntime {
  jurorId: JurorId;
  account: Account;
  provider: Provider;
  /** Independent injection classifier (Prompt Guard), when configured. */
  classifier?: InjectionClassifier;
  template: PromptTemplate;
  docket: DocketClient;
  hearing: PublicClient;
  wallet: WalletClient;
  store: RationaleStore;
  originClient: (chainId: bigint) => PublicClient;
  log: (message: string) => void;
}

/**
 * Handles one case end to end: proposal from the origin chain, mandate by URI with its hash checked, one
 * inference, evidence published, verdict posted. Returns `skipped` only for permanent conditions (mandate
 * missing or mismatched); anything transient throws so the watcher retries.
 */
export async function processCase(rt: JurorRuntime, event: CaseOpenedEvent): Promise<CaseResult> {
  const caseId = event.caseId.toString();
  const tag = `juror ${rt.jurorId} case ${caseId}`;

  if (event.mandateVersion === 0n) {
    rt.log(`${tag}: skipped, case has mandate version 0`);
    return "skipped";
  }
  const mandate = await rt.docket.getMandate(event.mandateVersion);
  if (mandate.mandateHash.toLowerCase() !== event.mandateHash.toLowerCase()) {
    rt.log(`${tag}: skipped, CaseOpened mandateHash differs from getMandate(${event.mandateVersion})`);
    return "skipped";
  }
  let mandateText: string;
  try {
    mandateText = await fetchMandateText(mandate.uri);
    verifyMandate(mandateText, mandate.mandateHash);
  } catch (err) {
    if (err instanceof MandateMismatchError) {
      rt.log(`${tag}: skipped, ${err.message}`);
      return "skipped";
    }
    throw err;
  }

  const fetched = await fetchProposal(rt.originClient(event.originChainId), {
    governor: event.governor,
    proposalId: event.proposalId,
    originTxHash: event.originTxHash,
  });
  const proposalText = renderProposal(fetched.proposal);

  const outcome = await judge(
    rt.provider,
    rt.template,
    {
      mandateText,
      mandateVersion: event.mandateVersion.toString(),
      mandateHash: mandate.mandateHash,
      proposalText,
    },
    {
      ...(rt.classifier === undefined ? {} : { classifier: rt.classifier }),
      log: (m) => rt.log(`${tag}: ${m}`),
    },
  );

  const modelIdHash = keccakUtf8(outcome.modelId);
  const rationale = buildRationale(
    {
      caseId: event.caseId,
      originChainId: event.originChainId,
      governor: event.governor,
      proposalId: event.proposalId,
      mandateVersion: event.mandateVersion,
      mandateHash: mandate.mandateHash,
      juror: rt.account.address,
      jurorId: rt.jurorId,
      model: outcome.modelId,
      modelIdHash,
      promptFile: rt.template.file,
      promptHash: rt.template.hash,
      temperature: outcome.temperature,
      proposalTextHash: keccakUtf8(proposalText),
      createdAt: new Date().toISOString(),
    },
    outcome,
  );

  // Another run may have posted while this one was thinking; never overwrite a rationale whose hash is on chain.
  if (await rt.docket.hasPosted(event.caseId, rt.account.address)) {
    rt.log(`${tag}: another run posted while the model was running; keeping its rationale`);
    return "alreadyPosted";
  }

  const caseDir = evidencePaths.caseDir(caseId);
  const caseRecord: Json = {
    caseId,
    originChainId: event.originChainId.toString(),
    governor: event.governor,
    proposalId: event.proposalId.toString(),
    voteStart: event.voteStart.toString(),
    voteEnd: event.voteEnd.toString(),
    originTxHash: event.originTxHash,
    proposalTxHash: fetched.txHash,
    proposalSource: fetched.source,
    delegate: event.delegate,
    mandateVersion: event.mandateVersion.toString(),
    mandateHash: mandate.mandateHash,
    mandateUri: mandate.uri,
    proposalTextHash: keccakUtf8(proposalText),
  };
  await rt.store.publish(
    [
      { path: join(caseDir, "case.json"), content: `${JSON.stringify(caseRecord, null, 2)}\n` },
      { path: join(caseDir, "proposal.txt"), content: proposalText },
      { path: join(caseDir, "mandate.md"), content: mandateText },
      { path: evidencePaths.rationale(caseId, rt.jurorId), content: rationale.bytes },
    ],
    `Juror ${rt.jurorId} rationale for case ${caseId}`,
  );

  const result = await rt.docket.postVerdict(rt.wallet, {
    caseId: event.caseId,
    support: outcome.supportCode,
    confidenceBps: outcome.confidenceBps,
    rationaleHash: rationale.hash,
    modelIdHash,
    promptHash: rt.template.hash,
    injectionFlag: outcome.injectionFlag,
  });
  if (result.status === "alreadyPosted") {
    rt.log(`${tag}: another run already posted this verdict`);
    return "alreadyPosted";
  }
  const verdictLog: Json = {
    caseId,
    jurorId: rt.jurorId,
    juror: rt.account.address,
    txHash: result.txHash,
    blockNumber: result.blockNumber.toString(),
    rationaleHash: rationale.hash,
    support: outcome.supportCode,
    confidenceBps: outcome.confidenceBps,
    injectionFlag: outcome.injectionFlag,
  };
  await rt.store.publish(
    [{ path: evidencePaths.verdictLog(caseId, rt.jurorId), content: `${canonicalJson(verdictLog)}\n` }],
    `Juror ${rt.jurorId} verdict tx for case ${caseId}`,
  );
  rt.log(
    `${tag}: posted ${outcome.verdict.support} at ${outcome.confidenceBps} bps, injection ${outcome.injectionFlag}, tx ${result.txHash}`,
  );
  return "posted";
}

/** Loads the juror key: JUROR_PRIVATE_KEY (CI secret) or the Foundry keystore mandate-juror-N with its password file. */
export async function loadJurorAccountKey(jurorId: JurorId): Promise<Hex> {
  const raw = optionalEnv("JUROR_PRIVATE_KEY");
  if (raw !== undefined) {
    const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new ConfigError("JUROR_PRIVATE_KEY is not a 32-byte hex key");
    return key;
  }
  const home = requireEnv("HOME");
  const keystore =
    optionalEnv("JUROR_KEYSTORE") ?? join(home, ".foundry", "keystores", `mandate-juror-${jurorId}`);
  const password =
    optionalEnv("JUROR_PASSWORD_FILE") ?? join(home, ".claude", "secrets", `mandate-juror-${jurorId}.pass`);
  return decryptKeystoreFile(keystore, password);
}

export async function loadJurorAccount(jurorId: JurorId): Promise<Account> {
  return privateKeyToAccount(await loadJurorAccountKey(jurorId));
}

function chainFor(id: number, rpcs: readonly string[]): Chain {
  return defineChain({
    id,
    name: `chain-${id}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: rpcs } },
  });
}

export interface RuntimeDeps {
  jurorId: JurorId;
  provider: Provider;
  account?: Account;
  log?: (message: string) => void;
}

/**
 * Assembles a runtime from env. Every address and RPC URL is required explicitly; nothing is hardcoded. Each
 * chain's `RPC_URL_<id>` may list several endpoints (comma-separated), used in failover order. The startup reads
 * are retried on transient RPC errors so a flaky endpoint does not stop a juror from starting.
 */
export async function runtimeFromEnv(
  deps: RuntimeDeps,
): Promise<{ rt: JurorRuntime; poll: () => Promise<PollSummary> }> {
  const hearingChainId = intEnv("HEARING_CHAIN_ID", 84532);
  const hearingRpcs = rpcUrlsFor(hearingChainId);
  const docketAddress = requireAddress("DOCKET");
  const startBlock = bigintEnv("DOCKET_START_BLOCK");
  if (startBlock === undefined)
    throw new ConfigError("Missing required environment variable DOCKET_START_BLOCK");

  const log = deps.log ?? ((m: string) => console.log(`${new Date().toISOString()} ${m}`));
  const hearingChain = chainFor(hearingChainId, hearingRpcs);
  const hearingTransport = rpcTransport(hearingRpcs);
  const hearing = createPublicClient({ chain: hearingChain, transport: hearingTransport }) as PublicClient;
  // Every endpoint must serve the hearing chain, or failover could send a verdict to the wrong network.
  for (const url of hearingRpcs) {
    const probe = createPublicClient({ transport: rpcTransport([url]) });
    const chainOnRpc = await retryTransient(
      `eth_chainId on RPC ${redactUrl(url)}`,
      () => probe.getChainId(),
      {
        log,
      },
    );
    if (chainOnRpc !== hearingChainId)
      throw new ConfigError(
        `RPC_URL_${hearingChainId} endpoint ${redactUrl(url)} serves chain ${chainOnRpc}, expected ${hearingChainId}`,
      );
  }
  const account = deps.account ?? (await loadJurorAccount(deps.jurorId));
  const wallet = createWalletClient({ account, chain: hearingChain, transport: hearingTransport });
  const docket = new DocketClient(docketAddress, hearing);
  if (!(await retryTransient("isJuror", () => docket.isJuror(account.address), { log }))) {
    throw new ConfigError(
      `Juror ${deps.jurorId} (${account.address}) is not registered on Docket ${docketAddress}`,
    );
  }

  const origins = new Map<bigint, PublicClient>();
  const originClient = (chainId: bigint): PublicClient => {
    const cached = origins.get(chainId);
    if (cached !== undefined) return cached;
    const client = createPublicClient({ transport: rpcTransport(rpcUrlsFor(chainId)) }) as PublicClient;
    origins.set(chainId, client);
    return client;
  };

  const storeMode = optionalEnv("RATIONALE_STORE") ?? "fs";
  if (storeMode !== "fs" && storeMode !== "git")
    throw new ConfigError(`RATIONALE_STORE must be fs or git, got ${storeMode}`);
  const evidenceDir = optionalEnv("EVIDENCE_DIR") ?? join(REPO_DIR, "evidence");
  const store = new RepoEvidenceStore(evidenceDir, requireEnv("RATIONALE_BASE_URL"), storeMode);

  const classifier = promptGuardFromEnv();
  const rt: JurorRuntime = {
    jurorId: deps.jurorId,
    account,
    provider: deps.provider,
    ...(classifier === undefined ? {} : { classifier }),
    template: loadPromptTemplate(optionalEnv("PROMPT_FILE")),
    docket,
    hearing,
    wallet,
    store,
    originClient,
    log,
  };

  const checkpointPath =
    optionalEnv("CHECKPOINT_FILE") ??
    join(
      WORKERS_DIR,
      ".state",
      `${hearingChainId}-${docketAddress.toLowerCase()}-juror-${deps.jurorId}.json`,
    );
  const checkpoint = new FileCheckpoint(checkpointPath);
  const poll = (): Promise<PollSummary> =>
    pollOnce({
      reader: docket,
      checkpoint,
      juror: account.address as Address,
      startBlock,
      chunkBlocks: BigInt(intEnv("LOG_CHUNK_BLOCKS", 5_000)),
      confirmations: BigInt(intEnv("CONFIRMATIONS", 2)),
      processCase: (event) => processCase(rt, event),
      log,
    });
  return { rt, poll };
}

/** Host only, so a provider key embedded in an RPC URL path or query never reaches a log. */
function redactUrl(url: string): string {
  return new URL(url).host;
}
