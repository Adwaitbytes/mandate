import { classifyFailure } from "./breaker.ts";

export interface CompletionRequest {
  system: string;
  user: string;
  /**
   * Epoch ms after which the caller has moved on (the provider chain's per-link budget). Providers stop retrying
   * and cap their request timeout so they give up by then instead of stalling the juror.
   */
  deadline?: number;
}

export interface CompletionResult {
  /** Raw text the model returned. */
  text: string;
  /** The model the provider reports having served, when it reports one. Informational. */
  servedModel?: string;
  /** `<provider>/<model>` that answered, when it differs from the provider's own (fallbacks). */
  modelId?: string;
  temperature?: number | null;
  /** Links a provider chain passed over before this answer, each with the reason. */
  passedOver?: string[];
}

export interface Provider {
  /** `<provider>/<model>`, hashed into modelIdHash on chain. */
  readonly modelId: string;
  /** Sampling temperature actually sent, or null when the provider does not accept one. */
  readonly temperature: number | null;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class ProviderError extends Error {
  override readonly name = "ProviderError";
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface BackoffOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
}

export const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Retries retryable ProviderErrors with exponential backoff, honouring a server Retry-After when given. With a
 * deadline, a retry whose wait would end at or after it is not attempted: the last error is thrown at once so the
 * provider chain can move to the next link.
 */
export async function withBackoff<T>(
  attempt: () => Promise<T>,
  options: BackoffOptions,
  retryAfterMs?: (err: ProviderError) => number | undefined,
  deadline?: number,
): Promise<T> {
  const now = options.now ?? Date.now;
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (!(err instanceof ProviderError) || !err.retryable || i >= options.retries) throw err;
      // A daily cap or spent quota does not clear in seconds: hand it to the chain's breaker instead of waiting.
      if (classifyFailure(err) === "quota") throw err;
      const exp = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** i);
      const wait = Math.max(exp, retryAfterMs?.(err) ?? 0);
      if (deadline !== undefined && now() + wait >= deadline) throw err;
      await options.sleep(wait);
    }
  }
}

/** Request timeout signal: the provider's own timeout, cut short by the caller's deadline when that comes first. */
export function timeoutSignal(
  timeoutMs: number,
  deadline?: number,
  now: () => number = Date.now,
): AbortSignal {
  const ms = deadline === undefined ? timeoutMs : Math.min(timeoutMs, Math.max(1, deadline - now()));
  return AbortSignal.timeout(ms);
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}
