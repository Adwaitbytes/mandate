export type WindowPhase = "open" | "closing" | "closed";

export interface WindowState {
  /** Whole seconds left, rounded up so the clock reads 00:01 until the window has truly closed. */
  leftSeconds: number;
  /** Share of the window already elapsed, 0 to 1. */
  elapsed: number;
  /** Where the veto stops being effective along the window, 0 to 1. */
  cutoff: number;
  /** open: a veto can still land; closing: inside the cutoff, the vote may already be out; closed: over. */
  phase: WindowPhase;
}

export function windowState(
  nowMs: number,
  endsAtSeconds: number,
  windowSeconds: number,
  cutoffSeconds: number,
): WindowState {
  const total = Math.max(1, windowSeconds) * 1000;
  const leftMs = Math.max(0, endsAtSeconds * 1000 - nowMs);
  const leftSeconds = Math.ceil(leftMs / 1000);
  const elapsed = Math.min(1, Math.max(0, (total - leftMs) / total));
  const cutoff = Math.min(1, Math.max(0, 1 - cutoffSeconds / Math.max(1, windowSeconds)));
  const phase: WindowPhase = leftMs === 0 ? "closed" : leftSeconds <= cutoffSeconds ? "closing" : "open";
  return { leftSeconds, elapsed, cutoff, phase };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 06:42, or 1:06:42 past an hour. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

/** ISO 8601 duration for <time datetime>. */
export function isoDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `PT${h > 0 ? `${h}H` : ""}${m}M${s % 60}S`;
}

/** "10 minutes", "5 minutes 30 seconds", "45 seconds" for running text. */
export function spokenDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} ${h === 1 ? "hour" : "hours"}`);
  if (m) parts.push(`${m} ${m === 1 ? "minute" : "minutes"}`);
  if (r || parts.length === 0) parts.push(`${r} ${r === 1 ? "second" : "seconds"}`);
  return parts.join(" ");
}
