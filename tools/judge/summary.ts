/**
 * make summary: writes evidence/summary.json from the committed evidence files, so every number README.md and
 * JUDGE.md print has one source. Offline except for the test counts, which come from a real `forge test --json`
 * and Vitest JSON runs (SUMMARY_TESTS=0 keeps the counts already in summary.json).
 *
 *   tools/verify/node_modules/.bin/tsx tools/judge/summary.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256 } from "viem";
import { parseCsv } from "../verify/lib/csv.ts";
import { loadDeployments } from "../verify/lib/deployments.ts";
import { checkCard } from "../verify/lib/evalcheck.ts";
import { checkReplays } from "../verify/lib/replays.ts";
import { JURORS, REPO, readJsonl, readText, repoPath } from "../verify/lib/repo.ts";
import { type Hops, hopsOf, round, summarizeRun } from "./lib/summary.ts";

export const SUMMARY_PATH = "evidence/summary.json";

/** The five loops JUDGE.md walks through: fastest Base cast, the Unichain block-clock cast, the retry, the override and an against vote. */
export const SAMPLE_LABELS = ["C01", "C06", "C11", "C08", "C02"] as const;

export interface TestCounts {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  files: number;
  command: string;
}

interface TraceEvent {
  name: string;
  tx: string;
  block: string;
  args: Record<string, unknown>;
}

/** Lasna hops of each case, from evidence/live/trace.json (the trace that wrote cases.csv). */
export function hopsFromTrace(): Record<string, Hops> {
  const trace = JSON.parse(readText("evidence/live/trace.json")) as {
    cases: { row: { case_id: string }; lasna: TraceEvent[] }[];
  };
  const out: Record<string, Hops> = {};
  for (const c of trace.cases) out[c.row.case_id] = hopsOf(c.lasna);
  return out;
}

function weightsFromTrace(): Record<string, number> {
  const trace = JSON.parse(readText("evidence/live/trace.json")) as { cases: { lasna: TraceEvent[] }[] };
  const all = trace.cases.flatMap((c) => c.lasna).filter((e) => e.name === "WeightsUpdated");
  all.sort((a, b) => Number(BigInt(a.block) - BigInt(b.block)));
  const last = all.at(-1);
  const out: Record<string, number> = {};
  if (last === undefined) return out;
  (last.args.jurors as string[]).forEach((j, i) => {
    out[String(JURORS.findIndex((x) => x.toLowerCase() === j.toLowerCase()) + 1)] = Number(
      (last.args.weights as unknown[])[i],
    );
  });
  return out;
}

interface FundsSnapshot {
  at: string;
  note: string;
  reactive: { block: number; spendable: string };
  docket: { block: number; spendable: string };
  delegateBase: { block: number; spendable: string };
  delegateUnichain: { block: number; spendable: string };
}

/** The reactive contract's top-up between the first and second snapshot (docs/DEPLOYMENTS.md, depositTo 12:23 UTC). */
export const REACTIVE_TOP_UP_WEI = 1_000_000_000_000_000_000n;

export function fundsSummary() {
  const snaps = readJsonl<FundsSnapshot>("evidence/live/funds.jsonl");
  const first = snaps[0];
  const last = snaps.at(-1);
  if (first === undefined || last === undefined) throw new Error("evidence/live/funds.jsonl is empty");
  const eth = (wei: bigint) => Number(wei) / 1e18;
  const drop = (k: "docket" | "delegateBase" | "delegateUnichain") =>
    eth(BigInt(first[k].spendable) - BigInt(last[k].spendable));
  const reactiveStart = BigInt(first.reactive.spendable) + REACTIVE_TOP_UP_WEI;
  return {
    snapshots: snaps.map((s) => ({
      at: s.at,
      note: s.note,
      blocks: {
        reactive: s.reactive.block,
        docket: s.docket.block,
        delegateBase: s.delegateBase.block,
        delegateUnichain: s.delegateUnichain.block,
      },
    })),
    reactiveStartLreact: eth(reactiveStart),
    reactiveEndLreact: eth(BigInt(last.reactive.spendable)),
    reactiveSpentLreact: round(eth(reactiveStart - BigInt(last.reactive.spendable)), 6),
    docketSpentEth: drop("docket"),
    delegateBaseSpentEth: drop("delegateBase"),
    delegateUnichainSpentEth: drop("delegateUnichain"),
  };
}

