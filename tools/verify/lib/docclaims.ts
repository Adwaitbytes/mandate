/**
 * Numbers written by hand in docs/FIRST_CASES.md (and the site's generated evidence index), compared with the values
 * rebuilt from chain. Each claim is either matched, mismatched, or listed as not checked; nothing is skipped silently.
 */
import type { Row } from "../../judge/lib/summary.ts";
import type { StepStat } from "./steps.ts";

export interface Claim {
  doc: string;
  claim: string;
  expected: string;
  actual: string;
  ok: boolean;
}

/** "1,066.0 s", "−0.6 s", "1,255 s" -> ms */
function secondsCell(cell: string): number | undefined {
  const m = /^\**(−|-)?([\d,]+(?:\.\d+)?) s\**$/.exec(cell.trim());
  if (m === null) return undefined;
  const v = Number((m[2] as string).replace(/,/g, "")) * 1000;
  return Math.round(m[1] ? -v : v);
}

const tenth = (ms: number) => Math.round(ms / 100) * 100;

function tableUnder(md: string, heading: string): string[][] {
  const lines = md.split("\n");
  let i = lines.findIndex((l) => l.startsWith(heading));
  if (i === -1) return [];
  while (i < lines.length && !lines[i]?.startsWith("|")) i++;
  const out: string[][] = [];
  for (i += 2; i < lines.length && lines[i]?.startsWith("|"); i++) {
    out.push(
      (lines[i] as string)
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim()),
    );
  }
  return out;
}

/** docs/FIRST_CASES.md step labels -> (step, clock) of tools/live/stats.py */
const STEP_OF: [RegExp, string, string][] = [
  [/^Proposal → case open on the Docket$/, "proposal -> case open on Docket", "Base ms (200 ms)"],
  [
    /^Proposal → case open on the Docket \(Unichain proposals\)$/,
    "proposal -> case open on Docket",
    "raw: Unichain s vs Base ms (+-1 s)",
  ],
  [/^Case open → first verdict$/, "case open -> first verdict", "Base ms"],
  [/^Case open → third verdict \(quorum 3\)$/, "case open -> third verdict (quorum 3)", "Base ms"],
  [
    /^Third verdict → window start$/,
    "third verdict -> window start on Lasna",
    "raw: Base ms vs Lasna s (Lasna stamps run early)",
  ],
  [/^Window start → window end$/, "window start -> window end", "Lasna s (config 300 s)"],
  [/^Window end → cast on the governor$/, "window end -> cast on governor", "raw: Lasna s vs governor clock"],
  [/^Proposal → cast, whole loop \(Base\)$/, "proposal -> cast (whole loop)", "same clock, Base ms"],
  [
    /^Proposal → cast, whole loop \(Unichain, C06\)$/,
    "proposal -> cast (whole loop)",
    "same clock, Unichain s",
  ],
  [/^Third verdict → owner veto tx$/, "third verdict -> owner veto tx", "Base ms (human/script latency)"],
];

export interface ChainFacts {
  rows: Row[];
  steps: StepStat[];
  reactiveSpentLreact: number;
  attributedLreact: number;
  docketSpentEth: number;
  delegateBaseSpentEth: number;
  delegateUnichainSpentEth: number;
  jurorGasEth: Record<string, number>;
  weights: Record<string, number>;
  rationalesOk: number;
  verdicts: number;
}

/** The doc's style for small amounts: 2.30e-5 */
const sci = (x: number, digits: number) => x.toExponential(digits);

