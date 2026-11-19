import type { Hex } from "viem";
import { detectInjection, type InjectionReport } from "./injection.ts";
import { type PromptTemplate, randomDelimiter, renderPrompt } from "./prompt.ts";
import type { InjectionClassifier } from "./promptguard.ts";
import type { Provider } from "./providers/types.ts";
import {
  MAX_RATIONALE_CHARS,
  type ModelVerdict,
  parseModelOutput,
  SUPPORT_CODE,
  type SupportCode,
} from "./schema.ts";

export interface JudgeInput {
  mandateText: string;
  mandateVersion: string;
  mandateHash: Hex;
  proposalText: string;
}

export interface JudgeOutcome {
  verdict: ModelVerdict;
  /** False when the answer and its repair were both invalid and the juror fell back to abstain at confidence 0. */
  valid: boolean;
  attempts: number;
  /** True when the first answer was invalid and the model was re-asked with the validation error. */
  repairAttempted: boolean;
  rawOutputs: string[];
  parseErrors: string[];
  /** Provider-chain links passed over before the answer that counted, each with its reason. */
  passedOver: string[];
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

/** One answer plus at most one repair. */
export const MAX_ATTEMPTS = 2;

const MAX_ERROR_IN_PROMPT = 300;

/**
 * Appended after the committed prompt (outside the delimited proposal) when the first answer is invalid. The error
 * is the validator's own message, so the only new text the model sees is ours; it is recorded in the rationale.
 */
export function repairInstruction(error: string): string {
  return [
    "",
    "",
    `Your previous reply could not be used: ${error.slice(0, MAX_ERROR_IN_PROMPT)}.`,
    `Reply again with exactly one JSON object with the keys support, confidence, injection_attempt, rationale and cited_mandate_clauses, as specified above, and nothing else. Keep the rationale under ${MAX_RATIONALE_CHARS} characters.`,
  ].join("\n");
}

export function invalidOutputRationale(lastError: string): string {
  return `The model did not return a valid verdict, even after one repair attempt (last error: ${lastError.slice(0, MAX_ERROR_IN_PROMPT)}), so this juror abstains with confidence 0.`;
}

/**
 * One juror inference: render the committed prompt with a fresh delimiter, call the provider, validate the
 * output; on invalid output re-ask once with the validation error appended (the repair), then abstain at
 * confidence 0 with the reason in the rationale. Provider outages (after the chain's fallbacks) propagate so the
 * caller can try the case again later instead of posting a non-answer.
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

  let passedOver: string[] = [];
  const prompt = renderPrompt(template, input, makeDelimiter);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS && verdict === undefined; attempt++) {
    const lastError = parseErrors.at(-1);
    const user = lastError === undefined ? prompt.user : prompt.user + repairInstruction(lastError);
    if (lastError !== undefined)
      options.log?.(`invalid output, asking for a repair: ${lastError.slice(0, 200)}`);
    const result = await provider.complete({ system: prompt.system, user });
    servedModel = result.servedModel ?? servedModel;
    modelId = result.modelId ?? provider.modelId;
    temperature = result.temperature === undefined ? provider.temperature : result.temperature;
    passedOver = [...passedOver, ...(result.passedOver ?? [])];
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
    rationale: invalidOutputRationale(parseErrors.at(-1) ?? "no output"),
    cited_mandate_clauses: [],
  };
  const injectionFlag = final.injection_attempt || heuristic.flagged || promptGuard?.flagged === true;

  return {
    verdict: final,
    valid,
    attempts: rawOutputs.length,
    repairAttempted: rawOutputs.length > 1,
    rawOutputs,
    parseErrors,
    passedOver,
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
