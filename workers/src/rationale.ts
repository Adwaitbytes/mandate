import type { Address, Hex } from "viem";
import { canonicalJson, type Json, keccakUtf8 } from "./canonical.ts";
import type { JudgeOutcome } from "./judge.ts";

export interface RationaleContext {
  caseId: bigint;
  originChainId: bigint;
  governor: Address;
  proposalId: bigint;
  mandateVersion: bigint;
  mandateHash: Hex;
  juror: Address;
  jurorId: number;
  model: string;
  modelIdHash: Hex;
  promptFile: string;
  promptHash: Hex;
  temperature: number | null;
  proposalTextHash: Hex;
  createdAt: string;
}

export interface PublishedRationale {
  document: Json;
  /** Canonical bytes, exactly what is published and hashed. */
  bytes: string;
  hash: Hex;
}

/** Builds the rationale document of docs/JUROR_INTERFACE.md and its canonical serialization and hash. */
export function buildRationale(ctx: RationaleContext, outcome: JudgeOutcome): PublishedRationale {
  const document: Json = {
    schema: "mandate.rationale.v1",
    caseId: ctx.caseId.toString(),
    originChainId: ctx.originChainId.toString(),
    governor: ctx.governor,
    proposalId: ctx.proposalId.toString(),
    mandateVersion: ctx.mandateVersion.toString(),
    mandateHash: ctx.mandateHash,
    juror: ctx.juror,
    jurorId: ctx.jurorId,
    model: ctx.model,
    modelIdHash: ctx.modelIdHash,
    servedModel: outcome.servedModel ?? null,
    promptFile: ctx.promptFile,
    promptHash: ctx.promptHash,
    temperature: ctx.temperature,
    proposalTextHash: ctx.proposalTextHash,
    support: outcome.supportCode,
    supportLabel: outcome.verdict.support,
    confidenceBps: outcome.confidenceBps,
    injectionFlag: outcome.injectionFlag,
    modelInjectionFlag: outcome.verdict.injection_attempt,
    heuristicInjectionFlag: outcome.heuristic.flagged,
    promptGuard:
      outcome.promptGuard === null
        ? null
        : {
            model: outcome.promptGuard.modelId,
            scoreBps: outcome.promptGuard.scoreBps,
            thresholdBps: outcome.promptGuard.thresholdBps,
            flagged: outcome.promptGuard.flagged,
          },
    injectionEvidence: outcome.injectionEvidence,
    rationale: outcome.verdict.rationale,
    citedMandateClauses: outcome.verdict.cited_mandate_clauses,
    validOutput: outcome.valid,
    attempts: outcome.attempts,
    repairAttempted: outcome.repairAttempted,
    parseErrors: outcome.parseErrors,
    providerFallbacks: outcome.passedOver,
    rawModelOutput: outcome.rawOutputs.at(-1) ?? "",
    createdAt: ctx.createdAt,
  };
  const bytes = canonicalJson(document);
  return { document, bytes, hash: keccakUtf8(bytes) };
}