export function checkFirstCases(md: string, f: ChainFacts): { claims: Claim[]; notChecked: string[] } {
  const claims: Claim[] = [];
  const add = (claim: string, expected: string, actual: string) =>
    claims.push({ doc: "docs/FIRST_CASES.md", claim, expected, actual, ok: expected === actual });
  const has = (claim: string, text: string) => add(claim, text, md.includes(text) ? text : "not in the doc");

  for (const cells of tableUnder(md, "## Timing per step")) {
    const label = cells[0] ?? "";
    const hit = STEP_OF.find(([re]) => re.test(label));
    if (hit === undefined) {
      add(`timing row "${label}"`, "a known step", "unknown label");
      continue;
    }
    const s = f.steps.find((x) => x.step === hit[1] && x.clock === hit[2]);
    if (s === undefined) {
      add(`timing ${label}`, "a recomputed step", "none");
      continue;
    }
    add(`timing ${label}: n`, String(s.n), cells[2] ?? "");
    (["p50", "p90", "min", "max"] as const).forEach((k, i) => {
      const cell = cells[3 + i] ?? "";
      if (cell === "") return;
      const got = secondsCell(cell);
      add(`timing ${label}: ${k}`, String(tenth(s[k])), String(got));
    });
  }

  const byLabel = new Map(f.rows.map((r) => [r.label, r]));
  for (const cells of tableUnder(md, "## Cost")) {
    const r = byLabel.get(cells[0] ?? "");
    if (r === undefined) continue;
    add(`cost ${cells[0]}: Lasna txs`, r.lasna_tx_count ?? "", cells[2] ?? "");
    add(`cost ${cells[0]}: lREACT`, Number(r.lreact).toFixed(4), cells[3] ?? "");
  }

  const n = f.rows.length;
  has(
    "all-in Lasna spend",
    `**${f.reactiveSpentLreact.toFixed(4)} lREACT for ${n} cases, ${(f.reactiveSpentLreact / n).toFixed(3)} per case**`,
  );
  has("attributed Lasna spend", `Of that, ${f.attributedLreact.toFixed(4)} is attributed`);
  has(
    "unattributed cron ticks",
    `the remaining ${(f.reactiveSpentLreact - f.attributedLreact).toFixed(3)} is cron ticks`,
  );
  const casts = (chain: string) => f.rows.filter((r) => r.cast_tx && r.governor_chain === chain).length;
  has(
    "Docket openCase callbacks",
    `${sci(f.docketSpentEth, 2)} ETH for ${n}, **${sci(f.docketSpentEth / n, 1)} ETH each**`,
  );
  has(
    "Base Delegate casts",
    `${sci(f.delegateBaseSpentEth, 1)} ETH for ${casts("84532")}, **${sci(f.delegateBaseSpentEth / casts("84532"), 1)} each**`,
  );
  has(
    "Unichain Delegate casts",
    `${sci(f.delegateUnichainSpentEth, 1)} ETH for ${casts("1301")}, **${sci(f.delegateUnichainSpentEth / casts("1301"), 1)} each**`,
  );
  for (const [j, eth] of Object.entries(f.jurorGasEth)) {
    has(
      `juror ${j} postVerdict gas`,
      `${sci(eth, 2)} ETH per juror for ${n} verdicts, **${sci(eth / n, 1)} ETH per verdict**`,
    );
  }
  has("rationale hashes", `(${f.rationalesOk} of ${f.verdicts})`);
  has(
    "weights after the run",
    `juror 1 ${f.weights["1"]}, juror 2 ${f.weights["2"]}, juror 3 ${f.weights["3"]}`,
  );
  has("case count", `**${n} cases, ${n} resolved, no stuck case and no failed callback.**`);

  // Abbreviated hashes are written `0x9a61f3c3…6225`: the full hash must start and end with the two parts.
  const abbreviated = (cell: string, full: string) => {
    const m = /`(0x[0-9a-f]+)…([0-9a-f]+)`/.exec(cell);
    if (m === null) return "no hash in the cell";
    return full.startsWith(m[1] as string) && full.endsWith(m[2] as string) ? "matches" : `${m[1]}…${m[2]}`;
  };
  for (const cells of tableUnder(md, "## Every case")) {
    const r = byLabel.get(cells[0] ?? "");
    if (r === undefined) continue;
    add(`every case ${cells[0]}: case no.`, r.case_id ?? "", cells[1] ?? "");
    add(`every case ${cells[0]}: proposal tx`, "matches", abbreviated(cells[5] ?? "", r.proposal_tx ?? ""));
    const final = r.cast_tx || r.veto_tx || "";
    add(
      `every case ${cells[0]}: final tx`,
      final ? "matches" : "none",
      final ? abbreviated(cells[6] ?? "", final) : (cells[6] ?? ""),
    );
  }

  return {
    claims,
    notChecked: [
      "docs/FIRST_CASES.md Lasna clock skew prose (0.2 to 1.4 s) and cron interval (about 106 s): derived from the timing rows, which are checked",
      "docs/FIRST_CASES.md per-kind cost ranges in prose: the per-case costs they summarise are checked",
      "docs/DEPLOYMENTS.md abbreviated transaction hashes (setGovernorLimits x4, depositTo): only full hashes are checked",
      "The 1.0 lREACT depositTo top-up is taken from docs/DEPLOYMENTS.md; the snapshots before and after it are checked",
    ],
  };
}

/** web/src/generated/evidence.ts, rebuilt from chain rows the way web/scripts/gen-config.mjs builds it from the CSV. */
export function checkWebEvidence(source: string, rows: Row[], docket: string): Claim[] {
  const start = source.indexOf("export const evidenceIndex = ");
  const end = source.lastIndexOf(" as const;");
  const claims: Claim[] = [];
  if (start === -1 || end === -1) {
    return [
      {
        doc: "web/src/generated/evidence.ts",
        claim: "parse",
        expected: "evidenceIndex",
        actual: "not found",
        ok: false,
      },
    ];
  }
  const index = JSON.parse(source.slice(start + "export const evidenceIndex = ".length, end)) as {
    docket: string;
    cases: Record<string, Record<string, unknown>>;
  };
  const tx = (v: string | undefined) => (/^0x[0-9a-f]{64}$/.test(v ?? "") ? (v as string) : null);
  const lastTx = (v: string | undefined) => tx((v ?? "").trim().split(/\s+/).at(-1));
  const seconds = (ms: string | undefined) => (/^\d+$/.test(ms ?? "") ? Math.floor(Number(ms) / 1000) : null);
  const add = (claim: string, expected: unknown, actual: unknown) =>
    claims.push({
      doc: "web/src/generated/evidence.ts",
      claim,
      expected: JSON.stringify(expected),
      actual: JSON.stringify(actual),
      ok: JSON.stringify(expected) === JSON.stringify(actual),
    });
  add("docket", docket, index.docket);
  for (const r of rows) {
    const verdicts: Record<string, string> = {};
    for (const m of (r.verdict_txs ?? "").matchAll(/j(\d+):(0x[0-9a-f]{64})/g))
      verdicts[m[1] as string] = m[2] as string;
    const expected = {
      label: r.label,
      caseCreated: tx(r.lasna_case_created_tx),
      opened: tx(r.docket_open_tx),
      verdicts,
      windowStarted: lastTx(r.window_started_txs),
      castRequested: lastTx(r.cast_requested_txs),
      castRequestedAt: seconds(r.cast_requested_lasna_ms),
      cast: tx(r.cast_tx),
      castAt: seconds(r.cast_ms),
      veto: tx(r.veto_tx),
      vetoAt: seconds(r.veto_ms),
      override: tx(r.override_tx),
    };
    add(`case ${r.case_id}`, expected, index.cases[r.case_id ?? ""] ?? null);
  }
  return claims;
}
