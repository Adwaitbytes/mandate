/**
 * Pure derivations from case rows (evidence/cases.csv, or the same rows rebuilt from chain by make verify). Both
 * `make summary` and `make verify` call these, so a number in the docs and the number verify recomputes come from
 * one definition.
 */
import { type StepStat, stepStats } from "../../verify/lib/steps.ts";

export type Row = Record<string, string>;

export interface Hops {
  caseCreated: string;
  openAck: string;
  windowStarted: string;
  castDeferred: string;
  castRequested: string;
  castAck: string;
}

/** The Lasna reactions of one case that a reader follows: open, acknowledgement, window, cast request and cast ack. */
export function hopsOf(lasna: { name: string; tx: string; args: Record<string, unknown> }[]): Hops {
  const txOf = (name: string, pick: "first" | "last" = "first") => {
    const hits = lasna.filter((e) => e.name === name);
    return (pick === "first" ? hits[0] : hits.at(-1))?.tx ?? "";
  };
  // The CaseOpened acknowledgement is the reaction that moves the case from Opening to Open.
  const openAck =
    lasna.find((e) => e.name === "CaseStatusChanged" && String(e.args.status) === "2")?.tx ?? "";
  return {
    caseCreated: txOf("CaseCreated"),
    openAck,
    windowStarted: txOf("WindowStarted", "last"),
    castDeferred: txOf("CastDeferred"),
    castRequested: txOf("CastRequested"),
    castAck: txOf("CastAcknowledged"),
  };
}

export interface CaseSummary {
  label: string;
  caseId: string;
  chainId: number;
  governorKey: string;
  source: string;
  intent: string;
  verdicts: string;
  models: string;
  outcome: string;
  kind: string;
  lasnaTxCount: number;
  lreact: number | null;
  proposalTx: string;
  docketOpenTx: string;
  verdictTxs: Record<string, string>;
  vetoTx: string;
  overrideTx: string;
  castTx: string;
  msProposalToOpen: number | null;
  msProposalToCast: number | null;
  /** Block stamps in ms, each on its own chain's clock. */
  stamps: Record<string, number | null>;
}

/** What each case exercised, from what the chain recorded (not from what it was meant to exercise). */
export function kindOf(r: Row): string {
  const injectionSample = /injection/.test(r.source ?? "");
  if (r.override_tx) return "owner override";
  if (r.outcome?.startsWith("cast"))
    return r.deferred_until ? "cast after waiting for voting to open" : "decided and cast";
  if (r.final_status === "Vetoed") return "owner veto";
  if (r.final_status === "Held" && r.held?.includes("Injection")) {
    return injectionSample ? "injection attempt held" : "held by an injection flag (false positive)";
  }
  if (r.held?.includes("Split"))
    return r.final_status === "Expired" ? "split, held, then expired" : "split, held";
  if (r.final_status === "Expired" && r.statuses?.includes("Window"))
    return "decided after voting closed, expired";
  return r.outcome ?? "";
}

const int = (v: string | undefined): number | null => (v ? Number.parseInt(v, 10) : null);

function cellMap(cell: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of cell.split(/\s+/).filter(Boolean)) {
    const at = part.indexOf(":");
    out[part.slice(0, at)] = part.slice(at + 1);
  }
  return out;
}

export function summarizeCase(r: Row): CaseSummary {
  const models = cellMap(r.verdict_models ?? "");
  return {
    label: r.label ?? "",
    caseId: r.case_id ?? "",
    chainId: Number(r.governor_chain),
    governorKey: r.governor_key ?? "",
    source: r.source ?? "",
    intent: r.intent ?? "",
    verdicts: r.verdicts ?? "",
    models: ["j1", "j2", "j3"].map((j) => `${j}:${models[j] ?? ""}`).join(" "),
    outcome: r.outcome ?? "",
    kind: kindOf(r),
    lasnaTxCount: Number(r.lasna_tx_count),
    lreact: r.lreact ? Number(r.lreact) : null,
    proposalTx: r.proposal_tx ?? "",
    docketOpenTx: r.docket_open_tx ?? "",
    verdictTxs: cellMap(r.verdict_txs ?? ""),
    vetoTx: r.veto_tx ?? "",
    overrideTx: r.override_tx ?? "",
    castTx: r.cast_tx ?? "",
    msProposalToOpen: int(r.ms_proposal_to_open),
    msProposalToCast: r.override_tx ? null : int(r.ms_proposal_to_cast_same_clock),
    stamps: {
      proposal: int(r.proposal_ms),
      caseCreated: int(r.lasna_case_created_ms),
      docketOpen: int(r.docket_open_ms),
      ...Object.fromEntries(
        Object.entries(cellMap(r.verdict_ms ?? "")).map(([j, ms]) => [`verdict_${j}`, int(ms)]),
      ),
      veto: int(r.veto_ms),
      windowStarted: int(r.window_started_lasna_ms),
      castRequested: int(r.cast_requested_lasna_ms),
      cast: int(r.cast_ms),
      castAck: int(r.cast_ack_lasna_ms),
    },
  };
}

