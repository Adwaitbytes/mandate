/**
 * Offline check of the evaluation: recomputes the model card's tables from its results CSV alone (votes, agreement,
 * mandate sensitivity, the quorum tally re-run on the posted ballots, agreement with the DAO outcome and the named
 * delegate, and flag holds) and compares them cell by cell with the card. Columns the CSV does not carry (model-only
 * injection flags, Prompt Guard scores, JSON validity) are listed as not recomputable rather than skipped silently.
 */
import { existsSync, readFileSync } from "node:fs";
import { type Ballot, DEFAULT_TALLY, tally } from "../../../workers/src/tally.ts";
import { parseCsv } from "./csv.ts";
import { repoPath } from "./repo.ts";

type Support = "for" | "against" | "abstain";
const JURORS = [1, 2, 3] as const;
type J = (typeof JURORS)[number];

export interface EvalRow {
  dao: string;
  proposalId: string;
  stratum: string;
  outcome: string;
  delegateVote: string;
  mandate: string;
  votes: Partial<Record<J, { support: Support; conf: number; flag: boolean }>>;
  heuristic: string;
  decision: string;
}

export function loadEvalRows(csvText: string): EvalRow[] {
  return parseCsv(csvText).map((r) => {
    const votes: EvalRow["votes"] = {};
    for (const j of JURORS) {
      const s = r[`j${j}`];
      if (s === undefined || s === "") continue;
      if (s !== "for" && s !== "against" && s !== "abstain") throw new Error(`bad support ${s}`);
      votes[j] = { support: s, conf: Number(r[`j${j}_conf`]), flag: r[`j${j}_flag`] === "true" };
    }
    return {
      dao: r.dao ?? "",
      proposalId: r.proposal_id ?? "",
      stratum: r.stratum ?? "",
      outcome: r.outcome ?? "",
      delegateVote: r.delegate_vote ?? "",
      mandate: r.mandate ?? "",
      votes,
      heuristic: r.heuristic_flag ?? "",
      decision: r.decision ?? "",
    };
  });
}

/** The card's percentage format (workers/src/eval/report.ts). */
export function pct(num: number, den: number): string {
  if (den === 0) return "n/a";
  const value = (100 * num) / den;
  return `${value < 10 && value > 0 ? value.toFixed(1) : value.toFixed(0)}% (${num}/${den})`;
}

export interface EvalTables {
  /** heading -> expected table rows (cells), in card order */
  tables: Record<string, string[][]>;
  baseRate: string;
  tallyMismatches: string[];
  agreement: Record<
    string,
    { n: number; allThree: number; atLeastTwo: number; pairs: Record<string, number> }
  >;
  decisions: Record<string, Record<string, number>>;
  /** proposals whose quorum decision differs between the two mandates */
  decisionDiffers: { num: number; den: number };
  /** per mandate, decided for/against cases and how many matched the DAO outcome */
  outcomeMatch: Record<string, { decided: number; matches: number }>;
  proposals: number;
}

