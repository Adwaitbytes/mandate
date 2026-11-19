/**
 * Rebuilds every row of evidence/cases.csv from chain data alone: the filing's receipt on the governor chain, the
 * reactive contract's logs on Lasna, the Docket's logs on Base and both Delegates' logs, joined by case id. Row
 * semantics follow tools/live/trace.ts, which wrote the file. Rows are rebuilt as of the moment of that trace
 * (evidence/live/trace.json `tracedAt`); anything the chain recorded later is reported separately, because a held
 * case can still expire or be overridden after the evidence was written.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  type Hex,
  hexToBigInt,
  isAddressEqual,
  keccak256,
  toBytes,
} from "viem";
import { decodeProposalCreated } from "../../../workers/src/chain/proposal.ts";
import { renderProposal } from "../../../workers/src/proposal.ts";
import { type Hops, hopsOf } from "../../judge/lib/summary.ts";
import {
  caseIdOf,
  type Decoded,
  decodeAll,
  delegateAbi,
  docketAbi,
  fundsAbi,
  HOLD_REASON,
  proposalCreatedAbi,
  REFUSAL,
  reactiveAbi,
  SKIP_REASON,
  STATUS,
  SUPPORT,
} from "./abi.ts";
import {
  BASE,
  type ChainId,
  deployment,
  FUNDS_SERVICE,
  JURORS,
  LASNA,
  REPO,
  readJsonl,
  repoPath,
  UNICHAIN,
} from "./repo.ts";
import * as rpc from "./rpc.ts";

export interface Filed {
  label: string;
  intent: string;
  governorKey: string;
  chainId: number;
  governor: string;
  proposalId: string;
  voteStart: string;
  voteEnd: string;
  tx: Hex;
  block: number;
  blockTimestamp: number;
  blockTimestampMs: number | null;
  source: string;
}

export interface Finding {
  where: string;
  field: string;
  expected: string;
  actual: string;
}

export interface VerdictCheck {
  caseId: string;
  juror: number;
  tx: Hex;
  rationaleFile: string;
  rationaleHash: "ok" | "MISMATCH" | "missing";
  modelIdHash: "ok" | "MISMATCH";
  promptHash: "ok" | "MISMATCH";
  model: string;
  promptFile: string;
}

export interface ChainResult {
  snapshot: { tracedAt: string; blocks: Record<string, string> };
  rows: Record<string, string>[];
  hops: Record<string, Hops>;
  mandateSet: { version: string; hash: string; uri: string } | null;
  findings: Finding[];
  verdicts: VerdictCheck[];
  proposalsChecked: number;
  untrackedCases: string[];
  laterEvents: { caseId: string; label: string; event: string; tx: Hex; chain: number }[];
  weightsAtSnapshot: Record<string, number>;
  jurorGasWei: Record<string, string>;
  lasnaBlocksWithoutFee: number;
  unknownLogs: number;
}

/** keccak256 of the prompt file as it is now and of every version git has of it. */
function promptHashes(file: string): Set<string> {
  const path = `workers/prompts/${file}`;
  const out = new Set<string>([keccak256(readFileSync(repoPath(path)))]);
  const commits = execFileSync("git", ["log", "--format=%H", "--", path], { cwd: REPO, encoding: "utf8" });
  for (const c of commits.split("\n").filter(Boolean)) {
    out.add(keccak256(execFileSync("git", ["show", `${c}:${path}`], { cwd: REPO })));
  }
  return out;
}

/** balance + reserves - debt at the system contract (Lasna) or the callback proxy (destination chains). */
export async function spendableAt(chain: ChainId, payer: Hex, n: bigint): Promise<bigint> {
  const service = FUNDS_SERVICE[chain];
  const word = async (functionName: "reserves" | "debt") =>
    hexToBigInt(
      await rpc.callAt(chain, service, encodeFunctionData({ abi: fundsAbi, functionName, args: [payer] }), n),
    );
  const [bal, res, debt] = await Promise.all([
    rpc.balanceAt(chain, payer, n),
    word("reserves"),
    word("debt"),
  ]);
  return bal + res - debt;
}