function sourcifyFromLog(): Record<string, string> {
  const out: Record<string, string> = {};
  let key = "";
  for (const line of readText("evidence/live/sourcify.log").split("\n")) {
    const head = /^== (\d+) (0x[0-9a-fA-F]{40})/.exec(line);
    if (head) key = `${head[1]}:${(head[2] as string).toLowerCase()}`;
    const status = /^Status: `(\w+)`/.exec(line);
    if (status && key) out[key] = status[1] as string;
  }
  return out;
}

function vitestCounts(dir: string): TestCounts {
  const tmp = mkdtempSync(join(tmpdir(), "mandate-vitest-"));
  const file = join(tmp, "out.json");
  try {
    execFileSync("pnpm", ["exec", "vitest", "run", "--reporter=json", `--outputFile=${file}`], {
      cwd: repoPath(dir),
      stdio: ["ignore", "ignore", "inherit"],
    });
    const j = JSON.parse(readFileSync(file, "utf8")) as {
      numTotalTests: number;
      numPassedTests: number;
      numFailedTests: number;
      numPendingTests: number;
      numTodoTests: number;
      testResults: unknown[];
    };
    return {
      passed: j.numPassedTests,
      failed: j.numFailedTests,
      skipped: j.numPendingTests + j.numTodoTests,
      total: j.numTotalTests,
      files: j.testResults.length,
      command: `cd ${dir} && pnpm test`,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function forgeCounts(): TestCounts {
  const out = execFileSync("forge", ["test", "--json"], {
    cwd: repoPath("contracts"),
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  }).toString("utf8");
  const suites = JSON.parse(out) as Record<string, { test_results: Record<string, { status: string }> }>;
  const results = Object.values(suites).flatMap((s) => Object.values(s.test_results));
  return {
    passed: results.filter((r) => r.status === "Success").length,
    failed: results.filter((r) => r.status === "Failure").length,
    skipped: results.filter((r) => r.status === "Skipped").length,
    total: results.length,
    files: new Set(Object.keys(suites).map((k) => k.split(":")[0])).size,
    command: "make test",
  };
}

export interface Tests {
  contracts: TestCounts;
  workers: TestCounts;
  web: TestCounts;
}

/** Direct dependencies of one pnpm workspace with the versions its lockfile resolved. */
function lockedDeps(dir: string): { name: string; version: string; dev: boolean }[] {
  const lock = readText(dir, "pnpm-lock.yaml").split("\n");
  const out: { name: string; version: string; dev: boolean }[] = [];
  let inRoot = false;
  let dev = false;
  let name = "";
  for (const line of lock) {
    if (line === "  .:") inRoot = true;
    else if (inRoot && /^ {2}\S/.test(line)) break;
    if (!inRoot) continue;
    if (line === "    dependencies:") dev = false;
    if (line === "    devDependencies:") dev = true;
    const n = /^ {6}'?([^':]+)'?:$/.exec(line);
    if (n) name = n[1] as string;
    const v = /^ {8}version: ([^(\s]+)/.exec(line);
    if (v && name) out.push({ name, version: v[1] as string, dev });
  }
  return out;
}

function dependencies() {
  const ci = readText(".github/workflows/ci.yml");
  const pin = (key: string) => /\s*"?([^"\s#]+)"?/.exec(ci.split(`${key}:`)[1] ?? "")?.[1] ?? "?";
  const foundryToml = readText("contracts/foundry.toml");
  const libs = readText(".gitmodules")
    .split("\n")
    .flatMap((l) => {
      const m = /^\s*path = (contracts\/lib\/\S+)$/.exec(l);
      return m ? [m[1] as string] : [];
    })
    .map((path) => ({
      name: path.split("/").at(-1) as string,
      version: execFileSync("git", ["-C", repoPath(path), "describe", "--tags"], { encoding: "utf8" }).trim(),
    }));
  return {
    toolchain: [
      { name: "Foundry (forge, cast, anvil)", version: pin("FOUNDRY_VERSION").replace(/^v/, "") },
      { name: "Solidity", version: /solc_version = "([^"]+)"/.exec(foundryToml)?.[1] ?? "?" },
      { name: "Node.js", version: pin("NODE_VERSION") },
      { name: "pnpm", version: pin("PNPM_VERSION") },
      { name: "Slither", version: pin("SLITHER_VERSION") },
      { name: "gitleaks", version: pin("GITLEAKS_VERSION") },
    ],
    contracts: libs,
    workers: lockedDeps("workers"),
    web: lockedDeps("web"),
    smoke: lockedDeps("tools/smoke"),
  };
}

/** The first commit's author date: everything in the repository was written from then on. */
function firstCommit(): string {
  const dates = execFileSync("git", ["log", "--reverse", "--format=%aI"], {
    cwd: REPO,
    encoding: "utf8",
  }).split("\n");
  return dates[0] ?? "";
}

export function buildSummary(previousTests?: Tests) {
  const rows = parseCsv(readText("evidence/cases.csv"));
  const run = summarizeRun(rows);
  const trace = JSON.parse(readText("evidence/live/trace.json")) as { tracedAt: string };
  const hops = hopsFromTrace();
  const deployments = loadDeployments();
  const sourcify = sourcifyFromLog();
  const cards = [
    ["analysis/eval/MODEL_CARD.md", "analysis/eval/results.csv"],
    ["analysis/eval/MODEL_CARD_live-lineup.md", "analysis/eval/results_live-lineup.csv"],
  ].flatMap(([card, csv]) => {
    const c = checkCard(card as string, csv as string);
    return c === undefined
      ? []
      : [
          {
            card: c.card,
            csv: c.csv,
            rows: c.rows,
            proposals: c.proposals,
            agreement: c.agreement,
            decisions: c.decisions,
            decisionDiffers: c.decisionDiffers,
            outcomeMatch: c.outcomeMatch,
          },
        ];
  });
  const replays = checkReplays();
  const mandateFile = "mandates/conservative-treasury.v1.md";
  const tests: Tests =
    process.env.SUMMARY_TESTS === "0" && previousTests !== undefined
      ? previousTests
      : { contracts: forgeCounts(), workers: vitestCounts("workers"), web: vitestCounts("web") };
  return {
    generatedBy: "tools/judge/summary.ts (make summary); checked against chain by make verify",
    sources: [
      "evidence/proposals.jsonl",
      "evidence/cases.csv",
      "evidence/live/trace.json",
      "evidence/live/funds.jsonl",
      "evidence/live/sourcify.log",
      "evidence/rationales/",
      "evidence/e2e-anvil/",
      "docs/DEPLOYMENTS.md",
      ...cards.flatMap((c) => [c.card, c.csv]),
    ],
    tracedAt: trace.tracedAt,
    run,
    hops,
    samples: [...SAMPLE_LABELS],
    weightsAfterRun: weightsFromTrace(),
    funds: fundsSummary(),
    mandate: { file: mandateFile, keccak256: keccak256(readFileSync(repoPath(mandateFile))) },
    deployments: deployments.contracts.map((c) => ({
      ...c,
      sourcify: sourcify[`${c.chainId}:${c.address.toLowerCase()}`] ?? "not in sourcify.log",
    })),
    eval: cards,
    replays: {
      total: replays.length,
      reproduced: replays.filter((r) => !r.drifted).length,
      drifted: replays.filter((r) => r.drifted).length,
      files: replays.map((r) => ({ file: r.file, juror: r.juror, model: r.model, drifted: r.drifted })),
    },
    tests,
    dependencies: dependencies(),
    firstCommit: firstCommit(),
  };
}

export type Summary = ReturnType<typeof buildSummary>;

export function readSummary(): Summary | undefined {
  return existsSync(repoPath(SUMMARY_PATH)) ? (JSON.parse(readText(SUMMARY_PATH)) as Summary) : undefined;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const summary = buildSummary(readSummary()?.tests);
  writeFileSync(join(REPO, SUMMARY_PATH), `${JSON.stringify(summary, null, 2)}\n`);
  const t = summary.tests;
  console.log(
    `wrote ${SUMMARY_PATH}: ${summary.run.cases} cases, ${summary.run.rationalesMatching}/${summary.run.verdicts} rationales matching, tests ${t.contracts.passed}+${t.workers.passed}+${t.web.passed}`,
  );
}
