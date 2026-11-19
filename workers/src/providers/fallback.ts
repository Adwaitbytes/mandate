import type { CompletionRequest, CompletionResult, Provider } from "./types.ts";
import { ProviderError } from "./types.ts";

/**
 * Tries the primary provider and, if it is unavailable after its own retries, the fallback. The result names
 * the provider that answered, so the posted modelIdHash and the rationale record the model actually used.
 */
export class FallbackProvider implements Provider {
  readonly modelId: string;
  readonly temperature: number | null;

  constructor(
    readonly primary: Provider,
    readonly fallback: Provider,
    private readonly onFallback: (reason: string) => void = () => {},
  ) {
    this.modelId = primary.modelId;
    this.temperature = primary.temperature;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    try {
      const r = await this.primary.complete(request);
      return { ...r, modelId: this.primary.modelId, temperature: this.primary.temperature };
    } catch (err) {
      if (!(err instanceof ProviderError) || !err.retryable) throw err;
      this.onFallback(err.message);
      const r = await this.fallback.complete(request);
      return { ...r, modelId: this.fallback.modelId, temperature: this.fallback.temperature };
    }
  }
}
