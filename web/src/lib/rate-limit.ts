/**
 * Sliding-window limiter kept in process memory. On Vercel each warm instance has its own memory, so the
 * effective global limit is per instance; the contract's per-governor `maxPerHour` is the hard cap behind it.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Records a hit if allowed. Returns the time until the next slot when refused. */
  take(
    key: string,
    now: number,
  ): { allowed: true; remaining: number } | { allowed: false; retryAfterMs: number } {
    const since = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return { allowed: false, retryAfterMs: Math.max(1, oldest + this.windowMs - now) };
    }
    recent.push(now);
    this.hits.delete(key);
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) {
      // Map keeps insertion order and every hit re-inserts its key, so the first key is the least recent.
      const first = this.hits.keys().next();
      if (!first.done) this.hits.delete(first.value);
    }
    return { allowed: true, remaining: this.limit - recent.length };
  }

  /** Undoes the latest hit, for requests refused later for a reason that is not the visitor's. */
  refund(key: string): void {
    const recent = this.hits.get(key);
    if (recent && recent.length > 0) recent.pop();
  }
}

/**
 * Two-window estimate used by the durable limiter: the previous fixed window counts for the share of it that
 * still lies inside the last `windowMs`.
 */
export function slidingEstimate(
  previous: number,
  current: number,
  elapsedMs: number,
  windowMs: number,
): number {
  const overlap = Math.max(0, 1 - Math.min(elapsedMs, windowMs) / windowMs);
  return previous * overlap + current;
}

/** Milliseconds until one more hit fits under `limit`, given counts that already exclude the refused hit. */
export function retryAfterMs(
  previous: number,
  current: number,
  limit: number,
  elapsedMs: number,
  windowMs: number,
): number {
  if (current < limit) {
    if (previous === 0) return 1;
    // previous * (1 - (elapsed + t) / W) + current + 1 <= limit
    const t = windowMs * (1 - (limit - current - 1) / previous) - elapsedMs;
    return Math.max(1, Math.ceil(t));
  }
  // The current window is full: wait for it to become the previous one, then for enough of it to slide out.
  const intoNext = windowMs * (1 - (limit - 1) / current);
  return Math.max(1, Math.ceil(windowMs - elapsedMs + Math.max(0, intoNext)));
}
