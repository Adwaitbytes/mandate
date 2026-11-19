/**
 * make verify: rebuilds every published number from public RPC data and the committed evidence, compares it with
 * evidence/cases.csv, evidence/summary.json, evidence/live/stats.json, docs/FIRST_CASES.md, docs/DEPLOYMENTS.md and
 * the site's generated evidence index, checks Sourcify, re-hashes every rationale against its Verdict event,
 * recomputes the evaluation from its CSVs, and checks that README.md and JUDGE.md are what the generator writes.
 * Writes evidence/verify-report.json and exits 1 on any mismatch.
 *
 *   make verify            # receipts, blocks and final log ranges cached under tools/verify/.cache
 *   make verify FRESH=1    # ignore the cache
 */
import { readFileSync, writeFileSync } from "node:fs";
import { keccak256 } from "viem";
import { type Row, summarizeRun } from "../judge/lib/summary.ts";
import { renderAll } from "../judge/render.ts";
import { buildSummary, readSummary } from "../judge/summary.ts";
import { type ChainResult, rebuildCases, spendableAt } from "./lib/cases.ts";
import { parseCsv } from "./lib/csv.ts";
import { checkDeployments, loadDeployments } from "./lib/deployments.ts";
import { type Claim, checkFirstCases, checkWebEvidence } from "./lib/docclaims.ts";
import { checkCard } from "./lib/evalcheck.ts";
import { checkReplays } from "./lib/replays.ts";
import {
  BASE,
  type ChainId,
  deployment,
  LASNA,
  readJsonl,
  readText,
  repoPath,
  UNICHAIN,
} from "./lib/repo.ts";
import * as rpc from "./lib/rpc.ts";
import { stepStats } from "./lib/steps.ts";

interface Section {
  name: string;
  checked: number;
  mismatches: { where: string; expected: string; actual: string }[];
  notes?: string[];
  detail?: unknown;
}

const sections: Section[] = [];
const started = Date.now();

function section(name: string): Section {
  const s: Section = { name, checked: 0, mismatches: [] };
  sections.push(s);
  return s;
}

function compare(s: Section, where: string, expected: unknown, actual: unknown): void {
  s.checked++;
  const e = typeof expected === "string" ? expected : JSON.stringify(expected);
  const a = typeof actual === "string" ? actual : JSON.stringify(actual);
  if (e !== a) s.mismatches.push({ where, expected: e, actual: a });
}

function claimsInto(s: Section, claims: Claim[]): void {
  for (const c of claims) {
    s.checked++;
    if (!c.ok) s.mismatches.push({ where: `${c.doc}: ${c.claim}`, expected: c.expected, actual: c.actual });
  }
}

