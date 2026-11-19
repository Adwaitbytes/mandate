import { optionalEnv } from "./config.ts";
import { GroqProvider } from "./providers/groq.ts";
import { type FetchLike, ProviderError } from "./providers/types.ts";

export const PROMPT_GUARD_MODEL = "meta-llama/llama-prompt-guard-2-86m";

/**
 * Score at or above which Prompt Guard alone flags a proposal, in basis points of its jailbreak probability.
 * Calibrated on the 72 real eval proposals against 16 synthetic injection samples
 * (analysis/eval/data/promptguard-calibration.json); see docs/DECISIONS.md.
 */
export const PROMPT_GUARD_THRESHOLD_BPS = 9000;

/** Prompt Guard 2 reads 512 tokens; windows stay well under that even for hex-heavy text. */
const WINDOW_CHARS = 1_200;
const STEP_CHARS = 1_000;
const MAX_WINDOWS = 16;

export interface ClassifierResult {
  modelId: string;
  /** Highest window score, 0 to 10000. */
  scoreBps: number;
  windows: number;
}

export interface InjectionClassifier {
  readonly modelId: string;
  readonly thresholdBps: number;
  score(text: string): Promise<ClassifierResult>;
}

/** Overlapping windows, so an instruction split across a boundary is still seen whole in one window. */
export function windows(text: string): string[] {
  const out: string[] = [];
  for (let start = 0; start < text.length && out.length < MAX_WINDOWS; start += STEP_CHARS) {
    out.push(text.slice(start, start + WINDOW_CHARS));
    if (start + WINDOW_CHARS >= text.length) break;
  }
  return out.length === 0 ? [""] : out;
}

/** Llama Prompt Guard 2 (86M) on Groq, an injection classifier independent of the juror models. */
export class PromptGuard implements InjectionClassifier {
  readonly modelId: string;
  private readonly provider: GroqProvider;

  constructor(
    apiKey: string,
    readonly thresholdBps: number = PROMPT_GUARD_THRESHOLD_BPS,
    options: { model?: string; fetch?: FetchLike; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    const model = options.model ?? PROMPT_GUARD_MODEL;
    this.modelId = `groq/${model}`;
    this.provider = new GroqProvider({
      apiKey,
      model,
      jsonMode: false,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.sleep === undefined ? {} : { backoff: { sleep: options.sleep } }),
    });
  }

  async score(text: string): Promise<ClassifierResult> {
    let max = 0;
    const parts = windows(text);
    for (const part of parts) {
      const { text: raw } = await this.provider.complete({ system: "", user: part });
      const p = Number(raw.trim());
      if (!Number.isFinite(p) || p < 0 || p > 1)
        throw new ProviderError(`Prompt Guard returned a non-score: ${raw.slice(0, 40)}`, true);
      max = Math.max(max, Math.round(p * 10_000));
    }
    return { modelId: this.modelId, scoreBps: max, windows: parts.length };
  }
}

/** Prompt Guard from env, or undefined when GROQ_API_KEY is absent or PROMPT_GUARD=off. */
export function promptGuardFromEnv(): PromptGuard | undefined {
  const key = optionalEnv("GROQ_API_KEY");
  if (key === undefined || optionalEnv("PROMPT_GUARD") === "off") return undefined;
  const threshold = optionalEnv("PROMPT_GUARD_THRESHOLD_BPS");
  return new PromptGuard(key, threshold === undefined ? PROMPT_GUARD_THRESHOLD_BPS : Number(threshold));
}
