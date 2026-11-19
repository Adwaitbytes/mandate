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
  }

  complete(request: CompletionRequest): Promise<CompletionResult> {
    return withBackoff(
      () => this.once(request),
      this.backoff,
      () => this.lastRetryAfterMs,
    );
  }

  private async once(request: CompletionRequest): Promise<CompletionResult> {
    this.lastRetryAfterMs = undefined;
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
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ProviderError(`Pollinations request failed: ${(err as Error).message}`, true);
    }
    if (!response.ok) {
      this.lastRetryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      const body = (await response.text().catch(() => "")).slice(0, 300);
      throw new ProviderError(
        `Pollinations returned HTTP ${response.status}: ${body}`,
        isRetryableStatus(response.status),
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
