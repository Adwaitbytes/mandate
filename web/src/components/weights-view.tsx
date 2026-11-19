"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { isAddressEqual } from "viem";
import { txUrl } from "@/lib/chains";
import { deployments, jurors, reactiveReady } from "@/lib/config";
import { formatUtc, shortHash } from "@/lib/format";
import { readWeightHistory, type WeightHistory } from "@/lib/reads";
import { NotDeployed, ReadError, SkeletonLines } from "./states";

const DASH = ["", "6 4", "1.5 3.5"] as const;

function Head() {
  return (
    <div className="docket-head">
      <h1>Juror weights</h1>
      <p>
        Every veto or override moves each juror that ruled on the case one step toward the owner if it agreed,
        one step away if not. Read from WeightsUpdated on Lasna.
      </p>
    </div>
  );
}

export function WeightsView() {
  if (!reactiveReady) {
    return (
      <NotDeployed
        title="Weights appear when the reactive contract is deployed"
        what={[{ name: "MandateReactive", chain: "Reactive Lasna", address: deployments.reactive.address }]}
      >
        <p>
          Weights live in MandateReactive on Lasna, which is not deployed yet. Every juror will start at the
          contract&apos;s initial weight and move only when the owner vetoes or overrides a case.
        </p>
      </NotDeployed>
    );
  }
  return <LiveWeights />;
}

