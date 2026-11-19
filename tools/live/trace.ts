/**
 * Traces every filed proposal of the live evidence run across Base Sepolia, Unichain Sepolia and Lasna and writes
 * evidence/cases.csv (one row per case, failures kept) plus evidence/live/trace.json (every hop with its raw stamp).
 *
 *   workers/node_modules/.bin/tsx tools/live/trace.ts
 *
 * Read-only: public RPCs, no key. Base logs are read in 150-block windows (the public RPC serves at most 200),
 * Unichain in 900, Lasna in 5,000. Lasna fees are the drop in the reactive contract's spendable funds
 * (balance + reserves - debt at the system contract) across each block that holds one of its transactions.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Abi,
  type Address,
  createPublicClient,
  decodeEventLog,
  type Hex,
  http,
  keccak256,
  type Log,
  type PublicClient,
  toHex,
} from "viem";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RPC: Record<number, string> = {
  84532: "https://sepolia.base.org",
  1301: "https://sepolia.unichain.org",
  5318007: "https://lasna-rpc.rnk.dev/",
};
const CHUNK: Record<number, bigint> = { 84532: 150n, 1301: 900n, 5318007: 5_000n };
const SYSTEM: Address = "0x8888888888888888888888888888888888888888";

function deployment(chain: number, key: string): Address {
  const lines = readFileSync(join(REPO, "contracts/deployments", `${chain}.env`), "utf8").split("\n");
  const hit = lines.filter((l) => l.startsWith(`${key}=`)).pop();
  if (hit === undefined) throw new Error(`${key} missing for ${chain}`);
  return hit.split("=")[1] as Address;
}
function abiOf(name: string): Abi {
  return JSON.parse(readFileSync(join(REPO, `contracts/out/${name}.sol/${name}.json`), "utf8")).abi as Abi;
}
const clients = new Map<number, PublicClient>();
function client(chain: number): PublicClient {
  let c = clients.get(chain);
  if (c === undefined) {
    c = createPublicClient({ transport: http(RPC[chain], { retryCount: 6, retryDelay: 1500, timeout: 60_000 }) });
    clients.set(chain, c);
  }
  return c;
}

type Decoded = {
  chain: number;
  name: string;
  args: Record<string, unknown>;
  tx: Hex;
  block: bigint;
  logIndex: number;
  ms?: number;
};

async function scan(chain: number, address: Address, abi: Abi, from: bigint): Promise<Decoded[]> {
  const c = client(chain);
  const head = await c.getBlockNumber();
  const out: Decoded[] = [];
  for (let a = from; a <= head; a += CHUNK[chain]) {
    const b = a + CHUNK[chain] - 1n > head ? head : a + CHUNK[chain] - 1n;
    const logs = (await c.request({
      method: "eth_getLogs",
      params: [{ address, fromBlock: toHex(a), toBlock: toHex(b) }],
    })) as (Log & { blockTimestampMs?: Hex })[];
    for (const l of logs) {
      try {
        const d = decodeEventLog({ abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
        out.push({
          chain,
          name: d.eventName,
          args: d.args as Record<string, unknown>,
          tx: l.transactionHash as Hex,
          block: BigInt(l.blockNumber as unknown as string),
          logIndex: Number(l.logIndex),
          ...(l.blockTimestampMs !== undefined ? { ms: Number(BigInt(l.blockTimestampMs)) } : {}),
        });
      } catch {
        // Not one of this contract's events (a library or proxy event with another ABI).
      }
    }
  }
  return out;
}

const stamps = new Map<string, number>();
/** Block time in ms: Base's native `timestampMs`, otherwise whole seconds * 1000. */
async function stampMs(chain: number, block: bigint, logMs?: number): Promise<number> {
  if (logMs !== undefined) return logMs;
  const key = `${chain}:${block}`;
  const hit = stamps.get(key);
  if (hit !== undefined) return hit;
  const b = (await client(chain).request({
    method: "eth_getBlockByNumber",
    params: [toHex(block), false],
  })) as { timestamp: Hex; timestampMs?: Hex };
  const ms = b.timestampMs !== undefined ? Number(BigInt(b.timestampMs)) : Number(BigInt(b.timestamp)) * 1000;
  stamps.set(key, ms);
  return ms;
}

