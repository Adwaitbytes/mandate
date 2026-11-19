import { describe, expect, it } from "vitest";
import { retryAfterMs, SlidingWindowLimiter, slidingEstimate } from "@/lib/rate-limit";

const HOUR = 3_600_000;

describe("sliding window limiter", () => {
  it("allows up to the limit, then refuses with the wait until the oldest hit expires", () => {
    const l = new SlidingWindowLimiter(3, HOUR);
    expect(l.take("ip", 0)).toEqual({ allowed: true, remaining: 2 });
    expect(l.take("ip", 1000)).toEqual({ allowed: true, remaining: 1 });
    expect(l.take("ip", 2000)).toEqual({ allowed: true, remaining: 0 });
    expect(l.take("ip", 3000)).toEqual({ allowed: false, retryAfterMs: HOUR - 3000 });
    expect(l.take("ip", HOUR + 1)).toEqual({ allowed: true, remaining: 0 });
  });

  it("keeps keys apart", () => {
    const l = new SlidingWindowLimiter(1, HOUR);
    expect(l.take("a", 0).allowed).toBe(true);
    expect(l.take("b", 0).allowed).toBe(true);
    expect(l.take("a", 1).allowed).toBe(false);
  });

  it("does not count refused requests as hits", () => {
    const l = new SlidingWindowLimiter(1, HOUR);
    l.take("a", 0);
    l.take("a", 10);
    l.take("a", 20);
    expect(l.take("a", HOUR + 1).allowed).toBe(true);
  });

  it("refunds the latest hit", () => {
    const l = new SlidingWindowLimiter(1, HOUR);
    l.take("a", 0);
    l.refund("a");
    expect(l.take("a", 1).allowed).toBe(true);
  });

  it("evicts the least recently used key past the cap", () => {
    const l = new SlidingWindowLimiter(1, HOUR, 2);
    l.take("a", 0);
    l.take("b", 1);
    l.take("c", 2);
    expect(l.take("a", 3).allowed).toBe(true);
    expect(l.take("c", 4).allowed).toBe(false);
  });
});

describe("two-window estimate for the durable limiter", () => {
  it("weighs the previous window by its remaining overlap", () => {
    expect(slidingEstimate(10, 2, 0, HOUR)).toBe(12);
    expect(slidingEstimate(10, 2, HOUR / 2, HOUR)).toBe(7);
    expect(slidingEstimate(10, 2, HOUR, HOUR)).toBe(2);
  });

  it("waits until enough of the previous window has slid out", () => {
    // 3 per hour, 2 in the previous window, 1 now, a quarter of the way in: estimate 2.5, so one more is over.
    const wait = retryAfterMs(2, 1, 3, HOUR / 4, HOUR);
    expect(slidingEstimate(2, 1, HOUR / 4 + wait, HOUR) + 1).toBeLessThanOrEqual(3);
    expect(slidingEstimate(2, 1, HOUR / 4 + wait - 60_000, HOUR) + 1).toBeGreaterThan(3);
  });

  it("waits into the next window when the current one is full", () => {
    const wait = retryAfterMs(0, 3, 3, HOUR / 2, HOUR);
    expect(wait).toBeGreaterThan(HOUR / 2);
    // In the next window the full one is "previous"; one more hit must fit at that point.
    expect(slidingEstimate(3, 0, wait - HOUR / 2, HOUR) + 1).toBeLessThanOrEqual(3.0001);
  });
});
