/**
 * Per-step timing of the live run from case rows, the same definitions as tools/live/stats.py (which wrote
 * evidence/live/stats.json): nearest-rank percentiles, and a block clock is only subtracted from itself unless the
 * clock label says "raw".
 */
export interface StepStat {
  step: string;
  clock: string;
  n: number;
  p50: number;
  p90: number;
  min: number;
  max: number;
}

export function nearestRank(xs: readonly number[], p: number): number {
  if (xs.length === 0) throw new Error("percentile of an empty list");
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] as number;
}

function msMap(cell: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of cell.split(/\s+/).filter(Boolean)) {
    const at = part.indexOf(":");
    const v = part.slice(at + 1);
    if (at > 0 && v !== "") out[part.slice(0, at)] = Number.parseInt(v, 10);
  }
  return out;
}

const num = (r: Record<string, string>, k: string): number | undefined =>
  r[k] ? Number.parseInt(r[k] as string, 10) : undefined;

export function stepStats(rows: readonly Record<string, string>[]): StepStat[] {
  const steps = new Map<string, { step: string; clock: string; xs: number[] }>();
  const add = (step: string, clock: string, v: number | undefined) => {
    if (v === undefined || Number.isNaN(v)) return;
    const key = `${step}\u0000${clock}`;
    const s = steps.get(key) ?? { step, clock, xs: [] };
    s.xs.push(v);
    steps.set(key, s);
  };
  for (const r of rows) {
    const base = r.governor_chain === "84532";
    const p = num(r, "proposal_ms");
    const o = num(r, "docket_open_ms");
    const vm = Object.values(msMap(r.verdict_ms ?? ""));
    const lastV = vm.length ? Math.max(...vm) : undefined;
    const firstV = vm.length ? Math.min(...vm) : undefined;
    if (base && p && o) add("proposal -> case open on Docket", "Base ms (200 ms)", o - p);
    if (!base && p && o) add("proposal -> case open on Docket", "raw: Unichain s vs Base ms (+-1 s)", o - p);
    if (o && firstV) add("case open -> first verdict", "Base ms", firstV - o);
    if (o && lastV && vm.length === 3) add("case open -> third verdict (quorum 3)", "Base ms", lastV - o);
    const ws = num(r, "window_started_lasna_ms");
    if (lastV && ws && !r.override_tx) {
      add(
        "third verdict -> window start on Lasna",
        "raw: Base ms vs Lasna s (Lasna stamps run early)",
        ws - lastV,
      );
    }
    const we = num(r, "window_ends_at_ms");
    if (ws && we) add("window start -> window end", "Lasna s (config 300 s)", we - ws);
    const c = num(r, "cast_ms");
    if (c && we && !r.override_tx && !r.deferred_until) {
      add("window end -> cast on governor", "raw: Lasna s vs governor clock", c - we);
    }
    if (c && p && !r.override_tx) {
      add("proposal -> cast (whole loop)", `same clock, ${base ? "Base ms" : "Unichain s"}`, c - p);
    }
    const vt = num(r, "veto_ms");
    if (vt && lastV) add("third verdict -> owner veto tx", "Base ms (human/script latency)", vt - lastV);
  }
  return [...steps.values()].map(({ step, clock, xs }) => ({
    step,
    clock,
    n: xs.length,
    p50: nearestRank(xs, 50),
    p90: nearestRank(xs, 90),
    min: Math.min(...xs),
    max: Math.max(...xs),
  }));
}
