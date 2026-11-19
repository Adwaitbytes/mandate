import {
  type AbiEvent,
  type Address,
  decodeEventLog,
  getAbiItem,
  type Hex,
  isAddressEqual,
  keccak256,
  type Log,
  type PublicClient,
  toBytes,
} from "viem";
import { delegateAbi, demoGovernorAbi, docketAbi, mandateReactiveAbi } from "@/generated/abi";
import { evidenceIndex } from "@/generated/evidence";
import { type ChainId, chains, isChainId } from "./chains";
import { onChain, publicClient } from "./clients";
import { deployments, type Juror, jurorByAddress, jurors as knownJurors } from "./config";
import { formatUtc } from "./format";
import { type AnsweredBy, answeredBy } from "./models";
import type { TallyConfig } from "./tally";

const HEARING = 84532 as const;
const REACTIVE = 5318007 as const;

function docketAddress(): Address {
  const a = deployments.docket.address;
  if (!a) throw new Error("Docket is not deployed");
  return a;
}
function reactiveAddress(): Address | null {
  return deployments.reactive.address;
}

// ---------------------------------------------------------------------------------------------------------------
// Types

export interface DocketCase {
  caseId: bigint;
  originChainId: number;
  voteStart: bigint;
  voteEnd: bigint;
  openedAt: number;
  governor: Address;
  mandateVersion: number;
  verdictCount: number;
  ownerAction: number;
  overrideSupport: number;
  delegate: Address;
  proposalId: bigint;
  originTxHash: Hex;
}

export interface ReactiveCase {
  status: number;
  hold: number;
  clock: number;
  support: number;
  hasDecision: boolean;
  ownerActed: boolean;
  overridden: boolean;
  castRequested: boolean;
  injectionFlags: number;
  seq: number;
  createdAt: number;
  dueAt: number;
  voteStart: bigint;
  voteEnd: bigint;
}

export interface CaseConfig extends TallyConfig {
  vetoWindow: number;
  caseTtl: number;
}

export interface VerdictRow {
  juror: Address;
  known: Juror | undefined;
  support: number;
  confidenceBps: number;
  injectionFlag: boolean;
  postedAt: number;
  rationaleHash: Hex;
  modelIdHash: Hex;
  promptHash: Hex;
  /** The model the modelIdHash names, from the juror's provider chain; the opinion refines it from the rationale. */
  answered: AnsweredBy;
  /** weightOf(juror) on Lasna now; null if Lasna did not answer. */
  weight: number | null;
}

/** A read that may fail on its own chain without taking the page down. */
export type Part<T> = { ok: true; value: T } | { ok: false; chainId: ChainId; message: string };