export interface RunSummary {
  cases: number;
  byKind: Record<string, number>;
  byOutcome: Record<string, number>;
  byChain: Record<string, number>;
  casts: number;
  vetoes: number;
  overrides: number;
  injectionAttemptsHeld: number;
  injectionAttempts: number;
  falsePositiveHolds: number;
  splits: number;
  retries: number;
  giveUps: number;
  verdicts: number;
  rationalesMatching: number;
  modelsByJuror: Record<string, Record<string, number>>;
  timing: StepStat[];
  lreactAttributed: number;
  lreactPerCaseMin: number;
  lreactPerCaseMax: number;
  wholeLoopFastestMs: number | null;
  wholeLoopFastestLabel: string;
  openToThirdVerdictP50Ms: number | null;
  perCase: CaseSummary[];
}

const bump = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] ?? 0) + 1;
};

export function summarizeRun(rows: Row[]): RunSummary {
  const perCase = rows.map(summarizeCase);
  const byKind: Record<string, number> = {};
  const byOutcome: Record<string, number> = {};
  const byChain: Record<string, number> = {};
  const modelsByJuror: Record<string, Record<string, number>> = {};
  let verdicts = 0;
  let rationalesMatching = 0;
  for (const r of rows) {
    bump(byKind, kindOf(r));
    bump(byOutcome, r.outcome ?? "");
    bump(byChain, r.governor_chain ?? "");
    for (const [j, m] of Object.entries(cellMap(r.verdict_models ?? ""))) {
      modelsByJuror[j] ??= {};
      bump(modelsByJuror[j] as Record<string, number>, m);
    }
    for (const part of (r.rationale_hashes ?? "").split(/\s+/).filter(Boolean)) {
      verdicts++;
      if (part.endsWith(":ok")) rationalesMatching++;
    }
  }
  const costs = perCase.map((c) => c.lreact).filter((x): x is number => x !== null);
  const loops = perCase.filter((c) => c.msProposalToCast !== null && c.chainId === 84532);
  const fastest = loops.reduce<CaseSummary | undefined>(
    (a, c) => (a === undefined || (c.msProposalToCast ?? 0) < (a.msProposalToCast ?? 0) ? c : a),
    undefined,
  );
  const timing = stepStats(rows);
  const third = timing.find((s) => s.step === "case open -> third verdict (quorum 3)");
  return {
    cases: rows.length,
    byKind,
    byOutcome,
    byChain,
    casts: perCase.filter((c) => c.castTx !== "").length,
    vetoes: perCase.filter((c) => c.vetoTx !== "").length,
    overrides: perCase.filter((c) => c.overrideTx !== "").length,
    injectionAttempts: rows.filter((r) => /injection/.test(r.source ?? "")).length,
    injectionAttemptsHeld: byKind["injection attempt held"] ?? 0,
    falsePositiveHolds: rows.filter((r) => r.held?.includes("Injection") && !/injection/.test(r.source ?? ""))
      .length,
    splits: rows.filter((r) => r.held?.includes("Split")).length,
    retries: rows.filter((r) => r.deferred_until).length,
    giveUps: byKind["decided after voting closed, expired"] ?? 0,
    verdicts,
    rationalesMatching,
    modelsByJuror,
    timing,
    lreactAttributed: round(
      costs.reduce((a, b) => a + b, 0),
      6,
    ),
    lreactPerCaseMin: costs.length ? Math.min(...costs) : 0,
    lreactPerCaseMax: costs.length ? Math.max(...costs) : 0,
    wholeLoopFastestMs: fastest?.msProposalToCast ?? null,
    wholeLoopFastestLabel: fastest?.label ?? "",
    openToThirdVerdictP50Ms: third ? third.p50 : null,
    perCase,
  };
}

export const round = (x: number, digits: number): number => Number(x.toFixed(digits));
