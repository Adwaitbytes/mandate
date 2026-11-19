import { z } from "zod";
import { parseRetryAfter } from "./pollinations.ts";
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

export const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
/** OpenAI gpt-oss-120b served by Groq. */
export const GROQ_MODEL = "openai/gpt-oss-120b";

const ResponseSchema = z.object({
  model: z.string().optional(),
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
});

export interface GroqOptions {
  apiKey: string;
  model?: string;
  url?: string;
  fetch?: FetchLike;
  backoff?: Partial<BackoffOptions>;
  timeoutMs?: number;
  /** Sent as response_format json_object. Off for classifier models, which answer with a bare score. */
  jsonMode?: boolean;
}

/**
 * OpenAI-compatible chat completion on Groq. The free tier is limited by tokens per minute (8,000 for
 * gpt-oss-120b, measured 2026-11-19), so 429 is retried after the server's Retry-After.
 */
export class GroqProvider implements Provider {
  readonly modelId: string;
  readonly temperature = 0;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly url: string;
  private readonly fetchImpl: FetchLike;
  private readonly backoff: BackoffOptions;
  private readonly timeoutMs: number;
  private readonly jsonMode: boolean;
  private lastRetryAfterMs: number | undefined;

  constructor(options: GroqOptions) {
    if (options.apiKey.trim() === "")
      throw new ProviderError("No Groq API key configured (GROQ_API_KEY)", false);
    this.apiKey = options.apiKey;
    this.model = options.model ?? GROQ_MODEL;
    this.modelId = `groq/${this.model}`;
    this.url = options.url ?? GROQ_URL;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.jsonMode = options.jsonMode ?? true;
    this.backoff = {
      retries: 4,
      baseDelayMs: 5_000,
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
    const messages =
      request.system === ""
        ? [{ role: "user", content: request.user }]
        : [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ];
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: this.temperature,
          seed: 0,
          ...(this.jsonMode ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ProviderError(`Groq request failed: ${(err as Error).message}`, true);
    }
    if (!response.ok) {
      this.lastRetryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      const body = (await response.text().catch(() => "")).slice(0, 300);
      throw new ProviderError(
        `Groq returned HTTP ${response.status}: ${body}`,
        isRetryableStatus(response.status),
        response.status,
      );
    }
    const parsed = ResponseSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new ProviderError("Groq returned an unexpected response shape", true);
    const text = parsed.data.choices[0]?.message.content ?? "";
    return parsed.data.model === undefined ? { text } : { text, servedModel: parsed.data.model };
  }
}