async function part<T>(chainId: ChainId, read: () => Promise<T>): Promise<Part<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (err) {
    return { ok: false, chainId, message: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Decoders: viem returns structs as objects with the Solidity field names.

type DocketCaseRaw = {
  originChainId: bigint;
  voteStart: bigint;
  voteEnd: bigint;
  openedAt: bigint;
  governor: Address;
  mandateVersion: number;
  verdictCount: number;
  ownerAction: number;
  overrideSupport: number;
  delegate: Address;
  proposalId: bigint;
  originTxHash: Hex;
};

function toDocketCase(caseId: bigint, r: DocketCaseRaw): DocketCase {
  return {
    caseId,
    originChainId: Number(r.originChainId),
    voteStart: r.voteStart,
    voteEnd: r.voteEnd,
    openedAt: Number(r.openedAt),
    governor: r.governor,
    mandateVersion: Number(r.mandateVersion),
    verdictCount: Number(r.verdictCount),
    ownerAction: Number(r.ownerAction),
    overrideSupport: Number(r.overrideSupport),
    delegate: r.delegate,
    proposalId: r.proposalId,
    originTxHash: r.originTxHash,
  };
}

async function readReactiveCase(
  client: PublicClient,
  address: Address,
  caseId: bigint,
): Promise<ReactiveCase | null> {
  const c = await client.readContract({
    address,
    abi: mandateReactiveAbi,
    functionName: "getCase",
    args: [caseId],
  });
  if (Number(c.status) === 0) return null;
  return {
    status: Number(c.status),
    hold: Number(c.hold),
    clock: Number(c.clock),
    support: Number(c.support),
    hasDecision: c.hasDecision,
    ownerActed: c.ownerActed,
    overridden: c.overridden,
    castRequested: c.castRequested,
    injectionFlags: Number(c.injectionFlags),
    seq: Number(c.seq),
    createdAt: Number(c.createdAt),
    dueAt: Number(c.dueAt),
    voteStart: BigInt(c.voteStart),
    voteEnd: BigInt(c.voteEnd),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Docket index

export interface DocketRow {
  docket: DocketCase;
  reactive: Part<ReactiveCase | null>;
}

export interface DocketIndex {
  total: number;
  rows: DocketRow[];
  mandateVersion: number;
}

export async function readDocketIndex(limit = 40): Promise<DocketIndex> {
  const client = publicClient(HEARING);
  const address = docketAddress();
  const [count, mandateVersion] = await onChain(HEARING, "the Docket", () =>
    Promise.all([
      client.readContract({ address, abi: docketAbi, functionName: "caseCount" }),
      client.readContract({ address, abi: docketAbi, functionName: "mandateVersion" }),
    ]),
  );
  const total = Number(count);
  const indexes = Array.from({ length: Math.min(limit, total) }, (_, i) => BigInt(total - 1 - i));
  const cases = await onChain(HEARING, "the court list", () =>
    Promise.all(
      indexes.map(async (index) => {
        const caseId = await client.readContract({
          address,
          abi: docketAbi,
          functionName: "caseIdAt",
          args: [index],
        });
        const raw = await client.readContract({
          address,
          abi: docketAbi,
          functionName: "getCase",
          args: [caseId],
        });
        return toDocketCase(caseId, raw);
      }),
    ),
  );
  const rc = reactiveAddress();
  const lasna = publicClient(REACTIVE);
  const rows = await Promise.all(
    cases.map(async (docket) => ({
      docket,
      reactive: rc
        ? await part(REACTIVE, () => readReactiveCase(lasna, rc, docket.caseId))
        : ({ ok: true, value: null } as const),
    })),
  );
  return { total, rows, mandateVersion: Number(mandateVersion) };
}

// ---------------------------------------------------------------------------------------------------------------
// One case

export interface CaseDetail {
  docket: DocketCase;
  verdicts: VerdictRow[];
  owner: Address;
  reactive: Part<{ state: ReactiveCase | null; config: CaseConfig | null }>;
}

export async function readCase(caseId: bigint): Promise<CaseDetail | null> {
  const client = publicClient(HEARING);
  const address = docketAddress();
  const [raw, registered, owner] = await onChain(HEARING, `case ${caseId}`, () =>
    Promise.all([
      client.readContract({ address, abi: docketAbi, functionName: "getCase", args: [caseId] }),
      client.readContract({ address, abi: docketAbi, functionName: "jurors" }),
      client.readContract({ address, abi: docketAbi, functionName: "owner" }),
    ]),
  );
  if (raw.openedAt === 0n) return null;
  const docket = toDocketCase(caseId, raw);

  // A removed juror's verdicts stay on record, so also ask about every juror the site knows by name.
  const candidates: Address[] = [...registered];
  for (const j of knownJurors)
    if (!candidates.some((a) => isAddressEqual(a, j.address))) candidates.push(j.address);
  const records = await onChain(HEARING, "the verdicts", () =>
    Promise.all(
      candidates.map((juror) =>
        client.readContract({ address, abi: docketAbi, functionName: "getVerdict", args: [caseId, juror] }),
      ),
    ),
  );

  const rc = reactiveAddress();
  const lasna = publicClient(REACTIVE);
  const posted = candidates
    .map((juror, i) => ({ juror, record: records[i] }))
    .filter(
      (v): v is { juror: Address; record: NonNullable<(typeof records)[number]> } =>
        v.record?.posted === true,
    );

  const weights: Part<number[]> = rc
    ? await part(REACTIVE, () =>
        Promise.all(
          posted.map(async (v) =>
            Number(
              await lasna.readContract({
                address: rc,
                abi: mandateReactiveAbi,
                functionName: "weightOf",
                args: [v.juror],
              }),
            ),
          ),
        ),
      )
    : { ok: false, chainId: REACTIVE, message: "MandateReactive is not deployed" };

  const verdicts: VerdictRow[] = posted
    .map((v, i) => {
      const known = jurorByAddress(v.juror);
      return {
        juror: v.juror,
        known,
        support: Number(v.record.support),
        confidenceBps: Number(v.record.confidenceBps),
        injectionFlag: v.record.injectionFlag,
        postedAt: Number(v.record.postedAt),
        rationaleHash: v.record.rationaleHash,
        modelIdHash: v.record.modelIdHash,
        promptHash: v.record.promptHash,
        answered: known ? answeredBy(known.models, v.record.modelIdHash) : ({ kind: "unknown" } as const),
        weight: weights.ok ? (weights.value[i] ?? null) : null,
      };
    })
    .sort((a, b) => (a.known?.id ?? 99) - (b.known?.id ?? 99) || a.postedAt - b.postedAt);

  const reactive = rc
    ? await part(REACTIVE, async () => {
        const state = await readReactiveCase(lasna, rc, caseId);
        if (state === null) return { state, config: null };
        const c = await lasna.readContract({
          address: rc,
          abi: mandateReactiveAbi,
          functionName: "caseConfig",
          args: [caseId],
        });
        const config: CaseConfig = {
          quorum: Number(c.quorum),
          minAgreeing: Number(c.minAgreeing),
          injectionFlagsToHold: Number(c.injectionFlagsToHold),
          minConfidenceBps: Number(c.minConfidenceBps),
          majorityBps: Number(c.majorityBps),
          splitPolicy: Number(c.splitPolicy) === 0 ? "abstain" : "hold",
          vetoWindow: Number(c.vetoWindow),
          caseTtl: Number(c.caseTtl),
        };
        return { state, config };
      })
    : ({ ok: false, chainId: REACTIVE, message: "MandateReactive is not deployed" } as const);

  return { docket, verdicts, owner, reactive };
}

// ---------------------------------------------------------------------------------------------------------------
// The proposal, from the origin transaction

export interface ProposalText {
  proposer: Address;
  description: string;
  actions: { target: Address; value: bigint; signature: string; calldata: Hex }[];
  blockNumber: bigint;
  timestamp: number;
}

export async function readProposal(
  chainId: number,
  txHash: Hex,
  governor: Address,
  proposalId: bigint,
): Promise<ProposalText | null> {
  if (!isChainId(chainId)) return null;
  const client = publicClient(chainId);
  const receipt = await onChain(chainId, "the proposal transaction", () =>
    client.getTransactionReceipt({ hash: txHash }),
  );
  for (const log of receipt.logs) {
    if (!isAddressEqual(log.address, governor)) continue;
    try {
      const decoded = decodeEventLog({
        abi: demoGovernorAbi,
        eventName: "ProposalCreated",
        data: log.data,
        topics: log.topics,
      });
      if (decoded.args.proposalId !== proposalId) continue;
      const block = await onChain(chainId, "the proposal block", () =>
        client.getBlock({ blockNumber: receipt.blockNumber }),
      );
      const a = decoded.args;
      return {
        proposer: a.proposer,
        description: a.description,
        actions: a.targets.map((target, i) => ({
          target,
          value: a.values[i] ?? 0n,
          signature: a.signatures[i] ?? "",
          calldata: a.calldatas[i] ?? "0x",
        })),
        blockNumber: receipt.blockNumber,
        timestamp: Number(block.timestamp),
      };
    } catch {
      // Not a ProposalCreated log from this governor; keep looking.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Logs near a known time. Every hop in a case has a timestamp on some chain, so each search covers minutes of
// blocks rather than the chain's history.

const msPerBlock: Record<ChainId, number> = { 84532: 200, 1301: 1000, 5318007: 1060 };

async function blockNear(
  client: PublicClient,
  chainId: ChainId,
  ts: number,
  latest: { number: bigint; timestamp: bigint },
) {
  const bt = msPerBlock[chainId];
  const behind = BigInt(Math.ceil(((Number(latest.timestamp) - ts) * 1000) / bt));
  let guess = latest.number - behind;
  if (guess < 0n) guess = 0n;
  if (guess >= latest.number) return latest.number;
  const probe = await client.getBlock({ blockNumber: guess });
  const drift = BigInt(Math.round(((Number(probe.timestamp) - ts) * 1000) / bt));
  const corrected = guess - drift;
  if (corrected < 0n) return 0n;
  return corrected > latest.number ? latest.number : corrected;
}

export interface FoundLog {
  txHash: Hex;
  blockNumber: bigint;
  timestamp: number;
  args: Record<string, unknown>;
}

/**
 * Logs between two times. `slack` widens the range on both sides: a few seconds when the time is the block's own
 * timestamp on the same chain, more when it comes from another chain's clock. A scan that would take more than
 * `maxRequests` getLogs calls is refused rather than left to hammer a public endpoint; the hop then reads as not
 * found and the page links what it does know.
 */
async function logsNear(
  chainId: ChainId,
  address: Address,
  event: AbiEvent,
  args: Record<string, unknown>,
  fromTs: number,
  toTs: number,
  { slack = 10, maxRequests = 12 }: { slack?: number; maxRequests?: number } = {},
): Promise<FoundLog[]> {
  const client = publicClient(chainId);
  const latest = await client.getBlock({ blockTag: "latest" });
  const from = await blockNear(client, chainId, fromTs - slack, latest);
  const to =
    Math.min(toTs + slack, Number(latest.timestamp)) >= Number(latest.timestamp)
      ? latest.number
      : await blockNear(client, chainId, toTs + slack, latest);
  const chunk = chains[chainId].logChunk;
  if (to >= from && (to - from) / chunk + 1n > BigInt(maxRequests)) {
    throw new Error(`Scanning ${to - from + 1n} blocks would take more than ${maxRequests} requests`);
  }
  const found: Log[] = [];
  for (let start = from; start <= to; start += chunk) {
    const end = start + chunk - 1n > to ? to : start + chunk - 1n;
    const logs = await client.getLogs({ address, event, args, fromBlock: start, toBlock: end });
    found.push(...logs);
  }
  const blocks = new Map<bigint, number>();
  await Promise.all(
    [...new Set(found.map((l) => l.blockNumber).filter((b): b is bigint => b !== null))].map(async (b) => {
      blocks.set(b, Number((await client.getBlock({ blockNumber: b })).timestamp));
    }),
  );
  return found
    .filter((l) => l.transactionHash !== null && l.blockNumber !== null)
    .map((l) => ({
      txHash: l.transactionHash as Hex,
      blockNumber: l.blockNumber as bigint,
      timestamp: blocks.get(l.blockNumber as bigint) ?? 0,
      args: (l as unknown as { args?: Record<string, unknown> }).args ?? {},
    }));
}

const ev = {
  caseCreated: getAbiItem({ abi: mandateReactiveAbi, name: "CaseCreated" }) as AbiEvent,
  tallyUpdated: getAbiItem({ abi: mandateReactiveAbi, name: "TallyUpdated" }) as AbiEvent,
  windowStarted: getAbiItem({ abi: mandateReactiveAbi, name: "WindowStarted" }) as AbiEvent,
  castRequested: getAbiItem({ abi: mandateReactiveAbi, name: "CastRequested" }) as AbiEvent,
  weightsUpdated: getAbiItem({ abi: mandateReactiveAbi, name: "WeightsUpdated" }) as AbiEvent,
  caseOpened: getAbiItem({ abi: docketAbi, name: "CaseOpened" }) as AbiEvent,
  verdict: getAbiItem({ abi: docketAbi, name: "Verdict" }) as AbiEvent,
  vetoed: getAbiItem({ abi: docketAbi, name: "Vetoed" }) as AbiEvent,
  overridden: getAbiItem({ abi: docketAbi, name: "Overridden" }) as AbiEvent,
  cast: getAbiItem({ abi: delegateAbi, name: "Cast" }) as AbiEvent,
};

// ---------------------------------------------------------------------------------------------------------------
// The loop, hop by hop

export type HopKey =
  | "proposed"
  | "reacted"
  | "opened"
  | "verdicts"
  | "tally"
  | "window"
  | "owner"
  | "requested"
  | "cast";

export interface Hop {
  key: HopKey;
  chainId: ChainId;
  state: "done" | "waiting" | "skipped" | "unread";
  txHash: Hex | null;
  at: number | null;
  detail: string | null;
  /** Additional transactions in this hop, such as each juror's verdict. */
  extra: { label: string; txHash: Hex; at: number }[];
}

export interface TraceInput {
  docket: DocketCase;
  reactive: ReactiveCase | null;
  vetoWindow: number | null;
  verdicts: VerdictRow[];
  proposalTimestamp: number | null;
}

const hop = (key: HopKey, chainId: ChainId, patch: Partial<Hop> = {}): Hop => ({
  key,
  chainId,
  state: "waiting",
  txHash: null,
  at: null,
  detail: null,
  extra: [],
  ...patch,
});

async function safely<T>(read: () => Promise<T>): Promise<T | "unread"> {
  try {
    return await read();
  } catch {
    return "unread";
  }
}

/** The recorded transactions of a live case (evidence/cases.csv), if this site's Docket is the one recorded. */
function recorded(caseId: bigint) {
  if (deployments.docket.address === null) return undefined;
  if (!isAddressEqual(evidenceIndex.docket, deployments.docket.address)) return undefined;
  return (evidenceIndex.cases as Record<string, RecordedCase | undefined>)[caseId.toString()];
}

type RecordedCase = {
  caseCreated: Hex | null;
  opened: Hex | null;
  verdicts: Record<string, Hex>;
  windowStarted: Hex | null;
  castRequested: Hex | null;
  castRequestedAt: number | null;
  cast: Hex | null;
  castAt: number | null;
  veto: Hex | null;
  vetoAt: number | null;
  override: Hex | null;
};

/** True when the transaction on `chainId` carries the Delegate's Cast for this case. One receipt, no scan. */
async function isCastFor(chainId: ChainId, txHash: Hex, delegate: Address, caseId: bigint): Promise<boolean> {
  const receipt = await publicClient(chainId).getTransactionReceipt({ hash: txHash });
  return receipt.logs.some((log) => {
    if (!isAddressEqual(log.address, delegate)) return false;
    try {
      const d = decodeEventLog({ abi: delegateAbi, data: log.data, topics: log.topics });
      return d.eventName === "Cast" && d.args.caseId === caseId;
    } catch {
      return false;
    }
  });
}

export async function readTrace(input: TraceInput): Promise<Hop[]> {
  const { docket, reactive } = input;
  const origin = isChainId(docket.originChainId) ? docket.originChainId : null;
  const rc = reactiveAddress();
  const dk = docketAddress();
  const caseArg = { caseId: docket.caseId };
  const now = Math.floor(Date.now() / 1000);
  const known = recorded(docket.caseId);

  const proposed = hop("proposed", origin ?? HEARING, {
    state: "done",
    txHash: docket.originTxHash,
    at: input.proposalTimestamp,
  });

  const createdAt = reactive?.createdAt ?? docket.openedAt;
  // dueAt is the window's end only while the case is in its window; afterwards Lasna reuses it for resends and
  // retries. The decision lands in the same Lasna second as the verdict that completes it, so a closed case's
  // window is found from its last verdict.
  const lastVerdictAt = input.verdicts.length > 0 ? Math.max(...input.verdicts.map((v) => v.postedAt)) : null;
  const windowStart = !reactive?.hasDecision
    ? null
    : reactive.status === 4 && reactive.dueAt > 0 && input.vetoWindow !== null
      ? reactive.dueAt - input.vetoWindow
      : lastVerdictAt;
  // Docket times are the block's own timestamps, so a few seconds of slack find the block on Base.
  const [reacted, opened, verdictLogs, ownerLogs] = await Promise.all([
    known?.caseCreated
      ? [{ txHash: known.caseCreated, blockNumber: 0n, timestamp: createdAt, args: {} }]
      : rc
        ? safely(() =>
            logsNear(REACTIVE, rc, ev.caseCreated, caseArg, createdAt - 60, createdAt + 60, { slack: 30 }),
          )
        : ("unread" as const),
    known?.opened
      ? [{ txHash: known.opened, blockNumber: 0n, timestamp: docket.openedAt, args: {} }]
      : safely(() =>
          logsNear(HEARING, dk, ev.caseOpened, caseArg, docket.openedAt, docket.openedAt, { slack: 4 }),
        ),
    Promise.all(
      input.verdicts.map(async (v) => {
        const tx = v.known ? known?.verdicts[String(v.known.id)] : undefined;
        if (tx) return { label: `Juror ${v.known?.id}`, txHash: tx, at: v.postedAt };
        const logs = await safely(() =>
          logsNear(
            HEARING,
            dk,
            ev.verdict,
            { caseId: docket.caseId, juror: v.juror },
            v.postedAt,
            v.postedAt,
            {
              slack: 4,
            },
          ),
        );
        const log = logs === "unread" ? undefined : logs[0];
        return log
          ? {
              label: v.known ? `Juror ${v.known.id}` : "Unlisted juror",
              txHash: log.txHash,
              at: log.timestamp,
            }
          : null;
      }),
    ),
    docket.ownerAction === 0
      ? []
      : known?.veto || known?.override
        ? [
            {
              txHash: (known.veto ?? known.override) as Hex,
              blockNumber: 0n,
              timestamp: known.vetoAt ?? 0,
              args: {},
            },
          ]
        : safely(() =>
            // A veto lands inside the window; an override any time after the case opened, so scan its first 20 minutes.
            docket.ownerAction === 1 && windowStart !== null
              ? logsNear(
                  HEARING,
                  dk,
                  ev.vetoed,
                  caseArg,
                  windowStart,
                  windowStart + (input.vetoWindow ?? 300),
                  {
                    maxRequests: 10,
                  },
                )
              : logsNear(
                  HEARING,
                  dk,
                  docket.ownerAction === 1 ? ev.vetoed : ev.overridden,
                  caseArg,
                  docket.openedAt,
                  Math.min(now, docket.openedAt + 1200),
                  { maxRequests: 40 },
                ),
          ),
  ]);

  const first = (r: FoundLog[] | "unread") => (r === "unread" ? undefined : r[0]);
  const reactedLog = first(reacted);
  const openedLog = first(opened);
  const hops: Hop[] = [
    proposed,
    hop(
      "reacted",
      REACTIVE,
      reactedLog
        ? { state: "done", txHash: reactedLog.txHash, at: reactedLog.timestamp }
        : { state: reactive ? "unread" : "waiting" },
    ),
    hop(
      "opened",
      HEARING,
      openedLog
        ? { state: "done", txHash: openedLog.txHash, at: openedLog.timestamp }
        : { state: "done", at: docket.openedAt },
    ),
  ];

  const extra = verdictLogs.filter((v): v is { label: string; txHash: Hex; at: number } => v !== null);
  hops.push(
    hop("verdicts", HEARING, {
      state: input.verdicts.length >= 3 ? "done" : "waiting",
      detail: `${input.verdicts.length} of ${knownJurors.length} posted`,
      at: input.verdicts.length > 0 ? Math.max(...input.verdicts.map((v) => v.postedAt)) : null,
      extra,
    }),
  );

  // The tally and the window are reactive transactions on Lasna, found from the window's start time.
  let windowHop = hop("window", REACTIVE);
  let tallyHop = hop("tally", REACTIVE);
  let windowEnd: number | null = null;
  if (rc && reactive && windowStart !== null) {
    const started = known?.windowStarted
      ? [{ txHash: known.windowStarted, blockNumber: 0n, timestamp: windowStart, args: {} }]
      : await safely(() =>
          logsNear(
            REACTIVE,
            rc,
            ev.windowStarted,
            caseArg,
            windowStart - 30,
            Math.min(now, windowStart + 30),
          ),
        );
    const log = first(started);
    const endsAt = typeof log?.args.endsAt === "bigint" ? Number(log.args.endsAt) : null;
    windowEnd = endsAt ?? (reactive.status === 4 ? reactive.dueAt : windowStart + (input.vetoWindow ?? 0));
    windowHop = hop("window", REACTIVE, {
      state: reactive.status === 4 ? "waiting" : "done",
      txHash: log?.txHash ?? null,
      at: log?.timestamp ?? windowStart,
      detail: `ends ${formatUtc(windowEnd)}`,
    });
    tallyHop = hop("tally", REACTIVE, {
      state: "done",
      txHash: log?.txHash ?? null,
      at: log?.timestamp ?? windowStart,
    });
  } else if (reactive && (reactive.status === 3 || reactive.status >= 7)) {
    tallyHop = hop("tally", REACTIVE, { state: "done" });
    windowHop = hop("window", REACTIVE, { state: "skipped" });
  }
  hops.push(tallyHop, windowHop);

  const ownerLog = first(ownerLogs);
  if (docket.ownerAction !== 0) {
    hops.push(
      hop("owner", HEARING, {
        state: ownerLog ? "done" : "unread",
        txHash: ownerLog?.txHash ?? null,
        at: ownerLog?.timestamp || null,
        detail: docket.ownerAction === 1 ? "vetoed" : "overridden",
      }),
    );
  }

  let requested = hop("requested", REACTIVE);
  let cast = hop("cast", origin ?? HEARING);
  if (rc && reactive?.castRequested) {
    // The request comes on the first cron tick after the window ends, or after an override; a deferred case
    // (voting not open yet) can wait longer, so the scan runs to now within its request budget.
    const from =
      (docket.ownerAction === 2
        ? ownerLog?.timestamp || docket.openedAt
        : (windowEnd ?? lastVerdictAt ?? createdAt)) - 30;
    const reqs = known?.castRequested
      ? [
          {
            txHash: known.castRequested,
            blockNumber: 0n,
            timestamp: known.castRequestedAt ?? from,
            args: {},
          },
        ]
      : await safely(() => logsNear(REACTIVE, rc, ev.castRequested, caseArg, from, now, { maxRequests: 30 }));
    const req = reqs === "unread" ? undefined : reqs[reqs.length - 1];
    requested = hop("requested", REACTIVE, {
      state: req ? "done" : "unread",
      txHash: req?.txHash ?? null,
      at: req?.timestamp ?? null,
    });
    if (origin && reactive.status === 7) {
      let found: { txHash: Hex; at: number } | undefined;
      if (
        known?.cast &&
        (await safely(() => isCastFor(origin, known.cast as Hex, docket.delegate, docket.caseId))) === true
      ) {
        found = { txHash: known.cast, at: known.castAt ?? req?.timestamp ?? 0 };
      } else {
        // The callback lands seconds after the request: scan from just before it to three minutes after.
        const at = req?.timestamp ?? from;
        const casts = await safely(() =>
          logsNear(origin, docket.delegate, ev.cast, caseArg, at - 10, Math.min(now, at + 180), { slack: 5 }),
        );
        const c = first(casts);
        if (c) found = { txHash: c.txHash, at: c.timestamp };
      }
      cast = hop("cast", origin, {
        state: found ? "done" : "unread",
        txHash: found?.txHash ?? null,
        at: found?.at ?? null,
      });
    }
  } else if (
    reactive &&
    (reactive.status === 8 || reactive.status === 9 || reactive.status === 10 || reactive.status === 3)
  ) {
    requested = hop("requested", REACTIVE, { state: "skipped" });
    cast = hop("cast", origin ?? HEARING, { state: "skipped" });
  }
  hops.push(requested, cast);
  return hops;
}

// ---------------------------------------------------------------------------------------------------------------
// The mandate

export interface MandateVersion {
  version: number;
  hash: Hex;
  setAt: number;
  uri: string;
}

export async function readMandates(): Promise<{
  current: number;
  versions: MandateVersion[];
  owner: Address;
}> {
  const client = publicClient(HEARING);
  const address = docketAddress();
  const [current, owner] = await onChain(HEARING, "the mandate", () =>
    Promise.all([
      client.readContract({ address, abi: docketAbi, functionName: "mandateVersion" }),
      client.readContract({ address, abi: docketAbi, functionName: "owner" }),
    ]),
  );
  const n = Number(current);
  const wanted = Array.from({ length: Math.min(n, 12) }, (_, i) => n - i);
  const versions = await onChain(HEARING, "mandate versions", () =>
    Promise.all(
      wanted.map(async (version) => {
        const m = await client.readContract({
          address,
          abi: docketAbi,
          functionName: "getMandate",
          args: [BigInt(version)],
        });
        return { version, hash: m.mandateHash, setAt: Number(m.setAt), uri: m.uri };
      }),
    ),
  );
  return { current: n, versions, owner };
}

/** Only these schemes are fetched from the browser; anything else is shown as an address, not loaded. */
export function resolveMandateUri(uri: string): string | null {
  if (uri.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${uri.slice("ipfs://".length)}`;
  try {
    const url = new URL(uri);
    if (url.protocol === "https:") return url.toString();
    if (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"))
      return url.toString();
    return null;
  } catch {
    return null;
  }
}

export type MandateText =
  | { state: "verified"; text: string }
  | { state: "mismatch"; text: string; computed: Hex }
  | { state: "unavailable"; reason: string };

export async function fetchMandateText(uri: string, expected: Hex): Promise<MandateText> {
  const url = resolveMandateUri(uri);
  if (url === null) return { state: "unavailable", reason: "the address is not an https or ipfs link" };
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return { state: "unavailable", reason: `HTTP ${res.status}` };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > 64 * 1024) return { state: "unavailable", reason: "the document is too large" };
    const text = new TextDecoder().decode(bytes);
    const computed = keccak256(bytes);
    return computed.toLowerCase() === expected.toLowerCase()
      ? { state: "verified", text }
      : { state: "mismatch", text, computed };
  } catch (err) {
    return { state: "unavailable", reason: err instanceof Error ? err.message : "network error" };
  }
}

export function hashText(text: string): Hex {
  return keccak256(toBytes(text));
}

// ---------------------------------------------------------------------------------------------------------------
// Juror weights over time

export interface WeightChange {
  caseId: bigint;
  txHash: Hex;
  at: number;
  weights: { juror: Address; weight: number }[];
}

export interface WeightHistory {
  bounds: { min: number; initial: number; max: number; step: number };
  current: { juror: Address; weight: number }[];
  changes: WeightChange[];
  scannedFrom: bigint;
  scannedTo: bigint;
}

/** Without a recorded deployment block, history covers this many recent Lasna blocks (about six days). */
const WEIGHT_SCAN_FALLBACK = 500_000n;

export async function readWeightHistory(): Promise<WeightHistory> {
  const rc = reactiveAddress();
  if (!rc) throw new Error("MandateReactive is not deployed");
  const client = publicClient(REACTIVE);
  const [bounds, latest, ...current] = await onChain(REACTIVE, "juror weights", () =>
    Promise.all([
      client.readContract({ address: rc, abi: mandateReactiveAbi, functionName: "weightBounds" }),
      client.getBlockNumber(),
      ...knownJurors.map((j) =>
        client.readContract({
          address: rc,
          abi: mandateReactiveAbi,
          functionName: "weightOf",
          args: [j.address],
        }),
      ),
    ]),
  );
  const start = deployments.reactive.startBlock;
  const from =
    start !== null ? BigInt(start) : latest > WEIGHT_SCAN_FALLBACK ? latest - WEIGHT_SCAN_FALLBACK : 0n;
  const chunk = chains[REACTIVE].logChunk;
  const logs = await onChain(REACTIVE, "weight history", async () => {
    const all: Log[] = [];
    for (let s = from; s <= latest; s += chunk) {
      const e = s + chunk - 1n > latest ? latest : s + chunk - 1n;
      all.push(
        ...(await client.getLogs({ address: rc, event: ev.weightsUpdated, fromBlock: s, toBlock: e })),
      );
    }
    return all;
  });
  const times = new Map<bigint, number>();
  await onChain(REACTIVE, "block times", () =>
    Promise.all(
      [...new Set(logs.map((l) => l.blockNumber).filter((b): b is bigint => b !== null))].map(async (b) => {
        times.set(b, Number((await client.getBlock({ blockNumber: b })).timestamp));
      }),
    ),
  );
  const changes: WeightChange[] = logs.flatMap((l) => {
    const args = (
      l as unknown as { args?: { caseId?: bigint; jurors?: readonly Address[]; weights?: readonly number[] } }
    ).args;
    if (
      !args?.jurors ||
      !args.weights ||
      args.caseId === undefined ||
      !l.transactionHash ||
      l.blockNumber === null
    )
      return [];
    const w = args.weights;
    return [
      {
        caseId: args.caseId,
        txHash: l.transactionHash,
        at: times.get(l.blockNumber) ?? 0,
        weights: args.jurors.map((juror, i) => ({ juror, weight: Number(w[i] ?? 0) })),
      },
    ];
  });
  return {
    bounds: {
      min: Number(bounds.min),
      initial: Number(bounds.initial),
      max: Number(bounds.max),
      step: Number(bounds.step),
    },
    current: knownJurors.map((j, i) => ({ juror: j.address, weight: Number(current[i] ?? 0) })),
    changes,
    scannedFrom: from,
    scannedTo: latest,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Following a fresh proposal to its case

export async function findCaseFor(
  chainId: number,
  governor: Address,
  proposalId: bigint,
): Promise<bigint | null> {
  const rc = reactiveAddress();
  if (!rc || !isChainId(chainId)) return null;
  const id = await onChain(REACTIVE, "the case id", () =>
    publicClient(REACTIVE).readContract({
      address: rc,
      abi: mandateReactiveAbi,
      functionName: "caseIdOf",
      args: [BigInt(chainId), governor, proposalId],
    }),
  );
  return id === 0n ? null : id;
}

export async function caseOpenedOnDocket(caseId: bigint): Promise<boolean> {
  const address = docketAddress();
  const raw = await onChain(HEARING, `case ${caseId}`, () =>
    publicClient(HEARING).readContract({ address, abi: docketAbi, functionName: "getCase", args: [caseId] }),
  );
  return raw.openedAt !== 0n;
}