export function recompute(rows: EvalRow[]): EvalTables {
  const mandates = [...new Set(rows.map((r) => r.mandate))];
  const sup = (r: EvalRow, j: J): Support | undefined => r.votes[j]?.support;
  const complete = (m: string) =>
    rows.filter((r) => r.mandate === m && JURORS.every((j) => r.votes[j] !== undefined));
  const tables: Record<string, string[][]> = {};
  const tallyMismatches: string[] = [];

  // The decision column is re-derived with the reactive contract's tally rules on the posted ballots.
  for (const r of rows) {
    const present = JURORS.flatMap((j) => (r.votes[j] === undefined ? [] : [r.votes[j]]));
    const ballots: Ballot[] = present.map((v) => ({
      support: v.support,
      confidenceBps: v.conf * 100,
      injectionFlag: v.flag,
      weight: 100,
    }));
    const expected = present.length === JURORS.length ? tally(ballots, DEFAULT_TALLY) : "incomplete";
    if (expected !== r.decision) {
      tallyMismatches.push(`${r.dao} ${r.proposalId} ${r.mandate}: csv ${r.decision}, tally ${expected}`);
    }
  }

  tables["How each juror voted"] = mandates.flatMap((m) => {
    const rs = complete(m);
    return JURORS.map((j) => {
      const c = { for: 0, against: 0, abstain: 0 };
      let conf = 0;
      for (const r of rs) {
        const v = r.votes[j];
        if (v === undefined) continue;
        c[v.support]++;
        conf += v.conf;
      }
      return [
        m,
        String(j),
        String(c.for),
        String(c.against),
        String(c.abstain),
        rs.length === 0 ? "n/a" : (conf / rs.length).toFixed(0),
      ];
    });
  });

  const agreement: EvalTables["agreement"] = {};
  tables["Agreement between jurors"] = mandates.map((m) => {
    const rs = complete(m);
    const agree = (a: J, b: J) => rs.filter((r) => sup(r, a) === sup(r, b)).length;
    const all = rs.filter((r) => sup(r, 1) === sup(r, 2) && sup(r, 2) === sup(r, 3)).length;
    const two = rs.filter((r) => new Set(JURORS.map((j) => sup(r, j))).size < 3).length;
    agreement[m] = {
      n: rs.length,
      allThree: all,
      atLeastTwo: two,
      pairs: { "1-2": agree(1, 2), "1-3": agree(1, 3), "2-3": agree(2, 3) },
    };
    return [
      m,
      pct(all, rs.length),
      pct(agree(1, 2), rs.length),
      pct(agree(1, 3), rs.length),
      pct(agree(2, 3), rs.length),
      pct(two, rs.length),
    ];
  });

  const keyOf = (r: EvalRow) => `${r.dao}|${r.proposalId}`;
  const proposals = [...new Set(rows.map(keyOf))];
  const [m0, m1] = mandates;
  const pairs = proposals.flatMap((k) => {
    const a = rows.find((r) => keyOf(r) === k && r.mandate === m0);
    const b = rows.find((r) => keyOf(r) === k && r.mandate === m1);
    return a && b && a.decision !== "incomplete" && b.decision !== "incomplete" ? [[a, b] as const] : [];
  });
  const decisionDiff = pairs.filter(([a, b]) => a.decision !== b.decision).length;
  tables["Does the mandate change the vote"] = JURORS.map((j) => [
    String(j),
    pct(pairs.filter(([a, b]) => sup(a, j) !== sup(b, j)).length, pairs.length),
    j === 1 ? pct(decisionDiff, pairs.length) : "",
  ]);

  const decisionDiffers = { num: decisionDiff, den: pairs.length };
  const outcomeMatch: EvalTables["outcomeMatch"] = {};
  const decisions: EvalTables["decisions"] = {};
  tables["Quorum decision"] = mandates.map((m) => {
    const rs = complete(m);
    const n = (d: string) => rs.filter((r) => r.decision === d).length;
    decisions[m] = {
      for: n("for"),
      against: n("against"),
      abstain: n("abstain"),
      "held-split": n("held-split"),
      "held-injection": n("held-injection"),
    };
    return [
      m,
      String(n("for")),
      String(n("against")),
      String(n("abstain")),
      String(n("held-split")),
      String(n("held-injection")),
    ];
  });

  const toOutcome = (s: string) => (s === "for" ? "passed" : s === "against" ? "failed" : undefined);
  const callable = (v: string) => v === "for" || v === "against";
  tables["Quorum against the actual outcome and the named delegate"] = mandates.flatMap((m) =>
    (["recent", "defeated-oversample", "all"] as const).map((stratum) => {
      const rs = complete(m).filter(
        (r) => (stratum === "all" || r.stratum === stratum) && callable(r.decision),
      );
      const out = rs.filter((r) => toOutcome(r.decision) === r.outcome).length;
      const wd = rs.filter((r) => callable(r.delegateVote));
      const del = wd.filter((r) => r.delegateVote === r.decision).length;
      if (stratum === "all") outcomeMatch[m] = { decided: rs.length, matches: out };
      return [m, stratum, String(rs.length), pct(out, rs.length), String(wd.length), pct(del, wd.length)];
    }),
  );
  tables["Each juror alone"] = mandates.flatMap((m) =>
    JURORS.map((j) => {
      const rs = complete(m).filter((r) => callable(sup(r, j) ?? ""));
      const out = rs.filter((r) => toOutcome(sup(r, j) ?? "") === r.outcome).length;
      const wd = rs.filter((r) => callable(r.delegateVote));
      return [
        m,
        String(j),
        String(rs.length),
        pct(out, rs.length),
        pct(wd.filter((r) => r.delegateVote === sup(r, j)).length, wd.length),
      ];
    }),
  );

  const byProposal = new Map(rows.map((r) => [keyOf(r), r]));
  const passed = [...byProposal.values()].filter((r) => r.outcome === "passed").length;
  const baseRate = pct(passed, byProposal.size);

  return {
    tables,
    baseRate,
    tallyMismatches,
    agreement,
    decisions,
    decisionDiffers,
    outcomeMatch,
    proposals: byProposal.size,
  };
}