const fundsAbi = [
  { type: "function", name: "reserves", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "debt", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
async function spendable(payer: Address, block: bigint): Promise<bigint> {
  const c = client(5318007);
  const [bal, res, debt] = await Promise.all([
    c.getBalance({ address: payer, blockNumber: block }),
    c.readContract({ address: SYSTEM, abi: fundsAbi, functionName: "reserves", args: [payer], blockNumber: block }),
    c.readContract({ address: SYSTEM, abi: fundsAbi, functionName: "debt", args: [payer], blockNumber: block }),
  ]);
  return bal + res - debt;
}
const feeCache = new Map<bigint, bigint | null>();
async function feeAt(rc: Address, block: bigint): Promise<bigint | null> {
  if (feeCache.has(block)) return feeCache.get(block) ?? null;
  let fee: bigint | null = null;
  try {
    fee = (await spendable(rc, block - 1n)) - (await spendable(rc, block));
  } catch {
    fee = null; // historical state not served
  }
  feeCache.set(block, fee);
  return fee;
}

interface Filed {
  label: string;
  intent: string;
  governorKey: string;
  chainId: number;
  governor: Address;
  proposalId: string;
  voteStart: string;
  voteEnd: string;
  tx: Hex;
  block: number;
  blockTimestamp: number;
  blockTimestampMs: number | null;
  source: string;
}

/** Juror addresses in juror-number order (docs/JURORS.md). */
const JURORS = [
  "0x1e1005c3ac959a66e8ce5423382fc7a28a24839f",
  "0xea5c14fac05aa8a4c9a3a4184ae6e17e65402f54",
  "0x1e0702541fc8cd645bf955fa5c26e4dfc0ef9fc7",
];
const SUPPORT = ["against", "for", "abstain"];
const STATUS = ["None", "Opening", "Open", "Held", "Window", "Waiting", "Casting", "Cast", "Vetoed", "Expired", "Failed"];
const REFUSAL = ["NotYetActive", "Ended", "StateUnavailable", "Superseded", "Paused", "CastReverted", "InvalidSupport"];

async function main(): Promise<void> {
  const filed: Filed[] = readFileSync(join(REPO, "evidence/proposals.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Filed);
  const rc = deployment(5318007, "MANDATE_REACTIVE");
  const docket = deployment(84532, "DOCKET");
  const delegates: Record<number, Address> = { 84532: deployment(84532, "DELEGATE"), 1301: deployment(1301, "DELEGATE") };
  const minBlock = (chain: number) => BigInt(Math.min(...filed.filter((f) => f.chainId === chain).map((f) => f.block)));

  const lasnaFrom = BigInt(process.env.LASNA_FROM ?? "8732400");
  const [rcLogs, docketLogs, baseDel, uniDel] = await Promise.all([
    scan(5318007, rc, abiOf("MandateReactive"), lasnaFrom),
    scan(84532, docket, abiOf("Docket"), minBlock(84532)),
    scan(84532, delegates[84532], abiOf("Delegate"), minBlock(84532)),
    filed.some((f) => f.chainId === 1301) ? scan(1301, delegates[1301], abiOf("Delegate"), minBlock(1301)) : [],
  ]);
  const delLogs = [...baseDel, ...uniDel];
  const caseOf = (d: Decoded) => (d.args.caseId as bigint | undefined)?.toString();

  // Lasna fees per block holding a reactive-contract tx, attributed to the case ids its logs name; a block with logs
  // for several cases (a cron tick) is split evenly, and a tick naming no case is shared overhead.
  const blocks = [...new Set(rcLogs.map((l) => l.block))].sort((a, b) => (a < b ? -1 : 1));
  const feeByCase = new Map<string, number>();
  let overhead = 0;
  let unknownFees = 0;
  for (const b of blocks) {
    const fee = await feeAt(rc, b);
    if (fee === null) {
      unknownFees += 1;
      continue;
    }
    const ids = [...new Set(rcLogs.filter((l) => l.block === b).map(caseOf).filter((x): x is string => x !== undefined))];
    const eth = Number(fee) / 1e18;
    if (ids.length === 0) overhead += eth;
    for (const id of ids) feeByCase.set(id, (feeByCase.get(id) ?? 0) + eth / ids.length);
  }

  const rows: Record<string, string>[] = [];
  const trace: unknown[] = [];
  for (const f of filed) {
    const created = rcLogs.find(
      (l) => l.name === "CaseCreated" && (l.args.proposalId as bigint).toString() === f.proposalId &&
        (l.args.governor as string).toLowerCase() === f.governor.toLowerCase(),
    );
    const skipped = rcLogs.find((l) => l.name === "ProposalSkipped" && (l.args.proposalId as bigint).toString() === f.proposalId);
    const id = created ? caseOf(created) : undefined;
    const mine = (logs: Decoded[]) => logs.filter((l) => id !== undefined && caseOf(l) === id);
    const r = mine(rcLogs);
    const d = mine(docketLogs);
    const g = mine(delLogs).filter((l) => l.chain === f.chainId);
    const ms = async (l: Decoded | undefined) => (l ? await stampMs(l.chain, l.block, l.ms) : undefined);

    const originMs = f.blockTimestampMs ?? f.blockTimestamp * 1000;
    const opened = d.find((l) => l.name === "CaseOpened");
    const verdicts = d.filter((l) => l.name === "Verdict").sort((a, b) => (a.block < b.block ? -1 : 1));
    const veto = d.find((l) => l.name === "Vetoed");
    const override = d.find((l) => l.name === "Overridden");
    const windows = r.filter((l) => l.name === "WindowStarted");
    const statuses = r.filter((l) => l.name === "CaseStatusChanged").map((l) => STATUS[Number(l.args.status)]);
    const finalStatus = statuses.at(-1) ?? (skipped ? "Skipped" : "NotSeen");
    const held = r.filter((l) => l.name === "CaseHeld").map((l) => ["None", "Injection", "Split"][Number(l.args.reason)]);
    const casts = g.filter((l) => l.name === "Cast");
    const refusals = g.filter((l) => l.name === "NotActive");
    const cancels = g.filter((l) => l.name === "Cancelled");
    const deferred = r.filter((l) => l.name === "CastDeferred");
    const tally = r.filter((l) => l.name === "TallyUpdated").at(-1);

    const verdictCells = await Promise.all(
      verdicts.map(async (v) => {
        const juror = (v.args.juror as string).toLowerCase();
        const n = JURORS.indexOf(juror) + 1;
        let model = "";
        let hashOk = "missing";
        try {
          const bytes = readFileSync(join(REPO, `evidence/rationales/${id}/juror-${n}.json`));
          const doc = JSON.parse(bytes.toString("utf8")) as { model?: string };
          model = doc.model ?? "";
          hashOk = keccak256(bytes) === v.args.rationaleHash ? "ok" : "MISMATCH";
        } catch {
          // rationale file not present locally
        }
        return {
          n,
          support: SUPPORT[Number(v.args.support)],
          confidence: Number(v.args.confidenceBps),
          injection: Boolean(v.args.injectionFlag),
          rationaleHash: v.args.rationaleHash as string,
          modelIdHash: v.args.modelIdHash as string,
          model,
          hashOk,
          tx: v.tx,
          ms: await ms(v),
        };
      }),
    );
    const castMs = await ms(casts[0]);
    const openMs = await ms(opened);
    const lastVerdictMs = verdictCells.at(-1)?.ms;
    const lasnaMs = async (name: string) => ms(r.find((l) => l.name === name));
    const createdLasnaMs = await ms(created);
    const windowLasnaMs = windows.length ? await ms(windows.at(-1)) : undefined;
    const windowEndsAt = windows.length ? Number(windows.at(-1)?.args.endsAt) * 1000 : undefined;
    const castReqLasnaMs = await lasnaMs("CastRequested");
    const ackLasnaMs = await lasnaMs("CastAcknowledged");
    const lreact = id !== undefined ? feeByCase.get(id) : undefined;
    const fmt = (x: number | undefined) => (x === undefined ? "" : String(x));
    const diff = (a: number | undefined, b: number | undefined) => (a === undefined || b === undefined ? "" : String(a - b));

    const outcome = (() => {
      if (!created) return skipped ? `skipped:${["Malformed", "Duplicate", "NoDelegate", "NoDocket", "Capacity", "GovernorCapacity", "RateLimited"][Number(skipped.args.reason)]}` : "no case";
      if (casts.length) return `cast ${SUPPORT[Number(casts[0].args.support)]}${override ? " (owner override)" : ""}`;
      if (finalStatus === "Vetoed") return "vetoed";
      if (finalStatus === "Held") return `held (${held.at(-1) ?? "?"})`;
      if (finalStatus === "Expired") return refusals.some((x) => Number(x.args.reason) === 1) ? "expired (voting ended)" : "expired";
      return finalStatus.toLowerCase();
    })();

    const row: Record<string, string> = {
      label: f.label,
      intent: f.intent,
      source: f.source,
      governor_chain: String(f.chainId),
      governor_key: f.governorKey,
      governor: f.governor,
      proposal_id: f.proposalId,
      vote_start: f.voteStart,
      vote_end: f.voteEnd,
      proposal_tx: f.tx,
      proposal_block: String(f.block),
      proposal_ms: String(originMs),
      proposal_clock: f.blockTimestampMs !== null ? "base-ms(200ms)" : "unichain-s(1s)",
      case_id: id ?? "",
      lasna_case_created_tx: created?.tx ?? "",
      lasna_case_created_ms: fmt(createdLasnaMs),
      lasna_txs: [...new Set(r.map((l) => l.tx))].join(" "),
      lasna_tx_count: String(new Set(r.map((l) => l.tx)).size),
      docket_open_tx: opened?.tx ?? "",
      docket_open_ms: fmt(openMs),
      ms_proposal_to_open: f.chainId === 84532 ? diff(openMs, originMs) : "",
      verdicts: verdictCells
        .map((v) => `j${v.n}:${v.support}@${v.confidence}${v.injection ? ":INJ" : ""}`)
        .join(" "),
      verdict_txs: verdictCells.map((v) => `j${v.n}:${v.tx}`).join(" "),
      verdict_ms: verdictCells.map((v) => `j${v.n}:${v.ms}`).join(" "),
      verdict_models: verdictCells.map((v) => `j${v.n}:${v.model}`).join(" "),
      rationale_hashes: verdictCells.map((v) => `j${v.n}:${v.rationaleHash}:${v.hashOk}`).join(" "),
      ms_open_to_last_verdict: diff(lastVerdictMs, openMs),
      tally_last: tally
        ? `against=${tally.args.againstWeight} for=${tally.args.forWeight} abstain=${tally.args.abstainWeight} low=${tally.args.lowConfidenceWeight} n=${tally.args.ballots}`
        : "",
      held: held.join(" "),
      window_started_txs: windows.map((w) => w.tx).join(" "),
      window_started_lasna_ms: fmt(windowLasnaMs),
      window_ends_at_ms: fmt(windowEndsAt),
      decision: windows.length ? SUPPORT[Number(windows.at(-1)?.args.support)] : "",
      deferred_until: deferred.map((x) => String(x.args.until)).join(" "),
      veto_tx: veto?.tx ?? "",
      veto_ms: fmt(await ms(veto)),
      override_tx: override?.tx ?? "",
      override_support: override ? SUPPORT[Number(override.args.support)] : "",
      cast_requested_lasna_ms: fmt(castReqLasnaMs),
      cast_requested_txs: r.filter((l) => l.name === "CastRequested").map((l) => l.tx).join(" "),
      refusals: refusals.map((x) => `${REFUSAL[Number(x.args.reason)]}:${x.tx}`).join(" "),
      cancels: cancels.map((x) => x.tx).join(" "),
      cast_tx: casts[0]?.tx ?? "",
      cast_ms: fmt(castMs),
      cast_clock: casts.length ? (f.chainId === 84532 ? "base-ms(200ms)" : "unichain-s(1s)") : "",
      cast_ack_lasna_ms: fmt(ackLasnaMs),
      ms_proposal_to_cast_same_clock: diff(castMs, originMs),
      ms_window_end_to_cast_raw: diff(castMs, windowEndsAt),
      statuses: statuses.join(">"),
      final_status: finalStatus,
      lreact: lreact === undefined ? "" : lreact.toFixed(6),
      outcome,
    };
    rows.push(row);
    trace.push({ filed: f, row, lasna: r, docket: d, delegate: g });
  }

  const cols = Object.keys(rows[0] ?? {});
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  writeFileSync(join(REPO, "evidence/cases.csv"), `${[cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c] ?? "")).join(","))].join("\n")}\n`);
  writeFileSync(
    join(REPO, "evidence/live/trace.json"),
    `${JSON.stringify({ tracedAt: new Date().toISOString(), lasnaOverheadLreact: overhead, lasnaBlocksWithoutFee: unknownFees, cases: trace }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`,
  );
  for (const r of rows) console.log(`${r.label} case ${r.case_id} ${r.verdicts} -> ${r.outcome} lREACT ${r.lreact}`);
  console.log(`shared overhead (ticks naming no case): ${overhead.toFixed(6)} lREACT; blocks without fee data: ${unknownFees}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
