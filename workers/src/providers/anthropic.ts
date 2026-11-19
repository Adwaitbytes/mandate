import Anthropic from "@anthropic-ai/sdk";
import { VERDICT_JSON_SCHEMA } from "../schema.ts";
import {
  type CompletionRequest,
  type CompletionResult,
  type FetchLike,
  type Provider,
  ProviderError,
  timeoutSignal,
} from "./types.ts";

/**
 * Claude Haiku 5.5: the cheapest current Claude model ($0.10 / $0.50 per million tokens for prompts up to 100K),
 * a twentieth of Sonnet 5.5's price, and a single-label classification against a written policy is squarely
 * Haiku-tier work. See docs/DECISIONS.md.
 */
export const ANTHROPIC_MODEL = "claude-haiku-5-5";

export interface AnthropicOptions {
  /** API keys in fallback order. The next key is tried after a 401 or a 429 that outlived the SDK's retries. */
  apiKeys: readonly string[];
  model?: string;
  fetch?: FetchLike;
  maxRetries?: number;
  maxTokens?: number;
}

/**
 * Claude through the official SDK. Temperature is not sent: current Claude models reject non-default sampling
 * parameters, so determinism comes from disabled thinking, low effort and schema-constrained output instead.
 */
export class AnthropicProvider implements Provider {
  readonly modelId: string;
  readonly temperature = null;
  private readonly model: string;
  private readonly clients: Anthropic[];
  private readonly maxTokens: number;

  constructor(options: AnthropicOptions) {
    const keys = options.apiKeys.filter((k) => k.trim() !== "");
    if (keys.length === 0)
      throw new ProviderError("No Anthropic API key configured (ANTHROPIC_API_KEY)", false);
    this.model = options.model ?? ANTHROPIC_MODEL;
    this.modelId = `anthropic/${this.model}`;
    this.maxTokens = options.maxTokens ?? 2_048;
    this.clients = keys.map(
      (apiKey) =>
        new Anthropic({
          apiKey,
          maxRetries: options.maxRetries ?? 3,
          timeout: 120_000,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        }),
    );
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    let lastError: unknown;
    for (const [index, client] of this.clients.entries()) {
      try {
        return await this.once(client, request);
      } catch (err) {
        lastError = err;
        const canFallBack =
          err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.RateLimitError;
        if (!canFallBack || index === this.clients.length - 1) break;
      }
    }
    throw toProviderError(lastError);
  }

  private async once(client: Anthropic, request: CompletionRequest): Promise<CompletionResult> {
    const message = await client.messages.create(
      {
        model: this.model,
        max_tokens: this.maxTokens,
        system: request.system,
        messages: [{ role: "user", content: request.user }],
        thinking: { type: "disabled" },
        output_config: { effort: "low", format: { type: "json_schema", schema: { ...VERDICT_JSON_SCHEMA } } },
      },
      // The SDK's own retries run inside this signal, so the whole call ends by the chain's deadline.
      request.deadline === undefined ? undefined : { signal: timeoutSignal(120_000, request.deadline) },
    );
    if (message.stop_reason === "refusal") {
      // A refusal is an answer, not an outage: hand back empty text so the juror treats it as invalid output.
      return { text: "", servedModel: message.model };
    }
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    return { text, servedModel: message.model };
  }
}

function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.APIConnectionError)
    return new ProviderError(`Anthropic connection: ${err.message}`, true);
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    const retryable = status === undefined || status === 429 || status >= 500;
    return new ProviderError(`Anthropic API ${status ?? "?"}: ${err.message}`, retryable, status);
  }
  return new ProviderError(`Anthropic call failed: ${(err as Error).message}`, false);
}
