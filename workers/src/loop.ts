import { describeError, isTransientRpcError } from "./chain/rpc.ts";

export interface LoopBackoff {
  /** First delay after a failed pass that was a transient RPC error; doubles per consecutive failure. */
  transientBaseMs: number;
  /** First delay after any other failure. */
  unexpectedBaseMs: number;
  maxMs: number;
}

export const DEFAULT_LOOP_BACKOFF: LoopBackoff = {
  transientBaseMs: 2_000,
  unexpectedBaseMs: 10_000,
  maxMs: 120_000,
};

export interface PollLoopOptions<S> {
  poll: () => Promise<S>;
  onPass?: (summary: S) => void;
  intervalMs: number;
  log: (message: string) => void;
  backoff?: Partial<LoopBackoff>;
  /** Resolves after `ms`, or early when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  /** Ends the loop after the pass in progress. */
  signal?: AbortSignal;
}

/** Exponential backoff with equal jitter: half the step fixed, half random, so restarted jurors spread out. */
export function backoffDelay(failures: number, baseMs: number, maxMs: number, random: () => number): number {
  const step = Math.min(maxMs, baseMs * 2 ** Math.max(0, failures - 1));
  return Math.round(step / 2 + (random() * step) / 2);
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * The juror's main loop. A pass that throws (the head-block read or a log query failing on a flaky public RPC)
 * never ends the process: it is logged and the next pass runs after a jittered exponential backoff, shorter for
 * transient RPC errors than for anything else. A successful pass resets the backoff. Per-case failures are
 * already contained by `pollOnce`; this catches what happens around them.
 */
export async function runPollLoop<S>(options: PollLoopOptions<S>): Promise<void> {
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;
  const backoff = { ...DEFAULT_LOOP_BACKOFF, ...options.backoff };
  const stopped = (): boolean => options.signal?.aborted === true;
  let failures = 0;
  while (!stopped()) {
    let wait = options.intervalMs;
    try {
      const summary = await options.poll();
      failures = 0;
      options.onPass?.(summary);
    } catch (err) {
      failures++;
      const transient = isTransientRpcError(err);
      const base = transient ? backoff.transientBaseMs : backoff.unexpectedBaseMs;
      wait = Math.max(options.intervalMs, backoffDelay(failures, base, backoff.maxMs, random));
      options.log(
        `pass failed (${transient ? "transient RPC error" : "unexpected error"}, ${failures} in a row): ${describeError(err)}; next pass in ${Math.round(wait / 1000)} s`,
      );
    }
    if (stopped()) break;
    await sleep(wait, options.signal);
  }
}

/**
 * Retries a startup step (chain id check, juror registration read) on transient RPC errors with the same
 * backoff; anything else, such as a ConfigError, is thrown at once.
 */
export async function retryTransient<T>(
  label: string,
  fn: () => Promise<T>,
  options: {
    log: (message: string) => void;
    attempts?: number;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
  },
): Promise<T> {
  const attempts = options.attempts ?? 8;
  const sleep = options.sleep ?? ((ms: number) => abortableSleep(ms));
  const random = options.random ?? Math.random;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientRpcError(err) || i >= attempts) throw err;
      const wait = backoffDelay(i, DEFAULT_LOOP_BACKOFF.transientBaseMs, DEFAULT_LOOP_BACKOFF.maxMs, random);
      options.log(`${label} failed (${describeError(err)}); retrying in ${Math.round(wait / 1000)} s`);
      await sleep(wait);
    }
  }
}
