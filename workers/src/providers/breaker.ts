import type { ProviderError } from "./types.ts";

/**
 * How a provider failure bears on the next call:
 * - `quota`: a daily cap, spent credit or a rejected key. Retrying within minutes cannot help.
 * - `transient`: rate limit, overload, 5xx, timeout or a dropped connection. Likely to clear soon.
 * - `request`: the provider rejected this request (400 and similar). Says nothing about the provider's health.
 */
export type FailureKind = "quota" | "transient" | "request";

const DAILY_CAP =
  /tokens per day|requests per day|\(TPD\)|\(RPD\)|PerDay|per day|daily (limit|cap|quota)|credit balance|billing|insufficient_quota/i;
/** Google reports a spent free tier as "exceeded your current quota"; its per-minute window is the exception. */
const QUOTA_SPENT = /exceeded your current quota|RESOURCE_EXHAUSTED/i;
const PER_MINUTE = /PerMinute|per minute|\(TPM\)|\(RPM\)/i;

export function classifyFailure(err: ProviderError): FailureKind {
  const m = err.message;
  if (err.status === 401 || err.status === 403) return "quota";
  if (DAILY_CAP.test(m)) return "quota";
  if (QUOTA_SPENT.test(m) && !PER_MINUTE.test(m)) return "quota";
  if (err.retryable) return "transient";
  // Pollinations answers a spent paid balance with 402; its anonymous 45 s limit is 402 FREE_LIMIT (retryable).
  if (err.status === 402) return "quota";
  return "request";
}

export interface BreakerOptions {
  /** Consecutive transient failures that open the breaker. */
  failureThreshold: number;
  /** How long the breaker stays open after transient failures. */
  cooldownMs: number;
  /** How long it stays open after a quota failure (daily cap, spent credit, rejected key). */
  quotaCooldownMs: number;
  now: () => number;
}

export const DEFAULT_BREAKER: Omit<BreakerOptions, "now"> = {
  failureThreshold: 2,
  cooldownMs: 5 * 60_000,
  quotaCooldownMs: 60 * 60_000,
};

/**
 * Per-provider circuit breaker. Closed: calls go through. Open: calls are skipped until the cool-down ends, then
 * one trial call is let through (half-open); success closes it, failure opens it again for a full cool-down.
 * One process serves one juror, so the state is in memory and resets on restart, which costs at most one call.
 */
export class CircuitBreaker {
  private readonly options: BreakerOptions;
  private consecutiveFailures = 0;
  private openUntil = 0;
  private lastReason = "";

  constructor(options: Partial<BreakerOptions> = {}) {
    this.options = { ...DEFAULT_BREAKER, now: Date.now, ...options };
  }

  /** True when a call may be made now (closed, or open with the cool-down over). */
  canCall(): boolean {
    return this.options.now() >= this.openUntil;
  }

  /** Milliseconds until the next call is allowed; 0 when closed. */
  remainingMs(): number {
    return Math.max(0, this.openUntil - this.options.now());
  }

  get reason(): string {
    return this.lastReason;
  }

  onSuccess(): void {
    this.consecutiveFailures = 0;
    this.openUntil = 0;
    this.lastReason = "";
  }

  /** Records a failure and returns the kind it was classified as. */
  onFailure(err: ProviderError): FailureKind {
    const kind = classifyFailure(err);
    if (kind === "request") return kind;
    this.lastReason = err.message.replace(/\s+/g, " ").trim().slice(0, 160);
    const now = this.options.now();
    if (kind === "quota") {
      this.consecutiveFailures = 0;
      this.openUntil = now + this.options.quotaCooldownMs;
      return kind;
    }
    this.consecutiveFailures++;
    // A failed half-open trial reopens at once; otherwise the threshold decides.
    const wasOpen = this.openUntil !== 0;
    if (wasOpen || this.consecutiveFailures >= this.options.failureThreshold) {
      this.openUntil = now + this.options.cooldownMs;
      this.consecutiveFailures = 0;
    }
    return kind;
  }
}
