#!/usr/bin/env python3
"""Per-step timing and cost of the live run from evidence/cases.csv (written by trace.ts). Prints Markdown tables and
writes evidence/live/stats.json. Nearest-rank percentiles. A block clock is only subtracted from itself unless the
row says "raw"."""
import csv, json, math
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
rows = list(csv.DictReader((REPO / "evidence" / "cases.csv").open()))


def ms_map(cell: str) -> dict:
    out = {}
    for part in cell.split():
        k, _, v = part.partition(":")
        if v:
            out[k] = int(v)
    return out


def pct(xs, p):
    xs = sorted(xs)
    return xs[max(0, math.ceil(p / 100 * len(xs)) - 1)] if xs else None


def num(r, k):
    return int(r[k]) if r.get(k) else None


steps = {}


def add(name, clock, v):
    if v is not None:
        steps.setdefault((name, clock), []).append(v)


for r in rows:
    base = r["governor_chain"] == "84532"
    p, o = num(r, "proposal_ms"), num(r, "docket_open_ms")
    vm = ms_map(r["verdict_ms"])
    last_v = max(vm.values()) if vm else None
    first_v = min(vm.values()) if vm else None
    if base and p and o:
        add("proposal -> case open on Docket", "Base ms (200 ms)", o - p)
    if not base and p and o:
        add("proposal -> case open on Docket", "raw: Unichain s vs Base ms (+-1 s)", o - p)
    if o and first_v:
        add("case open -> first verdict", "Base ms", first_v - o)
    if o and last_v and len(vm) == 3:
        add("case open -> third verdict (quorum 3)", "Base ms", last_v - o)
    ws = num(r, "window_started_lasna_ms")
    if last_v and ws and not r["override_tx"]:
        add("third verdict -> window start on Lasna", "raw: Base ms vs Lasna s (Lasna stamps run early)", ws - last_v)
    we = num(r, "window_ends_at_ms")
    if ws and we:
        add("window start -> window end", "Lasna s (config 300 s)", we - ws)
    c = num(r, "cast_ms")
    if c and we and not r["override_tx"] and not r["deferred_until"]:
        add("window end -> cast on governor", "raw: Lasna s vs governor clock", c - we)
    if c and p and not r["override_tx"]:
        clock = "Base ms" if base else "Unichain s"
        add("proposal -> cast (whole loop)", f"same clock, {clock}", c - p)
    vt = num(r, "veto_ms")
    if vt and last_v:
        add("third verdict -> owner veto tx", "Base ms (human/script latency)", vt - last_v)

print("| Step | Clock | n | p50 | p90 | min | max |")
print("|---|---|---|---|---|---|---|")
table = []
for (name, clock), xs in steps.items():
    row = dict(step=name, clock=clock, n=len(xs), p50=pct(xs, 50), p90=pct(xs, 90), min=min(xs), max=max(xs))
    table.append(row)
    f = lambda v: f"{v / 1000:,.1f} s"
    print(f"| {name} | {clock} | {len(xs)} | {f(row['p50'])} | {f(row['p90'])} | {f(row['min'])} | {f(row['max'])} |")

costs = [(r["label"], r["outcome"], float(r["lreact"])) for r in rows if r["lreact"]]
print()
print("| Case | Outcome | lREACT |")
print("|---|---|---|")
for label, outcome, c in costs:
    print(f"| {label} | {outcome} | {c:.4f} |")
total = sum(c for _, _, c in costs)
print(f"\ntotal attributed {total:.4f} lREACT over {len(costs)} cases, mean {total / max(1, len(costs)):.4f}")
(REPO / "evidence" / "live" / "stats.json").write_text(json.dumps({"steps": table, "costs": costs, "total": total}, indent=2) + "\n")
