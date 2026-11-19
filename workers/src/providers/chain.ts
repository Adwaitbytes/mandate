import { type BreakerOptions, CircuitBreaker } from "./breaker.ts";
import { type CompletionRequest, type CompletionResult, type Provider, ProviderError } from "./types.ts";

export interface ChainLink {
  /** Model id plus key slot, for example `google/gemini-flash-latest#2`. One breaker per label. */
  label: string;
  provider: Provider;
  breaker: CircuitBreaker;
}

export interface ChainOptions {
  /** Most time one link may take (its own retries included) before the chain moves on. */
  linkBudgetMs?: number;
  /** Most time one completion may take across all links; after it the case is left for the next pass. */
  totalBudgetMs?: number;
  breaker?: Partial<BreakerOptions>;
  now?: () => number;
  log?: (message: string) => void;
}

export const DEFAULT_LINK_BUDGET_MS = 75_000;
export const DEFAULT_TOTAL_BUDGET_MS = 150_000;
/** Providers honour the deadline themselves; the hard stop only catches one that does not. */
const HARD_STOP_GRACE_MS = 2_000;

/**
 * Ordered providers with a circuit breaker each and a time budget. A link whose breaker is open is skipped
 * without a call; a link that fails (any ProviderError) feeds its breaker and the next link is tried. The result
 * names the provider that answered, so the posted modelIdHash and the rationale record the model actually used,
 * and lists why earlier links were passed over. If no link answers in the budget the error is retryable: the
 * case stays unposted and the next pass tries again.
 */
export class ProviderChain implements Provider {
  readonly modelId: string;
  readonly temperature: number | null;
  readonly links: readonly ChainLink[];
  private readonly linkBudgetMs: number;
  private readonly totalBudgetMs: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(providers: ReadonlyArray<{ label: string; provider: Provider }>, options: ChainOptions = {}) {
    const first = providers[0];
    if (first === undefined) throw new ProviderError("A provider chain needs at least one provider", false);
    this.now = options.now ?? Date.now;
    this.links = providers.map((p) => ({
      ...p,
      breaker: new CircuitBreaker({ now: this.now, ...options.breaker }),
    }));
    this.modelId = first.provider.modelId;
    this.temperature = first.provider.temperature;
    this.linkBudgetMs = options.linkBudgetMs ?? DEFAULT_LINK_BUDGET_MS;
    this.totalBudgetMs = options.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS;
    this.log = options.log ?? (() => {});
  }

  get labels(): string[] {
    return this.links.map((l) => l.label);
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const start = this.now();
    const totalDeadline = Math.min(request.deadline ?? Number.POSITIVE_INFINITY, start + this.totalBudgetMs);
    const passedOver: string[] = [];

    for (const link of this.links) {
      if (!link.breaker.canCall()) {
        passedOver.push(
          `${link.label}: circuit open ${Math.ceil(link.breaker.remainingMs() / 1000)} s more (${link.breaker.reason})`,
        );
        continue;
      }
      const remaining = totalDeadline - this.now();
      if (remaining <= 0) {
        passedOver.push(`${link.label}: completion budget spent`);
        break;
      }
      const deadline = this.now() + Math.min(this.linkBudgetMs, remaining);
      try {
        const r = await withHardStop(
          link.provider.complete({ ...request, deadline }),
          deadline - this.now() + HARD_STOP_GRACE_MS,
          link.label,
        );
        link.breaker.onSuccess();
        if (passedOver.length > 0) this.log(`answered by ${link.label} after: ${passedOver.join("; ")}`);
        return {
          ...r,
          modelId: link.provider.modelId,
          temperature: link.provider.temperature,
          passedOver: passedOver.map((p) => p.slice(0, 240)),
        };
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        const kind = link.breaker.onFailure(err);
        const open = link.breaker.canCall()
          ? ""
          : `, circuit open for ${Math.ceil(link.breaker.remainingMs() / 1000)} s`;
        const message = compact(err.message);
        passedOver.push(`${link.label}: ${kind} failure: ${message.slice(0, 160)}`);
        this.log(`${link.label} failed (${kind}${open}): ${message.slice(0, 240)}`);
      }
    }
    throw new ProviderError(`No provider answered: ${passedOver.join(" | ")}`, true);
  }
}

/** Provider error bodies are pretty-printed JSON; one line reads better in a log and a rationale. */
function compact(message: string): string {
  return message.replace(/\s+/g, " ").trim();
}

function withHardStop<T>(work: Promise<T>, afterMs: number, label: string): Promise<T> {
  // The losing promise keeps running; swallow its eventual rejection so it cannot surface as unhandled.
  work.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ProviderError(`${label}: no answer within its time budget`, true)),
      Math.max(0, afterMs),
    );
  });
  return Promise.race([work, stop]).finally(() => clearTimeout(timer));
}
