import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ProposalData, renderProposal } from "../proposal.ts";
import { EVAL_DIR } from "./shared.ts";

export interface InjectionSample {
  id: string;
  description: string;
}

export async function loadInjectionSamples(): Promise<InjectionSample[]> {
  const raw = JSON.parse(await readFile(join(EVAL_DIR, "data", "injection-samples.json"), "utf8")) as {
    samples: InjectionSample[];
  };
  return raw.samples;
}

/** Renders a sample like a live proposal: one zero-value action, so the text shape matches the real cases. */
export function injectionText(sample: InjectionSample, index: number): string {
  const data: ProposalData = {
    proposalId: BigInt(index + 1),
    proposer: "0x000000000000000000000000000000000000dEaD",
    targets: ["0x000000000000000000000000000000000000bEEF"],
    values: [0n],
    signatures: [""],
    calldatas: ["0x"],
    voteStart: 0n,
    voteEnd: 0n,
    description: sample.description,
  };
  return renderProposal(data);
}
