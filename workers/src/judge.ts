import type { Hex } from "viem";
import { detectInjection, type InjectionReport } from "./injection.ts";
import { type PromptTemplate, randomDelimiter, renderPrompt } from "./prompt.ts";
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
  /** Model flag OR heuristic flag. */
  injectionFlag: boolean;
  injectionEvidence: string;
  supportCode: SupportCode;
  confidenceBps: number;
  servedModel?: string;
}

export const MAX_ATTEMPTS = 2;

export const INVALID_OUTPUT_RATIONALE =
  "The model did not return a valid verdict in two attempts, so this juror abstains with confidence 0.";

/**
 * One juror inference: render the committed prompt with a fresh delimiter, call the provider, validate the
 * output, retry once on invalid output, then abstain at confidence 0. Provider outages (after the provider's
 * own retries) propagate so the caller can try the case again later instead of posting a non-answer.
 */
export async function judge(
  provider: Provider,
  template: PromptTemplate,
  input: JudgeInput,
  makeDelimiter: () => string = randomDelimiter,
): Promise<JudgeOutcome> {
  const heuristic = detectInjection(input.proposalText);
  const rawOutputs: string[] = [];
  const parseErrors: string[] = [];
  let verdict: ModelVerdict | undefined;
  let servedModel: string | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS && verdict === undefined; attempt++) {
    const prompt = renderPrompt(template, input, makeDelimiter);
    const result = await provider.complete({ system: prompt.system, user: prompt.user });
    servedModel = result.servedModel ?? servedModel;
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
  const injectionFlag = final.injection_attempt || heuristic.flagged;

  return {
    verdict: final,
    valid,
    attempts: rawOutputs.length,
    rawOutputs,
    parseErrors,
    heuristic,
    injectionFlag,
    injectionEvidence: describeEvidence(final.injection_attempt, heuristic),
    supportCode: SUPPORT_CODE[final.support],
    confidenceBps: final.confidence * 100,
    ...(servedModel === undefined ? {} : { servedModel }),
  };
}

function describeEvidence(modelFlag: boolean, heuristic: InjectionReport): string {
  const parts = heuristic.matches.map((m) => `heuristic ${m.rule}: "${m.excerpt}"`);
  if (modelFlag) parts.push("model reported an injection attempt (see rationale)");
  return parts.join(" | ");
}
