const utc = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "UTC",
  hourCycle: "h23",
});

/** 19 Nov 2026, 14:02:11 UTC */
export function formatUtc(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return "time not read";
  return `${utc.format(new Date(seconds * 1000))} UTC`;
}

/** 0x5d1e…a07c */
export function shortHash(hash: string, lead = 6, tail = 4): string {
  return hash.length <= lead + tail + 2 ? hash : `${hash.slice(0, lead)}…${hash.slice(-tail)}`;
}

/** Proposal ids are 256-bit; the court list shows the head and tail. */
export function shortId(id: bigint): string {
  const s = id.toString();
  return s.length <= 12 ? s : `${s.slice(0, 6)}…${s.slice(-4)}`;
}

/** "3 minutes", "40 seconds" for elapsed time between hops. */
export function gap(fromSeconds: number | null, toSeconds: number | null): string | null {
  if (fromSeconds === null || toSeconds === null || fromSeconds <= 0 || toSeconds <= 0) return null;
  const d = Math.max(0, toSeconds - fromSeconds);
  if (d < 90) return `${d} s`;
  if (d < 5400) return `${Math.round(d / 60)} min`;
  return `${(d / 3600).toFixed(1)} h`;
}
