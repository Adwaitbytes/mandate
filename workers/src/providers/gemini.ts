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

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
/** Google's rolling Flash alias. The served version (for example gemini-3.8-flash) is recorded per verdict. */
export const GEMINI_MODEL = "gemini-flash-latest";

/** The verdict schema in Gemini's OpenAPI-subset form; zod still enforces lengths and ranges afterwards. */
export const GEMINI_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    support: { type: "STRING", enum: ["for", "against", "abstain"] },
    confidence: { type: "INTEGER" },
    injection_attempt: { type: "BOOLEAN" },
    rationale: { type: "STRING" },
    cited_mandate_clauses: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["support", "confidence", "injection_attempt", "rationale", "cited_mandate_clauses"],
  propertyOrdering: ["support", "confidence", "injection_attempt", "rationale", "cited_mandate_clauses"],
} as const;

const ResponseSchema = z.object({
  modelVersion: z.string().optional(),
  candidates: z
    .array(
      z.object({
        finishReason: z.string().optional(),
        content: z
          .object({
            parts: z.array(z.object({ text: z.string().optional(), thought: z.boolean().optional() })),
          })
          .optional(),
      }),
    )
    .optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
});

export interface GeminiOptions {
  /** API keys in fallback order. The next key is tried on 429 or 503 (Google's "high demand"). */
  apiKeys: readonly string[];
  model?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  backoff?: Partial<BackoffOptions>;
  timeoutMs?: number;
}

/**
 * Gemini through the REST generateContent endpoint: temperature 0, JSON response mode with a response schema,
 * low thinking. Overload (429, 503) is common on the free tier, so each attempt walks the key list before backing
 * off, and timeouts count as retryable.
 */
export class GeminiProvider implements Provider {
  readonly modelId: string;
  readonly temperature = 0;
  private readonly model: string;
  private readonly keys: string[];
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly backoff: BackoffOptions;
  private readonly timeoutMs: number;

  constructor(options: GeminiOptions) {
    this.keys = options.apiKeys.filter((k) => k.trim() !== "");
    if (this.keys.length === 0)
      throw new ProviderError("No Gemini API key configured (GEMINI_API_KEY)", false);
    this.model = options.model ?? GEMINI_MODEL;
    if (!/^[\w.-]+$/.test(this.model))
      throw new ProviderError(`Invalid Gemini model name: ${this.model}`, false);
    this.modelId = `google/${this.model}`;
    this.baseUrl = (options.baseUrl ?? GEMINI_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.backoff = {
      retries: 3,
      baseDelayMs: 5_000,
      maxDelayMs: 30_000,
      sleep: realSleep,
      ...options.backoff,
    };
  }

  complete(request: CompletionRequest): Promise<CompletionResult> {
    return withBackoff(() => this.acrossKeys(request), this.backoff);
  }

  private async acrossKeys(request: CompletionRequest): Promise<CompletionResult> {
    let last: ProviderError | undefined;
    for (const key of this.keys) {
      try {
        return await this.once(key, request);
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        last = err;
        const overloaded = err.status === 429 || err.status === 503 || err.status === undefined;
        if (!overloaded) throw err;
      }
    }
    throw last ?? new ProviderError("Gemini: no key attempted", true);
  }

  private async once(key: string, request: CompletionRequest): Promise<CompletionResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/${this.model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-goog-api-key": key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: request.system }] },
          contents: [{ role: "user", parts: [{ text: request.user }] }],
          generationConfig: {
            temperature: this.temperature,
            responseMimeType: "application/json",
            responseSchema: GEMINI_RESPONSE_SCHEMA,
            thinkingConfig: { thinkingLevel: "low" },
          },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ProviderError(`Gemini request failed: ${(err as Error).message}`, true);
    }
    if (!response.ok) {
      // The body may echo request details but never the key, which travels in a header.
      const body = (await response.text().catch(() => "")).slice(0, 300);
      throw new ProviderError(
        `Gemini returned HTTP ${response.status}: ${body}`,
        isRetryableStatus(response.status),
        response.status,
      );
    }
    const parsed = ResponseSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new ProviderError("Gemini returned an unexpected response shape", true, 200);
    const candidate = parsed.data.candidates?.[0];
    // A safety block or an empty candidate is an answer, not an outage: empty text makes the juror retry, then abstain.
    const text = (candidate?.content?.parts ?? [])
      .filter((p) => p.thought !== true)
      .map((p) => p.text ?? "")
      .join("");
    return parsed.data.modelVersion === undefined
      ? { text }
      : { text, servedModel: parsed.data.modelVersion };
  }
}
