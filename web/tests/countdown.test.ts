import { describe, expect, it } from "vitest";
import { formatClock, isoDuration, spokenDuration, windowState } from "@/lib/countdown";

const WINDOW = 600;
const CUTOFF = 30;
const ends = 1_800_000_000; // seconds

describe("veto window countdown", () => {
  it("is open with the whole window ahead at the start", () => {
    const s = windowState((ends - WINDOW) * 1000, ends, WINDOW, CUTOFF);
    expect(s).toEqual({ leftSeconds: 600, elapsed: 0, cutoff: 0.95, phase: "open" });
  });

  it("rounds partial seconds up so it never shows 00:00 early", () => {
    const s = windowState(ends * 1000 - 400, ends, WINDOW, CUTOFF);
    expect(s.leftSeconds).toBe(1);
    expect(s.phase).toBe("closing");
  });

  it("stops presenting the veto as effective inside the cutoff", () => {
    expect(windowState((ends - 31) * 1000, ends, WINDOW, CUTOFF).phase).toBe("open");
    expect(windowState((ends - 30) * 1000, ends, WINDOW, CUTOFF).phase).toBe("closing");
  });

  it("closes at the deadline and stays closed after it", () => {
    expect(windowState(ends * 1000, ends, WINDOW, CUTOFF)).toMatchObject({
      leftSeconds: 0,
      elapsed: 1,
      phase: "closed",
    });
    expect(windowState((ends + 90) * 1000, ends, WINDOW, CUTOFF).phase).toBe("closed");
  });

  it("tracks elapsed share linearly", () => {
    expect(windowState((ends - 402) * 1000, ends, WINDOW, CUTOFF).elapsed).toBeCloseTo(0.33, 2);
  });

  it("clamps a clock that runs ahead of a restarted window", () => {
    // A changed decision restarts the window in full; a stale endsAt far in the future must not go negative.
    expect(windowState((ends - 5000) * 1000, ends, WINDOW, CUTOFF).elapsed).toBe(0);
  });

  it("formats the clock", () => {
    expect(formatClock(402)).toBe("06:42");
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(3_999)).toBe("1:06:39");
    expect(formatClock(-5)).toBe("00:00");
    expect(isoDuration(402)).toBe("PT6M42S");
    expect(isoDuration(3_999)).toBe("PT1H6M39S");
    expect(spokenDuration(600)).toBe("10 minutes");
    expect(spokenDuration(330)).toBe("5 minutes 30 seconds");
    expect(spokenDuration(1)).toBe("1 second");
  });
});
