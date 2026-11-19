import { z } from "zod";
import {
  type BackoffOptions,
  type CompletionRequest,
  type CompletionResult,
  type FetchLike,
  isRetryableStatus,
  type Provider,
  ProviderError,
  realSleep,
  timeoutSignal,
  withBackoff,
} from "./types.ts";

export const POLLINATIONS_URL = "https://text.pollinations.ai/openai";
/** Pollinations' keyless alias for OpenAI gpt-oss-20b. */
export const POLLINATIONS_MODEL = "openai-fast";

const ResponseSchema = z.object({
  model: z.string().optional(),
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
});

export interface PollinationsOptions {
  url?: string;
  model?: string;
  fetch?: FetchLike;
  backoff?: Partial<BackoffOptions>;
  timeoutMs?: number;
  /**
   * Minimum spacing between requests. The anonymous tier allows one reply per 45 s per IP (measured
   * 2026-11-19: HTTP 402 FREE_LIMIT), so the default paces calls instead of burning retries.
   */
  minIntervalMs?: number;
  now?: () => number;
}

/**
 * OpenAI-compatible chat completion through Pollinations, keyless. The anonymous tier is rate limited, so
 * 429 and 5xx are retried with exponential backoff (default 5 retries, 3 s doubling to 60 s).
 */
export class PollinationsProvider implements Provider {
  readonly modelId: string;
  readonly temperature = 0;
  private readonly url: string;
  private readonly model: string;
  private readonly fetchImpl: FetchLike;
  private readonly backoff: BackoffOptions;
  private readonly timeoutMs: number;
  private lastRetryAfterMs: number | undefined;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private nextAllowedAt = 0;

  constructor(options: PollinationsOptions = {}) {
    this.url = options.url ?? POLLINATIONS_URL;
    this.model = options.model ?? POLLINATIONS_MODEL;
    this.modelId = `pollinations/${this.model}`;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.backoff = {
      retries: 5,
      baseDelayMs: 3_000,
      maxDelayMs: 60_000,
      sleep: realSleep,
      ...options.backoff,
    };
    this.minIntervalMs = options.minIntervalMs ?? 46_000;
    this.now = options.now ?? Date.now;
    this.backoff.now ??= this.now;
  }

  complete(request: CompletionRequest): Promise<CompletionResult> {
    return withBackoff(
      () => this.once(request),
      this.backoff,
      () => this.lastRetryAfterMs,
      request.deadline,
    );
  }

  private async once(request: CompletionRequest): Promise<CompletionResult> {
    this.lastRetryAfterMs = undefined;
    const wait = this.nextAllowedAt - this.now();
    if (request.deadline !== undefined && this.now() + Math.max(wait, 0) >= request.deadline)
      throw new ProviderError(
        `Pollinations: next free-tier slot is ${wait} ms away, past the deadline`,
        true,
      );
    if (wait > 0) await this.backoff.sleep(wait);
    this.nextAllowedAt = this.now() + this.minIntervalMs;
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
          temperature: this.temperature,
          seed: 0,
          response_format: { type: "json_object" },
        }),
        signal: timeoutSignal(this.timeoutMs, request.deadline, this.now),
      });
    } catch (err) {
      throw new ProviderError(`Pollinations request failed: ${(err as Error).message}`, true);
    }
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 300);
      // The free tier answers a rate limit with 402 FREE_LIMIT and "Retry after Ns" in the body.
      const freeLimit = response.status === 402 && body.includes("FREE_LIMIT");
      const bodyRetry = /Retry after (\d+)s/i.exec(body)?.[1];
      this.lastRetryAfterMs =
        parseRetryAfter(response.headers.get("retry-after")) ??
        (bodyRetry === undefined ? undefined : (Number(bodyRetry) + 1) * 1000);
      throw new ProviderError(
        `Pollinations returned HTTP ${response.status}: ${body}`,
        freeLimit || isRetryableStatus(response.status),
        response.status,
      );
    }
    const json: unknown = await response.json().catch(() => undefined);
    const parsed = ResponseSchema.safeParse(json);
    if (!parsed.success) throw new ProviderError("Pollinations returned an unexpected response shape", true);
    const text = parsed.data.choices[0]?.message.content ?? "";
    return parsed.data.model === undefined ? { text } : { text, servedModel: parsed.data.model };
  }
}

export function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 120_000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.min(at - Date.now(), 120_000));
}