async function main(): Promise<void> {
  const log = (m: string) =>
    console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)} s] ${m}`);

  // 1. Contracts: deploy receipts, code, gas, Sourcify.
  log("deployments: receipts, code and Sourcify");
  const parsed = loadDeployments();
  const dep = await checkDeployments(parsed);
  const sDep = section("deployments (docs/DEPLOYMENTS.md)");
  for (const c of dep.contracts) {
    const w = `${c.chainId} ${c.name} ${c.address}`;
    compare(sDep, `${w} deploy receipt status`, true, c.receiptOk);
    compare(sDep, `${w} created by its deploy tx`, true, c.createdAddress);
    compare(sDep, `${w} has code`, true, c.hasCode);
    if (c.gasOk !== null) compare(sDep, `${w} gas used`, true, c.gasOk);
    compare(
      sDep,
      `${w} Sourcify`,
      "match or exact_match",
      c.sourcify === "match" || c.sourcify === "exact_match" ? "match or exact_match" : c.sourcify,
    );
  }
  for (const t of dep.txs) compare(sDep, `${t.chainId} ${t.label} ${t.tx} status`, true, t.ok);
  sDep.notes = [`${parsed.abbreviatedTxs} abbreviated transaction hashes in the doc cannot be checked`];
  sDep.detail = dep.contracts.map((c) => ({
    chainId: c.chainId,
    name: c.name,
    address: c.address,
    deployTx: c.deployTx,
    deployBlock: c.deployBlock,
    sourcify: c.sourcify,
    hasCode: c.hasCode,
  }));
  for (const [chain, key] of [
    [LASNA, "MANDATE_REACTIVE"],
    [BASE, "DOCKET"],
    [BASE, "DELEGATE"],
    [UNICHAIN, "DELEGATE"],
  ] as const) {
    compare(
      sDep,
      `contracts/deployments/${chain}.env ${key} is in DEPLOYMENTS.md`,
      true,
      dep.contracts.some((c) => c.chainId === chain && c.address === deployment(chain, key)),
    );
  }

  const blockOf = (chain: ChainId, key: string): bigint => {
    const c = dep.contracts.find((x) => x.chainId === chain && x.address === deployment(chain, key));
    if (c?.deployBlock == null) throw new Error(`no deploy block for ${chain} ${key}`);
    return BigInt(c.deployBlock);
  };

  // 2. Every case row, rebuilt from chain.
  log("cases: rebuilding every row from Lasna, Base Sepolia and Unichain Sepolia logs");
  const chain: ChainResult = await rebuildCases({
    "lasna:MandateReactive": blockOf(LASNA, "MANDATE_REACTIVE"),
    "base:Docket": blockOf(BASE, "DOCKET"),
    "base:Delegate": blockOf(BASE, "DELEGATE"),
    "unichain:Delegate": blockOf(UNICHAIN, "DELEGATE"),
  });
  const committed = parseCsv(readText("evidence/cases.csv"));
  const sRows = section("evidence/cases.csv rebuilt from chain");
  compare(sRows, "row count", committed.length, chain.rows.length);
  for (const f of chain.findings)
    sRows.mismatches.push({ where: `${f.where}: ${f.field}`, expected: f.expected, actual: f.actual });
  sRows.checked += chain.proposalsChecked * 6;
  for (const row of chain.rows) {
    const c = committed.find((x) => x.label === row.label);
    if (c === undefined) {
      sRows.mismatches.push({ where: `${row.label}`, expected: "a committed row", actual: "missing" });
      continue;
    }
    for (const [k, v] of Object.entries(row)) compare(sRows, `${row.label} ${k}`, c[k] ?? "(no column)", v);
    for (const k of Object.keys(c))
      if (!(k in row)) compare(sRows, `${row.label} ${k}`, c[k], "(not rebuilt)");
  }
  sRows.notes = [
    `rows rebuilt as of the trace at ${chain.snapshot.tracedAt} (blocks ${JSON.stringify(chain.snapshot.blocks)})`,
    `${chain.untrackedCases.length} cases on chain with no evidence row (filed after the run, for example from the live site): ${chain.untrackedCases.join(" ") || "none"}`,
    `${chain.laterEvents.length} events after the trace on tracked cases`,
    `${chain.lasnaBlocksWithoutFee} Lasna blocks without historical state for the fee`,
    `${chain.unknownLogs} logs at the scanned addresses that none of the ABIs decode (admin events)`,
  ];
  sRows.detail = { laterEvents: chain.laterEvents, untrackedCases: chain.untrackedCases };

  // 3. Rationales, model ids and prompt hashes.
  const sHash = section("rationales, modelIdHash and promptHash against each Verdict event");
  for (const v of chain.verdicts) {
    compare(sHash, `case ${v.caseId} juror ${v.juror} rationale ${v.rationaleFile}`, "ok", v.rationaleHash);
    compare(
      sHash,
      `case ${v.caseId} juror ${v.juror} modelIdHash = keccak256("${v.model}")`,
      "ok",
      v.modelIdHash,
    );
    compare(
      sHash,
      `case ${v.caseId} juror ${v.juror} promptHash = keccak256(workers/prompts/${v.promptFile})`,
      "ok",
      v.promptHash,
    );
  }
  const mandateHash = keccak256(readFileSync(repoPath("mandates/conservative-treasury.v1.md")));
  compare(
    sHash,
    "Docket MandateSet hash = keccak256(mandates/conservative-treasury.v1.md)",
    mandateHash,
    chain.mandateSet?.hash ?? "no MandateSet",
  );

  // 4. Derived numbers: summary.json, stats.json, funds, weights.
  log("derived numbers: summary, timing, funds, weights");
  const summary = readSummary();
  const sSum = section("evidence/summary.json against chain");
  if (summary === undefined) {
    sSum.mismatches.push({
      where: "evidence/summary.json",
      expected: "present (make summary)",
      actual: "missing",
    });
  } else {
    const fromChain = summarizeRun(chain.rows as Row[]);
    for (const k of Object.keys(fromChain) as (keyof typeof fromChain)[]) {
      compare(sSum, `run.${k}`, summary.run[k], fromChain[k]);
    }
    for (const [id, h] of Object.entries(chain.hops)) compare(sSum, `hops case ${id}`, summary.hops[id], h);
    compare(
      sSum,
      "weightsAfterRun (last WeightsUpdated on Lasna)",
      summary.weightsAfterRun,
      chain.weightsAtSnapshot,
    );
    compare(sSum, "mandate keccak256", summary.mandate.keccak256, chain.mandateSet?.hash);
    const offline = buildSummary(summary.tests);
    compare(
      sSum,
      "summary.json is what make summary writes from the evidence",
      JSON.stringify(offline),
      JSON.stringify(summary),
    );
  }
  const stats = JSON.parse(readText("evidence/live/stats.json")) as {
    steps: unknown[];
    costs: [string, string, number][];
    total: number;
  };
  const sStats = section("evidence/live/stats.json against chain");
  const steps = stepStats(chain.rows);
  compare(sStats, "step table", stats.steps, steps);
  for (const [label, outcome, c] of stats.costs) {
    const r = chain.rows.find((x) => x.label === label);
    compare(sStats, `cost ${label}`, `${outcome} ${c}`, `${r?.outcome} ${Number(r?.lreact)}`);
  }

  const sFunds = section("evidence/live/funds.jsonl snapshots re-read at their blocks");
  type Snap = Record<
    "reactive" | "docket" | "delegateBase" | "delegateUnichain",
    { block: number; spendable: string }
  > & { at: string };
  const payers = [
    ["reactive", LASNA, deployment(LASNA, "MANDATE_REACTIVE")],
    ["docket", BASE, deployment(BASE, "DOCKET")],
    ["delegateBase", BASE, deployment(BASE, "DELEGATE")],
    ["delegateUnichain", UNICHAIN, deployment(UNICHAIN, "DELEGATE")],
  ] as const;
  for (const s of readJsonl<Snap>("evidence/live/funds.jsonl")) {
    for (const [k, c, addr] of payers) {
      compare(
        sFunds,
        `${s.at} ${k} spendable at block ${s[k].block}`,
        s[k].spendable,
        (await spendableAt(c, addr, BigInt(s[k].block))).toString(),
      );
    }
  }

  // 5. Hand-written docs and the site's generated index.
  const sDocs = section("docs/FIRST_CASES.md and web/src/generated/evidence.ts against chain");
  const funds = summary?.funds;
  const jurorGasEth = Object.fromEntries(
    Object.entries(chain.jurorGasWei).map(([j, w]) => [j, Number(BigInt(w)) / 1e18]),
  );
  const first = checkFirstCases(readText("docs/FIRST_CASES.md"), {
    rows: chain.rows,
    steps,
    reactiveSpentLreact: funds?.reactiveSpentLreact ?? Number.NaN,
    attributedLreact: summarizeRun(chain.rows).lreactAttributed,
    docketSpentEth: funds?.docketSpentEth ?? Number.NaN,
    delegateBaseSpentEth: funds?.delegateBaseSpentEth ?? Number.NaN,
    delegateUnichainSpentEth: funds?.delegateUnichainSpentEth ?? Number.NaN,
    jurorGasEth,
    weights: chain.weightsAtSnapshot,
    rationalesOk: chain.verdicts.filter((v) => v.rationaleHash === "ok").length,
    verdicts: chain.verdicts.length,
  });
  claimsInto(sDocs, first.claims);
  claimsInto(
    sDocs,
    checkWebEvidence(readText("web/src/generated/evidence.ts"), chain.rows, deployment(BASE, "DOCKET")),
  );
  sDocs.notes = first.notChecked;
  sDocs.detail = { jurorGasEth };

  // 6. Offline: evaluation, replays, generated docs.
  log("offline: evaluation, replays, generated README and JUDGE");
  const sEval = section("evaluation tables recomputed from the results CSVs (offline)");
  const evalDetail: unknown[] = [];
  for (const [card, csv] of [
    ["analysis/eval/MODEL_CARD.md", "analysis/eval/results.csv"],
    ["analysis/eval/MODEL_CARD_live-lineup.md", "analysis/eval/results_live-lineup.csv"],
  ] as const) {
    const c = checkCard(card, csv);
    if (c === undefined) continue;
    sEval.checked += c.cellsCompared + c.rows;
    for (const m of c.mismatches)
      sEval.mismatches.push({
        where: `${card} ${m.table} row ${m.row}`,
        expected: m.expected,
        actual: m.actual,
      });
    for (const m of c.tallyMismatches)
      sEval.mismatches.push({ where: `${csv} decision`, expected: "tally of the posted ballots", actual: m });
    evalDetail.push({
      card,
      csv,
      rows: c.rows,
      proposals: c.proposals,
      cellsCompared: c.cellsCompared,
      agreement: c.agreement,
      decisions: c.decisions,
      notRecomputable: c.notRecomputable,
    });
  }
  sEval.detail = evalDetail;

  const sReplay = section("recorded replays (evidence/e2e-anvil, offline)");
  const replays = checkReplays();
  for (const r of replays) {
    sReplay.checked++;
    for (const p of r.problems) sReplay.mismatches.push({ where: r.file, expected: "consistent", actual: p });
  }
  if (summary !== undefined) {
    compare(sReplay, "drifted count", summary.replays.drifted, replays.filter((r) => r.drifted).length);
  }

  const sGen = section("README.md and JUDGE.md are what tools/judge/render.ts writes");
  if (summary !== undefined) {
    for (const [file, text] of Object.entries(renderAll(summary)))
      compare(
        sGen,
        file,
        "generated text",
        readText(file) === text ? "generated text" : "differs (run make docs)",
      );
  }

  const mismatches = sections.reduce((a, s) => a + s.mismatches.length, 0);
  const checked = sections.reduce((a, s) => a + s.checked, 0);
  const report = {
    ok: mismatches === 0,
    checked,
    mismatches,
    rowsChecked: chain.rows.length,
    verdictsChecked: chain.verdicts.length,
    seconds: Math.round((Date.now() - started) / 1000),
    rpc: { ...rpc.stats, fresh: process.env.FRESH === "1" },
    heads: Object.fromEntries(
      await Promise.all(
        ([LASNA, BASE, UNICHAIN] as ChainId[]).map(async (c) => [c, (await rpc.head(c)).toString()]),
      ),
    ),
    ranAt: new Date().toISOString(),
    sections,
  };
  writeFileSync(repoPath("evidence/verify-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  for (const s of sections) {
    console.log(
      `${s.mismatches.length === 0 ? "ok  " : "FAIL"} ${s.name}: ${s.checked} checked, ${s.mismatches.length} mismatched`,
    );
    const clip = (v: string) => (v.length > 240 ? `${v.slice(0, 240)}... (full value in the report)` : v);
    for (const m of s.mismatches.slice(0, 20)) {
      console.log(
        `       ${m.where}\n         expected ${clip(m.expected)}\n         actual   ${clip(m.actual)}`,
      );
    }
    if (s.mismatches.length > 20)
      console.log(`       ... ${s.mismatches.length - 20} more in evidence/verify-report.json`);
  }
  console.log(
    `${checked} checks, ${mismatches} mismatches, ${report.seconds} s, ${rpc.stats.requests} RPC requests (${rpc.stats.cacheHits} cached). Report: evidence/verify-report.json`,
  );
  if (mismatches > 0) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(2);
});