/** Markdown table rows (cells, trimmed) under the first header row whose cells start with `firstHeader`. */
function cardTableAfter(md: string, heading: string): string[][] {
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

export interface EvalCheck {
  card: string;
  csv: string;
  rows: number;
  proposals: number;
  cellsCompared: number;
  mismatches: { table: string; row: number; expected: string; actual: string }[];
  tallyMismatches: string[];
  notRecomputable: string[];
  agreement: EvalTables["agreement"];
  decisions: EvalTables["decisions"];
  decisionDiffers: EvalTables["decisionDiffers"];
  outcomeMatch: EvalTables["outcomeMatch"];
}

const HEADINGS: Record<string, string> = {
  "How each juror voted": "## How each juror voted",
  "Agreement between jurors": "## Agreement between jurors",
  "Does the mandate change the vote": "## Does the mandate change the vote",
  "Quorum decision": "## Quorum decision",
  "Quorum against the actual outcome and the named delegate": "## Quorum against the actual outcome",
  "Each juror alone": "Each juror alone",
};

export function checkCard(cardFile: string, csvFile: string): EvalCheck | undefined {
  if (!existsSync(repoPath(cardFile)) || !existsSync(repoPath(csvFile))) return undefined;
  const md = readFileSync(repoPath(cardFile), "utf8");
  const rows = loadEvalRows(readFileSync(repoPath(csvFile), "utf8"));
  const t = recompute(rows);
  const mismatches: EvalCheck["mismatches"] = [];
  let cellsCompared = 0;
  for (const [name, expected] of Object.entries(t.tables)) {
    const actual = cardTableAfter(md, HEADINGS[name] as string);
    if (actual.length !== expected.length) {
      mismatches.push({
        table: name,
        row: -1,
        expected: `${expected.length} rows`,
        actual: `${actual.length} rows`,
      });
    }
    expected.forEach((cells, i) => {
      const got = actual[i] ?? [];
      cells.forEach((c, k) => {
        cellsCompared++;
        if ((got[k] ?? "") !== c)
          mismatches.push({ table: name, row: i + 1, expected: c, actual: got[k] ?? "" });
      });
    });
  }
  // Injection table: the pre-filter and held-by-flag columns are in the CSV, the model and classifier ones are not.
  const injection = cardTableAfter(md, "## Injection flags on real proposals");
  const mandates = [...new Set(rows.map((r) => r.mandate))];
  mandates.forEach((m, i) => {
    const rs = rows.filter((r) => r.mandate === m && r.decision !== "incomplete");
    const pre = pct(rs.filter((r) => r.heuristic === "true").length, rs.length);
    const held = pct(rs.filter((r) => r.decision === "held-injection").length, rs.length);
    for (const [k, v] of [
      [4, pre],
      [6, held],
    ] as const) {
      cellsCompared++;
      const got = injection[i]?.[k] ?? "";
      if (got !== v)
        mismatches.push({ table: "Injection flags on real proposals", row: i + 1, expected: v, actual: got });
    }
  });
  cellsCompared++;
  if (!md.includes(`Base rates: ${t.baseRate} of sampled proposals passed`)) {
    mismatches.push({ table: "Base rates", row: 0, expected: t.baseRate, actual: "not found in card" });
  }
  return {
    card: cardFile,
    csv: csvFile,
    rows: rows.length,
    proposals: t.proposals,
    cellsCompared,
    mismatches,
    tallyMismatches: t.tallyMismatches,
    notRecomputable: [
      "Coverage: valid JSON on first or second try (not in the CSV; from analysis/eval/cache)",
      "Injection flags on real proposals: per-juror model flags and Prompt Guard flags (the CSV has the posted flag only)",
      "Injection samples and Prompt Guard calibration tables (from analysis/eval/cache and data/)",
    ],
    agreement: t.agreement,
    decisions: t.decisions,
    decisionDiffers: t.decisionDiffers,
    outcomeMatch: t.outcomeMatch,
  };
}
