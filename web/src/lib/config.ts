import type { Address, Hex } from "viem";
import { deployments as generated } from "@/generated/deployments";
import { workerFacts } from "@/generated/workers";
import type { Deployments, GovernorDeployment } from "./deployments-schema";

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
  /** Exact `<provider>/<model>` string the worker calls; keccak256 of it is the on-chain modelIdHash. */
  model: string;
  name: string;
  provenance: string;
  short: string;
}

/** Addresses from docs/JURORS.md; model strings generated from workers/src/providers. */
export const jurors: readonly Juror[] = [
  {
    id: 1,
    address: "0x1e1005C3Ac959A66e8cE5423382fC7a28a24839F",
    model: workerFacts.models.anthropic,
    name: "Claude Haiku 5.5",
    provenance: "Anthropic API",
    short: "Claude",
  },
  {
    id: 2,
    address: "0xEa5C14faC05Aa8a4C9a3A4184aE6E17E65402f54",
    model: workerFacts.models.pollinations,
    name: "gpt-oss-20b",
    provenance: "OpenAI open weights, served by Pollinations",
    short: "gpt-oss-20b",
  },
  {
    id: 3,
    address: "0x1e0702541FC8cd645Bf955fA5c26e4DfC0eF9fc7",
    model: workerFacts.models.ollama,
    name: "Qwen 2.5 3B Instruct",
    provenance: "Alibaba open weights, self-hosted on Ollama",
    short: "Qwen",
  },
];

export function jurorByAddress(address: string): Juror | undefined {
  const lower = address.toLowerCase();
  return jurors.find((j) => j.address.toLowerCase() === lower);
}

export const promptFile = workerFacts.promptFile;
export const promptHash = workerFacts.promptHash as Hex;
export const draftMandate = workerFacts.draftMandate;

/**
 * A veto sent in the last seconds reaches Lasna after Base inclusion plus Reactive delivery, so the cast may
 * already be out (docs/LIMITS.md, L-1). The button stops this many seconds before the window closes. 30 s is
 * the design margin until the live loop measures it.
 */
export const VETO_CUTOFF_SECONDS = 30;

/** Public base of the jurors' evidence directory. Empty until the repository is published. */
export const rationaleBaseUrl = (process.env.NEXT_PUBLIC_RATIONALE_BASE_URL ?? "").replace(/\/+$/, "");

export const docketReady = deployments.docket.address !== null;
export const reactiveReady = deployments.reactive.address !== null;

export function readyGovernors(): (GovernorDeployment & { governor: Address })[] {
  return deployments.governors.filter(
    (g): g is GovernorDeployment & { governor: Address } => g.governor !== null,
  );
}

export function governorFor(chainId: number, address: string): GovernorDeployment | undefined {
  const lower = address.toLowerCase();
  return deployments.governors.find((g) => g.chainId === chainId && g.governor?.toLowerCase() === lower);
}
