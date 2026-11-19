import type { Address, Hex } from "viem";
import { deployments as generated } from "@/generated/deployments";
import { workerFacts } from "@/generated/workers";
import type { Deployments, GovernorDeployment } from "./deployments-schema";
import { type JurorModels, modelName } from "./models";

/**
 * Deployments come from the generated file. In development only, an end-to-end harness may point the site at a
 * local mock chain with NEXT_PUBLIC_E2E_DEPLOYMENTS; a production build ignores it, so a deployed site can only
 * ever show the addresses committed in src/generated/deployments.ts.
 */
function loadDeployments(): Deployments {
  const override = process.env.NEXT_PUBLIC_E2E_DEPLOYMENTS;
  if (process.env.NODE_ENV !== "production" && override) return JSON.parse(override) as Deployments;
  return generated;
}

export const deployments = loadDeployments();

export interface Juror {
  /** 1-based id used in rationale paths: evidence/rationales/<caseId>/juror-<id>.json */
  id: number;
  address: Address;
  /** The juror's provider chain and the models it answered with in the live run, generated from workers/. */
  models: JurorModels;
  /** The primary model's name, used where no verdict says which model answered. */
  name: string;
  provenance: string;
  short: string;
}

const JUROR_ADDRESSES: Record<1 | 2 | 3, Address> = {
  1: "0x1e1005C3Ac959A66e8cE5423382fC7a28a24839F",
  2: "0xEa5C14faC05Aa8a4C9a3A4184aE6E17E65402f54",
  3: "0x1e0702541FC8cd645Bf955fA5c26e4DfC0eF9fc7",
};

/** Addresses from docs/JURORS.md; models generated from workers/src/providers and evidence/cases.csv. */
export const jurors: readonly Juror[] = ([1, 2, 3] as const).map((id) => {
  const models = workerFacts.jurorModels[id];
  const primary = modelName(models.chain[0] ?? "");
  return {
    id,
    address: JUROR_ADDRESSES[id],
    models,
    name: primary.name,
    provenance: primary.provenance,
    short: primary.short,
  };
});

/** Every model a juror can answer with, primary first: "gpt-oss-120b, then gpt-oss-20b". */
export function jurorRoster(j: Juror): string {
  const ids = [...j.models.chain, ...j.models.live.filter((m) => !j.models.chain.includes(m))];
  const names = [...new Set(ids.map((m) => modelName(m).name))];
  return names.length === 1
    ? (names[0] ?? j.name)
    : `${names[0]}, falling back to ${names.slice(1).join(" or ")}`;
}

export function jurorByAddress(address: string): Juror | undefined {
  const lower = address.toLowerCase();
  return jurors.find((j) => j.address.toLowerCase() === lower);
}

export const promptFile = workerFacts.promptFile;
export const promptHash = workerFacts.promptHash as Hex;
export const draftMandate = workerFacts.draftMandate;

/**
 * A veto counts only if it reaches Lasna before the cron tick that requests the cast (docs/LIMITS.md, L-1). In the
 * live run (docs/FIRST_CASES.md) that tick came 3 to 62 s after the window's end, and the cast landed 5.6 to 65 s
 * after it; a veto took 1 to 2 s from Base inclusion to Lasna. The earliest tick leaves almost no slack after the
 * end, so the stub stops 20 s before it: about 2 s of delivery plus time for a wallet prompt and a slow block.
 */
export const VETO_CUTOFF_SECONDS = 20;

/** Window end to cast in the live run, for copy: the first cron tick after the end decides when the vote goes. */
export const MEASURED_CAST_AFTER_WINDOW = { minSeconds: 5.6, maxSeconds: 65, cases: 5 } as const;

/** Public base of the jurors' evidence directory. Empty until the repository is published. */
export const rationaleBaseUrl = (process.env.NEXT_PUBLIC_RATIONALE_BASE_URL ?? "").replace(/\/+$/, "");

export const docketReady = deployments.docket.address !== null;
export const reactiveReady = deployments.reactive.address !== null;

export function readyGovernors(): (GovernorDeployment & { governor: Address })[] {
  return deployments.governors.filter(
    (g): g is GovernorDeployment & { governor: Address } => g.governor !== null && g.role === "main",
  );
}

export function governorFor(chainId: number, address: string): GovernorDeployment | undefined {
  const lower = address.toLowerCase();
  return deployments.governors.find((g) => g.chainId === chainId && g.governor?.toLowerCase() === lower);
}
