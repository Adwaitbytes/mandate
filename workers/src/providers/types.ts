export interface CompletionRequest {
  system: string;
  user: string;
}

export interface CompletionResult {
  /** Raw text the model returned. */
  text: string;
  /** The model the provider reports having served, when it reports one. Informational. */
  servedModel?: string;
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
}

export const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Retries retryable ProviderErrors with exponential backoff, honouring a server Retry-After when given. */
export async function withBackoff<T>(
  attempt: () => Promise<T>,
  options: BackoffOptions,
  retryAfterMs?: (err: ProviderError) => number | undefined,
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (!(err instanceof ProviderError) || !err.retryable || i >= options.retries) throw err;
      const exp = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** i);
      await options.sleep(Math.max(exp, retryAfterMs?.(err) ?? 0));
    }
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}