export async function rebuildCases(deployBlocks: Record<string, bigint>): Promise<ChainResult> {
  const filed = readJsonl<Filed>("evidence/proposals.jsonl");
  const trace = JSON.parse(readFileSync(repoPath("evidence/live/trace.json"), "utf8")) as {
    tracedAt: string;
  };
  const tracedMs = Date.parse(trace.tracedAt);
  const findings: Finding[] = [];
  const mismatch = (where: string, field: string, expected: unknown, actual: unknown) => {
    if (String(expected) !== String(actual)) {
      findings.push({ where, field, expected: String(expected), actual: String(actual) });
    }
  };

  const rc = deployment(LASNA, "MANDATE_REACTIVE");
  const docket = deployment(BASE, "DOCKET");
  const delegates: Record<number, Hex> = {
    [BASE]: deployment(BASE, "DELEGATE"),
    [UNICHAIN]: deployment(UNICHAIN, "DELEGATE"),
  };
  const start = (key: string): bigint => {
    const b = deployBlocks[key];
    if (b === undefined) throw new Error(`no deploy block for ${key}`);
    return b;
  };

  const snap = {
    [LASNA]: await rpc.blockAtOrBefore(LASNA, tracedMs, start("lasna:MandateReactive")),
    [BASE]: await rpc.blockAtOrBefore(BASE, tracedMs, start("base:Docket")),
    [UNICHAIN]: await rpc.blockAtOrBefore(UNICHAIN, tracedMs, start("unichain:Delegate")),
  } as Record<ChainId, bigint>;

  const scan = async (chain: ChainId, address: Hex, abi: Parameters<typeof decodeAll>[0], from: bigint) => {
    const raw = await rpc.logs(chain, address, from, await rpc.head(chain));
    const { decoded, unknown } = decodeAll(abi, raw);
    return { all: decoded.map((d) => ({ ...d, chain })), unknown };
  };
  const [rcScan, docketScan, baseDelScan, uniDelScan] = await Promise.all([
    scan(LASNA, rc, reactiveAbi, start("lasna:MandateReactive")),
    scan(BASE, docket, docketAbi, start("base:Docket")),
    scan(BASE, delegates[BASE] as Hex, delegateAbi, start("base:Delegate")),
    scan(UNICHAIN, delegates[UNICHAIN] as Hex, delegateAbi, start("unichain:Delegate")),
  ]);
  type ChainLog = Decoded & { chain: ChainId };
  const atSnapshot = (l: ChainLog) => l.block <= snap[l.chain];
  const rcAll: ChainLog[] = rcScan.all;
  const docketAll: ChainLog[] = docketScan.all;
  const delAll: ChainLog[] = [...baseDelScan.all, ...uniDelScan.all];
  const rcLogs = rcAll.filter(atSnapshot);
  const docketLogs = docketAll.filter(atSnapshot);
  const delLogs = delAll.filter(atSnapshot);

  const stamp = (l: ChainLog | undefined) =>
    l === undefined ? Promise.resolve(undefined) : rpc.blockMs(l.chain, l.block);

  // Lasna fees: the drop in the reactive contract's spendable funds across each block holding one of its logs,
  // split evenly between the case ids that block's logs name (tools/live/trace.ts).
  const feeBlocks = [...new Set(rcLogs.map((l) => l.block))].sort((a, b) => (a < b ? -1 : 1));
  const fees = await Promise.all(
    feeBlocks.map(async (b) => {
      try {
        return (await spendableAt(LASNA, rc, b - 1n)) - (await spendableAt(LASNA, rc, b));
      } catch {
        return null;
      }
    }),
  );
  const feeByCase = new Map<string, number>();
  let lasnaBlocksWithoutFee = 0;
  feeBlocks.forEach((b, i) => {
    const fee = fees[i];
    if (fee === null || fee === undefined) {
      lasnaBlocksWithoutFee++;
      return;
    }
    const ids = [
      ...new Set(
        rcLogs
          .filter((l) => l.block === b)
          .map(caseIdOf)
          .filter((x) => x !== undefined),
      ),
    ];
    const eth = Number(fee) / 1e18;
    for (const id of ids) feeByCase.set(id as string, (feeByCase.get(id as string) ?? 0) + eth / ids.length);
  });

  // Warm the cache in parallel: every block stamp and receipt the per-case loop below reads one by one.
  await Promise.all([
    ...[
      ...new Map(
        [...rcLogs, ...docketLogs, ...delLogs]
          .filter((l) => caseIdOf(l) !== undefined)
          .map((l) => [`${l.chain}:${l.block}`, l]),
      ).values(),
    ].map((l) => rpc.blockMs(l.chain, l.block)),
    ...docketLogs.filter((l) => l.name === "Verdict").map((l) => rpc.receipt(BASE, l.tx)),
    ...filed.map((f) => rpc.receipt(f.chainId as ChainId, f.tx)),
  ]);

  const prompts = new Map<string, Set<string>>();
  const verdictChecks: VerdictCheck[] = [];
  const jurorGas = new Map<string, bigint>();
  const rows: Record<string, string>[] = [];
  const hops: Record<string, Hops> = {};
  const trackedIds = new Set<string>();
  let proposalsChecked = 0;

  for (const f of filed) {
    const chain = f.chainId as ChainId;
    const where = `${f.label}`;

    // The filing itself, re-read from the governor chain.
    const rec = await rpc.receipt(chain, f.tx);
    if (rec === null) {
      findings.push({ where, field: "proposal_tx", expected: "a receipt", actual: "none" });
      continue;
    }
    mismatch(where, "proposal_tx status", "0x1", rec.status);
    mismatch(where, "proposal_block", f.block, hexToBigInt(rec.blockNumber));
    const pcLog = rec.logs.find((l) => {
      if (!isAddressEqual(l.address, getAddress(f.governor))) return false;
      try {
        decodeEventLog({ abi: proposalCreatedAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
        return true;
      } catch {
        return false;
      }
    });
    if (pcLog === undefined) {
      findings.push({ where, field: "ProposalCreated", expected: "in the filing receipt", actual: "absent" });
      continue;
    }
    const proposal = decodeProposalCreated({
      address: pcLog.address,
      topics: pcLog.topics as [Hex, ...Hex[]],
      data: pcLog.data,
      transactionHash: pcLog.transactionHash,
      blockNumber: hexToBigInt(pcLog.blockNumber),
    });
    mismatch(where, "proposal_id", f.proposalId, proposal.proposalId);
    mismatch(where, "vote_start", f.voteStart, proposal.voteStart);
    mismatch(where, "vote_end", f.voteEnd, proposal.voteEnd);
    const originMs = await rpc.blockMs(chain, hexToBigInt(rec.blockNumber));
    mismatch(
      where,
      "proposals.jsonl blockTimestampMs",
      f.blockTimestampMs ?? f.blockTimestamp * 1000,
      originMs,
    );
    const proposalTextHash = keccak256(toBytes(renderProposal(proposal)));
    proposalsChecked++;

    const created = rcLogs.find(
      (l) =>
        l.name === "CaseCreated" &&
        (l.args.proposalId as bigint).toString() === f.proposalId &&
        isAddressEqual(l.args.governor as Hex, getAddress(f.governor)),
    );
    const skipped = rcLogs.find(
      (l) => l.name === "ProposalSkipped" && (l.args.proposalId as bigint).toString() === f.proposalId,
    );
    const id = created ? caseIdOf(created) : undefined;
    if (id !== undefined) trackedIds.add(id);
    const mine = (ls: ChainLog[]) => ls.filter((l) => id !== undefined && caseIdOf(l) === id);
    const r = mine(rcLogs);
    if (id !== undefined) hops[id] = hopsOf(r);
    const d = mine(docketLogs);
    const g = mine(delLogs).filter((l) => l.chain === chain);

    if (created) {
      mismatch(
        where,
        "CaseCreated originTxHash",
        f.tx.toLowerCase(),
        `0x${(created.args.originTxHash as bigint).toString(16).padStart(64, "0")}`,
      );
      mismatch(where, "CaseCreated originChainId", f.chainId, created.args.originChainId);
    }
    const opened = d.find((l) => l.name === "CaseOpened");
    if (opened) {
      mismatch(
        where,
        "CaseOpened originTxHash",
        f.tx.toLowerCase(),
        (opened.args.originTxHash as string).toLowerCase(),
      );
      mismatch(where, "CaseOpened proposalId", f.proposalId, opened.args.proposalId);
      mismatch(where, "CaseOpened delegate", delegates[chain], getAddress(opened.args.delegate as Hex));
    }
    const verdicts = d
      .filter((l) => l.name === "Verdict")
      .sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));
    const veto = d.find((l) => l.name === "Vetoed");
    const override = d.find((l) => l.name === "Overridden");
    const windows = r.filter((l) => l.name === "WindowStarted");
    const statuses = r
      .filter((l) => l.name === "CaseStatusChanged")
      .map((l) => STATUS[Number(l.args.status)]);
    const finalStatus = statuses.at(-1) ?? (skipped ? "Skipped" : "NotSeen");
    const held = r.filter((l) => l.name === "CaseHeld").map((l) => HOLD_REASON[Number(l.args.reason)]);
    const casts = g.filter((l) => l.name === "Cast");
    const refusals = g.filter((l) => l.name === "NotActive");
    const cancels = g.filter((l) => l.name === "Cancelled");
    const deferred = r.filter((l) => l.name === "CastDeferred");
    const tally = r.filter((l) => l.name === "TallyUpdated").at(-1);

    const cells: {
      n: number;
      support: string;
      confidence: number;
      injection: boolean;
      hash: string;
      ok: string;
      model: string;
      tx: Hex;
      ms: number | undefined;
    }[] = [];
    for (const v of verdicts) {
      const juror = getAddress(v.args.juror as Hex);
      const n = JURORS.findIndex((j) => isAddressEqual(j, juror)) + 1;
      const file = `evidence/rationales/${id}/juror-${n}.json`;
      let model = "";
      let hashOk: VerdictCheck["rationaleHash"] = "missing";
      let modelOk: VerdictCheck["modelIdHash"] = "MISMATCH";
      let promptOk: VerdictCheck["promptHash"] = "MISMATCH";
      let promptFile = "";
      try {
        const bytes = readFileSync(repoPath(file));
        const doc = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
        model = String(doc.model ?? "");
        promptFile = String(doc.promptFile ?? "");
        hashOk = keccak256(bytes) === v.args.rationaleHash ? "ok" : "MISMATCH";
        const modelHash = keccak256(toBytes(model));
        modelOk =
          modelHash === v.args.modelIdHash && doc.modelIdHash === v.args.modelIdHash ? "ok" : "MISMATCH";
        if (!prompts.has(promptFile)) prompts.set(promptFile, promptHashes(promptFile));
        promptOk =
          prompts.get(promptFile)?.has(v.args.promptHash as string) === true &&
          doc.promptHash === v.args.promptHash
            ? "ok"
            : "MISMATCH";
        const w = `${where} juror ${n}`;
        mismatch(w, "rationale support", v.args.support, doc.support);
        mismatch(w, "rationale confidenceBps", v.args.confidenceBps, doc.confidenceBps);
        mismatch(w, "rationale injectionFlag", v.args.injectionFlag, doc.injectionFlag);
        mismatch(w, "rationale caseId", id, doc.caseId);
        mismatch(w, "rationale juror", juror, getAddress(String(doc.juror)));
        mismatch(w, "rationale proposalTextHash vs chain", proposalTextHash, doc.proposalTextHash);
        mismatch(w, "rationale mandateHash vs CaseOpened", opened?.args.mandateHash, doc.mandateHash);
        const recorded = JSON.parse(
          readFileSync(repoPath(`evidence/cases/${id}/verdicts/juror-${n}.json`), "utf8"),
        ) as Record<string, unknown>;
        mismatch(w, "verdicts/juror json txHash", v.tx, recorded.txHash);
        mismatch(w, "verdicts/juror json blockNumber", v.block, recorded.blockNumber);
        mismatch(w, "verdicts/juror json rationaleHash", v.args.rationaleHash, recorded.rationaleHash);
      } catch (e) {
        findings.push({
          where: `${where} juror ${n}`,
          field: "rationale files",
          expected: "readable",
          actual: (e as Error).message,
        });
      }
      for (const [field, value] of [
        ["rationaleHash", hashOk],
        ["modelIdHash", modelOk],
        ["promptHash", promptOk],
      ] as const) {
        if (value !== "ok")
          findings.push({ where: `${where} juror ${n}`, field, expected: "ok", actual: value });
      }
      verdictChecks.push({
        caseId: id ?? "",
        juror: n,
        tx: v.tx,
        rationaleFile: file,
        rationaleHash: hashOk,
        modelIdHash: modelOk,
        promptHash: promptOk,
        model,
        promptFile,
      });
      const vr = await rpc.receipt(BASE, v.tx);
      if (vr !== null) {
        const fee =
          hexToBigInt(vr.gasUsed) * hexToBigInt(vr.effectiveGasPrice) +
          (vr.l1Fee ? hexToBigInt(vr.l1Fee) : 0n);
        jurorGas.set(String(n), (jurorGas.get(String(n)) ?? 0n) + fee);
      }
      cells.push({
        n,
        support: SUPPORT[Number(v.args.support)] ?? "?",
        confidence: Number(v.args.confidenceBps),
        injection: Boolean(v.args.injectionFlag),
        hash: v.args.rationaleHash as string,
        ok: hashOk,
        model,
        tx: v.tx,
        ms: await stamp(v),
      });
    }
    const caseText = (() => {
      try {
        return readFileSync(repoPath(`evidence/cases/${id}/proposal.txt`), "utf8");
      } catch {
        return undefined;
      }
    })();
    if (id !== undefined)
      mismatch(
        where,
        "evidence/cases proposal.txt hash vs chain",
        proposalTextHash,
        caseText === undefined ? "missing" : keccak256(toBytes(caseText)),
      );

    const castMs = await stamp(casts[0]);
    const openMs = await stamp(opened);
    const lastVerdictMs = cells.at(-1)?.ms;
    const windowLasnaMs = windows.length ? await stamp(windows.at(-1)) : undefined;
    const windowEndsAt = windows.length ? Number(windows.at(-1)?.args.endsAt) * 1000 : undefined;
    const fmt = (x: number | undefined) => (x === undefined ? "" : String(x));
    const diff = (a: number | undefined, b: number | undefined) =>
      a === undefined || b === undefined ? "" : String(a - b);
    const lreact = id !== undefined ? feeByCase.get(id) : undefined;

    const outcome = (() => {
      if (!created) {
        return skipped ? `skipped:${SKIP_REASON[Number(skipped.args.reason)]}` : "no case";
      }
      if (casts.length)
        return `cast ${SUPPORT[Number(casts[0]?.args.support)]}${override ? " (owner override)" : ""}`;
      if (finalStatus === "Vetoed") return "vetoed";
      if (finalStatus === "Held") return `held (${held.at(-1) ?? "?"})`;
      if (finalStatus === "Expired") {
        return refusals.some((x) => REFUSAL[Number(x.args.reason)] === "Ended")
          ? "expired (voting ended)"
          : "expired";
      }
      return finalStatus.toLowerCase();
    })();

    rows.push({
      label: f.label,
      intent: f.intent,
      source: f.source,
      governor_chain: String(f.chainId),
      governor_key: f.governorKey,
      governor: f.governor,
      proposal_id: proposal.proposalId.toString(),
      vote_start: proposal.voteStart.toString(),
      vote_end: proposal.voteEnd.toString(),
      proposal_tx: rec.transactionHash,
      proposal_block: hexToBigInt(rec.blockNumber).toString(),
      proposal_ms: String(originMs),
      proposal_clock: chain === BASE ? "base-ms(200ms)" : "unichain-s(1s)",
      case_id: id ?? "",
      lasna_case_created_tx: created?.tx ?? "",
      lasna_case_created_ms: fmt(await stamp(created)),
      lasna_txs: [...new Set(r.map((l) => l.tx))].join(" "),
      lasna_tx_count: String(new Set(r.map((l) => l.tx)).size),
      docket_open_tx: opened?.tx ?? "",
      docket_open_ms: fmt(openMs),
      ms_proposal_to_open: chain === BASE ? diff(openMs, originMs) : "",
      verdicts: cells
        .map((v) => `j${v.n}:${v.support}@${v.confidence}${v.injection ? ":INJ" : ""}`)
        .join(" "),
      verdict_txs: cells.map((v) => `j${v.n}:${v.tx}`).join(" "),
      verdict_ms: cells.map((v) => `j${v.n}:${v.ms}`).join(" "),
      verdict_models: cells.map((v) => `j${v.n}:${v.model}`).join(" "),
      rationale_hashes: cells.map((v) => `j${v.n}:${v.hash}:${v.ok}`).join(" "),
      ms_open_to_last_verdict: diff(lastVerdictMs, openMs),
      tally_last: tally
        ? `against=${tally.args.againstWeight} for=${tally.args.forWeight} abstain=${tally.args.abstainWeight} low=${tally.args.lowConfidenceWeight} n=${tally.args.ballots}`
        : "",
      held: held.join(" "),
      window_started_txs: windows.map((w) => w.tx).join(" "),
      window_started_lasna_ms: fmt(windowLasnaMs),
      window_ends_at_ms: fmt(windowEndsAt),
      decision: windows.length ? (SUPPORT[Number(windows.at(-1)?.args.support)] ?? "?") : "",
      deferred_until: deferred.map((x) => String(x.args.until)).join(" "),
      veto_tx: veto?.tx ?? "",
      veto_ms: fmt(await stamp(veto)),
      override_tx: override?.tx ?? "",
      override_support: override ? (SUPPORT[Number(override.args.support)] ?? "?") : "",
      cast_requested_lasna_ms: fmt(await stamp(r.find((l) => l.name === "CastRequested"))),
      cast_requested_txs: r
        .filter((l) => l.name === "CastRequested")
        .map((l) => l.tx)
        .join(" "),
      refusals: refusals.map((x) => `${REFUSAL[Number(x.args.reason)]}:${x.tx}`).join(" "),
      cancels: cancels.map((x) => x.tx).join(" "),
      cast_tx: casts[0]?.tx ?? "",
      cast_ms: fmt(castMs),
      cast_clock: casts.length ? (chain === BASE ? "base-ms(200ms)" : "unichain-s(1s)") : "",
      cast_ack_lasna_ms: fmt(await stamp(r.find((l) => l.name === "CastAcknowledged"))),
      ms_proposal_to_cast_same_clock: diff(castMs, originMs),
      ms_window_end_to_cast_raw: diff(castMs, windowEndsAt),
      statuses: statuses.join(">"),
      final_status: finalStatus,
      lreact: lreact === undefined ? "" : lreact.toFixed(6),
      outcome,
    });
  }

  // Cases on chain that no evidence row covers (for example proposals filed from the live site), and events
  // after the trace that touch a tracked case.
  const allCreated = rcAll.filter((l) => l.name === "CaseCreated").map((l) => caseIdOf(l) as string);
  const untrackedCases = [...new Set(allCreated)].filter((x) => !trackedIds.has(x));
  const labelOf = new Map(rows.map((r) => [r.case_id as string, r.label as string]));
  const laterEvents = [...rcAll, ...docketAll, ...delAll]
    .filter((l) => !atSnapshot(l) && trackedIds.has(caseIdOf(l) ?? ""))
    .map((l) => ({
      caseId: caseIdOf(l) as string,
      label: labelOf.get(caseIdOf(l) as string) ?? "",
      event: l.name === "CaseStatusChanged" ? `CaseStatusChanged(${STATUS[Number(l.args.status)]})` : l.name,
      tx: l.tx,
      chain: l.chain,
    }));

  const lastWeights = rcLogs.filter((l) => l.name === "WeightsUpdated").at(-1);
  const weightsAtSnapshot: Record<string, number> = {};
  if (lastWeights) {
    const js = lastWeights.args.jurors as Hex[];
    const ws = lastWeights.args.weights as number[];
    js.forEach((j, i) => {
      weightsAtSnapshot[String(JURORS.findIndex((x) => isAddressEqual(x, j)) + 1)] = Number(ws[i]);
    });
  }

  const mandateLog = docketLogs.filter((l) => l.name === "MandateSet").at(-1);
  const mandateSet = mandateLog
    ? {
        version: String(mandateLog.args.version),
        hash: String(mandateLog.args.mandateHash),
        uri: String(mandateLog.args.uri),
      }
    : null;

  return {
    hops,
    mandateSet,
    snapshot: {
      tracedAt: trace.tracedAt,
      blocks: Object.fromEntries(Object.entries(snap).map(([k, v]) => [k, v.toString()])),
    },
    rows,
    findings,
    verdicts: verdictChecks,
    proposalsChecked,
    untrackedCases,
    laterEvents,
    weightsAtSnapshot,
    jurorGasWei: Object.fromEntries([...jurorGas].map(([k, v]) => [k, v.toString()])),
    lasnaBlocksWithoutFee,
    unknownLogs: rcScan.unknown + docketScan.unknown + baseDelScan.unknown + uniDelScan.unknown,
  };
}