function LiveWeights() {
  const q = useQuery({ queryKey: ["weights"], queryFn: readWeightHistory, refetchInterval: 60_000 });
  if (q.isPending) {
    return (
      <>
        <Head />
        <p role="status" className="visually-hidden">
          Reading weight history from Lasna
        </p>
        <div style={{ minHeight: "22rem", paddingTop: "2rem" }}>
          <SkeletonLines lines={8} />
        </div>
      </>
    );
  }
  if (q.isError) {
    return (
      <>
        <Head />
        <ReadError error={q.error} retry={() => void q.refetch()} />
      </>
    );
  }
  const h = q.data;
  return (
    <>
      <Head />
      <div className="with-notes" style={{ marginTop: "2rem" }}>
        <div>
          <h2 className="label">Now</h2>
          <table className="tally" style={{ fontSize: "var(--text-body)" }}>
            <thead>
              <tr>
                <th scope="col">Juror</th>
                <th scope="col">Model</th>
                <th scope="col" className="num">
                  Weight
                </th>
              </tr>
            </thead>
            <tbody>
              {h.current.map((c) => {
                const j = jurors.find((x) => isAddressEqual(x.address, c.juror));
                return (
                  <tr key={c.juror}>
                    <th scope="row">{j?.name ?? shortHash(c.juror)}</th>
                    <td>{j?.model ?? ""}</td>
                    <td className="num">
                      {c.weight}
                      <span className="bar">
                        <i style={{ width: `${(c.weight / h.bounds.max) * 100}%` }} />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <h2 className="label" style={{ marginTop: "2.5rem" }}>
            Over time
          </h2>
          {h.changes.length === 0 ? (
            <p className="notice">
              <strong>No weight has moved yet</strong>
              <span>
                The owner has not vetoed or overridden a case since block{" "}
                {h.scannedFrom.toLocaleString("en-GB")}, so every juror keeps the starting weight of{" "}
                {h.bounds.initial}.
              </span>
            </p>
          ) : (
            <>
              <Chart history={h} />
              <ChangeTable history={h} />
            </>
          )}
        </div>
        <aside aria-label="Notes on weights">
          <p className="note">
            <b>Bounds</b>
            Weights start at {h.bounds.initial}, move {h.bounds.step} per owner action and stay between{" "}
            {h.bounds.min} and {h.bounds.max}.
          </p>
          <p className="note">
            <b>Why weight cannot decide alone</b>A side also needs two confident jurors on it, so a juror the
            owner trusts can block a decision but never carry one by itself.
          </p>
          <p className="note">
            <b>Scanned</b>
            Lasna blocks {h.scannedFrom.toLocaleString("en-GB")} to {h.scannedTo.toLocaleString("en-GB")}.
          </p>
        </aside>
      </div>
    </>
  );
}

function Chart({ history }: { history: WeightHistory }) {
  const W = 720;
  const H = 260;
  const pad = { l: 44, r: 150, t: 12, b: 28 };
  const steps = history.changes.length;
  const x = (i: number) => pad.l + (i / Math.max(1, steps)) * (W - pad.l - pad.r);
  // The axis runs from the floor to a little above the highest weight seen, not to the ceiling, so small moves
  // stay readable; the ceiling is stated in the notes beside the chart.
  const seen = Math.max(
    history.bounds.initial,
    ...history.changes.flatMap((c) => c.weights.map((w) => w.weight)),
  );
  const top = Math.min(history.bounds.max, seen + 2 * history.bounds.step);
  const y = (w: number) =>
    pad.t + (1 - (w - history.bounds.min) / Math.max(1, top - history.bounds.min)) * (H - pad.t - pad.b);
  const ticks = [...new Set([history.bounds.min, history.bounds.initial, top])];
  const series = jurors.map((j, idx) => {
    let w = history.bounds.initial;
    const pts: [number, number][] = [[x(0), y(w)]];
    history.changes.forEach((c, i) => {
      const hit = c.weights.find((cw) => isAddressEqual(cw.juror, j.address));
      if (hit) {
        pts.push([x(i + 1), y(w)]);
        w = hit.weight;
      }
      pts.push([x(i + 1), y(w)]);
    });
    return {
      j,
      d: pts.map(([px, py], k) => `${k === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`).join(" "),
      end: w,
      dash: DASH[idx] ?? "",
    };
  });
  // End labels: stack any that would collide, keeping at least 18 units between baselines.
  const labelY = new Map<number, number>();
  let last = Number.NEGATIVE_INFINITY;
  for (const s of [...series].sort((a, b) => y(a.end) - y(b.end))) {
    const at = Math.max(y(s.end) + 5, last + 18);
    labelY.set(s.j.id, at);
    last = at;
  }
  return (
    <figure style={{ margin: "1rem 0 0" }}>
      <svg
        className="weights-chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-labelledby="chart-title chart-desc"
      >
        <title id="chart-title">Juror weight after each owner action</title>
        <desc id="chart-desc">
          {series.map((s) => `${s.j.name} ends at ${s.end}`).join(". ")}. {steps} owner actions changed
          weights.
        </desc>
        <g className="axis">
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
              <text x={pad.l - 8} y={y(t) + 4} textAnchor="end">
                {t}
              </text>
            </g>
          ))}
          <text x={pad.l} y={H - 6}>
            start
          </text>
          <text x={W - pad.r} y={H - 6} textAnchor="end">
            case {history.changes.at(-1)?.caseId.toString()}
          </text>
        </g>
        {series.map((s) => (
          <g key={s.j.id}>
            <path className="series" d={s.d} stroke="var(--ink)" strokeDasharray={s.dash} />
            <text className="end-label" x={W - pad.r + 10} y={labelY.get(s.j.id) ?? y(s.end) + 5}>
              {s.j.short} {s.end}
            </text>
          </g>
        ))}
      </svg>
    </figure>
  );
}

function ChangeTable({ history }: { history: WeightHistory }) {
  return (
    <table className="tally" style={{ marginTop: "1.5rem" }}>
      <caption className="visually-hidden">Each owner action and the weights it left</caption>
      <thead>
        <tr>
          <th scope="col">Case</th>
          <th scope="col">When</th>
          {jurors.map((j) => (
            <th key={j.id} scope="col" className="num">
              {j.short}
            </th>
          ))}
          <th scope="col" className="hash-col">
            Lasna tx
          </th>
        </tr>
      </thead>
      <tbody>
        {[...history.changes].reverse().map((c) => (
          <tr key={c.txHash}>
            <td>
              <Link href={`/docket/${c.caseId}`}>{c.caseId.toString()}</Link>
            </td>
            <td>{formatUtc(c.at)}</td>
            {jurors.map((j) => (
              <td key={j.id} className="num">
                {c.weights.find((w) => isAddressEqual(w.juror, j.address))?.weight ?? "unchanged"}
              </td>
            ))}
            <td className="hash-col">
              <a
                href={txUrl(5318007, c.txHash) ?? "#"}
                target="_blank"
                rel="noopener noreferrer"
                className="hash"
              >
                {shortHash(c.txHash)}
              </a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
