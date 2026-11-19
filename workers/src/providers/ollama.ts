import { z } from "zod";
import { VERDICT_JSON_SCHEMA } from "../schema.ts";
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

export const OLLAMA_URL = "http://localhost:11434";
/** Pinned tag. Qwen 2.5 3B instruct follows a JSON schema reliably under Ollama's constrained decoding. */
export const OLLAMA_MODEL = "qwen2.5:3b-instruct";

const ResponseSchema = z.object({
  model: z.string().optional(),
  message: z.object({ content: z.string() }),
});

export interface OllamaOptions {
  baseUrl?: string;
  model?: string;
  fetch?: FetchLike;
  backoff?: Partial<BackoffOptions>;
  timeoutMs?: number;
  numCtx?: number;
}

/** Local Qwen through Ollama's /api/chat, with the verdict JSON Schema as the constrained output format. */
export class OllamaProvider implements Provider {
  readonly modelId: string;
  readonly temperature = 0;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: FetchLike;
  private readonly backoff: BackoffOptions;
  private readonly timeoutMs: number;
  private readonly numCtx: number;

  constructor(options: OllamaOptions = {}) {
    this.baseUrl = (options.baseUrl ?? OLLAMA_URL).replace(/\/+$/, "");
    this.model = options.model ?? OLLAMA_MODEL;
    this.modelId = `ollama/${this.model}`;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 600_000;
    this.numCtx = options.numCtx ?? 12_288;
    this.backoff = {
      retries: 2,
      baseDelayMs: 2_000,
      maxDelayMs: 20_000,
      sleep: realSleep,
      ...options.backoff,
    };
  }

  complete(request: CompletionRequest): Promise<CompletionResult> {
    return withBackoff(() => this.once(request), this.backoff, undefined, request.deadline);
  }

  private async once(request: CompletionRequest): Promise<CompletionResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          // Qwen 3.x reasons before answering by default; one schema-constrained answer is the whole job.
          think: false,
          format: VERDICT_JSON_SCHEMA,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
          options: { temperature: this.temperature, seed: 0, num_ctx: this.numCtx },
        }),
        signal: timeoutSignal(this.timeoutMs, request.deadline),
      });
    } catch (err) {
      throw new ProviderError(
        `Ollama request failed (is ollama serve running?): ${(err as Error).message}`,
        true,
      );
    }
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 300);
      throw new ProviderError(
        `Ollama returned HTTP ${response.status}: ${body}`,
        isRetryableStatus(response.status),
        response.status,
      );
    }
    const parsed = ResponseSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new ProviderError("Ollama returned an unexpected response shape", true);
    const { content } = parsed.data.message;
    return parsed.data.model === undefined
      ? { text: content }
      : { text: content, servedModel: parsed.data.model };
  }
}
