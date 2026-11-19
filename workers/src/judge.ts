import type { Hex } from "viem";
import { detectInjection, type InjectionReport } from "./injection.ts";
import { type PromptTemplate, randomDelimiter, renderPrompt } from "./prompt.ts";
import type { InjectionClassifier } from "./promptguard.ts";
import type { Provider } from "./providers/types.ts";
import { type ModelVerdict, parseModelOutput, SUPPORT_CODE, type SupportCode } from "./schema.ts";

export interface JudgeInput {
  mandateText: string;
  mandateVersion: string;
  mandateHash: Hex;
  proposalText: string;
}

export interface JudgeOutcome {
  verdict: ModelVerdict;
  /** False when both attempts returned invalid output and the juror fell back to abstain at confidence 0. */
  valid: boolean;
  attempts: number;
  rawOutputs: string[];
  parseErrors: string[];
  heuristic: InjectionReport;
  /** Independent classifier result; null when none is configured or it was unavailable. */
  promptGuard: { modelId: string; scoreBps: number; thresholdBps: number; flagged: boolean } | null;
  /** Model flag OR heuristic flag OR classifier flag. */
  injectionFlag: boolean;
  injectionEvidence: string;
  supportCode: SupportCode;
  confidenceBps: number;
  servedModel?: string;
  /** `<provider>/<model>` that produced the final verdict (differs from the provider's own after a fallback). */
  modelId: string;
  temperature: number | null;
}

export const MAX_ATTEMPTS = 2;

export const INVALID_OUTPUT_RATIONALE =
  "The model did not return a valid verdict in two attempts, so this juror abstains with confidence 0.";

/**
 * One juror inference: render the committed prompt with a fresh delimiter, call the provider, validate the
 * output, retry once on invalid output, then abstain at confidence 0. Provider outages (after the provider's
 * own retries) propagate so the caller can try the case again later instead of posting a non-answer.
 */
export interface JudgeOptions {
  makeDelimiter?: () => string;
  classifier?: InjectionClassifier;
  /** Precomputed classifier result (the eval caches scores per proposal). */
  classifierResult?: { modelId: string; scoreBps: number } | null;
  log?: (message: string) => void;
}

export async function judge(
  provider: Provider,
  template: PromptTemplate,
  input: JudgeInput,
  options: JudgeOptions = {},
): Promise<JudgeOutcome> {
  const makeDelimiter = options.makeDelimiter ?? randomDelimiter;
  const heuristic = detectInjection(input.proposalText);
  const promptGuard = await classify(input.proposalText, options);
  const rawOutputs: string[] = [];
  const parseErrors: string[] = [];
  let verdict: ModelVerdict | undefined;
  let servedModel: string | undefined;
  let modelId = provider.modelId;
  let temperature = provider.temperature;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS && verdict === undefined; attempt++) {
    const prompt = renderPrompt(template, input, makeDelimiter);
    const result = await provider.complete({ system: prompt.system, user: prompt.user });
    servedModel = result.servedModel ?? servedModel;
    modelId = result.modelId ?? provider.modelId;
    temperature = result.temperature === undefined ? provider.temperature : result.temperature;
    rawOutputs.push(result.text);
    const parsed = parseModelOutput(result.text);
    if (parsed.ok) verdict = parsed.value;
    else parseErrors.push(parsed.error);
  }

  const valid = verdict !== undefined;
  const final: ModelVerdict = verdict ?? {
    support: "abstain",
    confidence: 0,
    injection_attempt: false,
    rationale: INVALID_OUTPUT_RATIONALE,
    cited_mandate_clauses: [],
  };
  const injectionFlag = final.injection_attempt || heuristic.flagged || promptGuard?.flagged === true;

  return {
    verdict: final,
    valid,
    attempts: rawOutputs.length,
    rawOutputs,
    parseErrors,
    heuristic,
    injectionFlag,
    promptGuard,
    injectionEvidence: describeEvidence(final.injection_attempt, heuristic, promptGuard),
    supportCode: SUPPORT_CODE[final.support],
    confidenceBps: final.confidence * 100,
    modelId,
    temperature,
    ...(servedModel === undefined ? {} : { servedModel }),
  };
}

async function classify(text: string, options: JudgeOptions): Promise<JudgeOutcome["promptGuard"]> {
  const classifier = options.classifier;
  if (options.classifierResult !== undefined) {
    const r = options.classifierResult;
    const threshold = classifier?.thresholdBps;
    return r === null || threshold === undefined
      ? null
      : { ...r, thresholdBps: threshold, flagged: r.scoreBps >= threshold };
  }
  if (classifier === undefined) return null;
  try {
    const r = await classifier.score(text);
    return {
      modelId: r.modelId,
      scoreBps: r.scoreBps,
      thresholdBps: classifier.thresholdBps,
      flagged: r.scoreBps >= classifier.thresholdBps,
    };
  } catch (err) {
    // The classifier is one of three independent signals; an outage leaves the other two, and is recorded as null.
    options.log?.(`prompt guard unavailable: ${(err as Error).message}`);
    return null;
  }
}

function describeEvidence(
  modelFlag: boolean,
  heuristic: InjectionReport,
  guard: JudgeOutcome["promptGuard"],
): string {
  const parts = heuristic.matches.map((m) => `heuristic ${m.rule}: "${m.excerpt}"`);
  if (guard?.flagged === true)
    parts.push(`prompt guard score ${guard.scoreBps} bps >= ${guard.thresholdBps}`);
  if (modelFlag) parts.push("model reported an injection attempt (see rationale)");
  return parts.join(" | ");
}
