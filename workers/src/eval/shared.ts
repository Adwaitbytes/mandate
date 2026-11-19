import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Hex } from "viem";
import { keccakUtf8 } from "../canonical.ts";
import { optionalEnv, REPO_DIR } from "../config.ts";
import type { JudgeOutcome } from "../judge.ts";
import { type ProposalData, renderProposal } from "../proposal.ts";
import { ANTHROPIC_MODEL } from "../providers/anthropic.ts";
import { OLLAMA_MODEL } from "../providers/ollama.ts";
import { POLLINATIONS_MODEL } from "../providers/pollinations.ts";
import type { EvalDataset, EvalProposal } from "./types.ts";

export const EVAL_DIR = join(REPO_DIR, "analysis", "eval");
export const MANDATES = ["conservative-treasury.v1.md", "growth.v1.md"] as const;
export type MandateFile = (typeof MANDATES)[number];

export interface CachedVerdict {
  key: Hex;
  jurorId: number;
  modelId: string;
  promptHash: Hex;
  mandate: MandateFile;
  mandateHash: Hex;
  dao: string;
  proposalId: string;
  proposalTextHash: Hex;
  createdAt: string;
  outcome: JudgeOutcome;
}

export async function loadDataset(): Promise<EvalDataset> {
  return JSON.parse(await readFile(join(EVAL_DIR, "data", "proposals.json"), "utf8")) as EvalDataset;
}

export async function loadMandate(file: MandateFile): Promise<{ text: string; hash: Hex }> {
  const text = await readFile(join(REPO_DIR, "mandates", file), "utf8");
  return { text, hash: keccakUtf8(text) };
}

export function proposalText(p: EvalProposal): string {
  const data: ProposalData = {
    proposalId: BigInt(p.proposalId),
    proposer: p.proposer,
    targets: p.targets,
    values: p.values.map(BigInt),
    signatures: p.signatures,
    calldatas: p.calldatas,
    voteStart: BigInt(p.voteStart),
    voteEnd: BigInt(p.voteEnd),
    description: p.description,
  };
  return renderProposal(data);
}

/** Cache key: the inputs that determine a verdict, excluding the per-call random delimiter. */
export function cacheKey(modelId: string, promptHash: Hex, mandateHash: Hex, textHash: Hex): Hex {
  return keccakUtf8([modelId, promptHash, mandateHash, textHash].join("|"));
}

export function cachePath(jurorId: number, key: Hex): string {
  return join(EVAL_DIR, "cache", `juror-${jurorId}`, `${key.slice(2, 18)}.json`);
}

export async function readCached(jurorId: number, key: Hex): Promise<CachedVerdict | undefined> {
  try {
    const cached = JSON.parse(await readFile(cachePath(jurorId, key), "utf8")) as CachedVerdict;
    return cached.key === key ? cached : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** The model each juror runs with the current env, which selects that juror's rows from the cache. */
export function expectedModelId(jurorId: number): string {
  if (jurorId === 1) return `anthropic/${optionalEnv("ANTHROPIC_MODEL") ?? ANTHROPIC_MODEL}`;
  if (jurorId === 2) return `pollinations/${optionalEnv("POLLINATIONS_MODEL") ?? POLLINATIONS_MODEL}`;
  return `ollama/${optionalEnv("OLLAMA_MODEL") ?? OLLAMA_MODEL}`;
}
