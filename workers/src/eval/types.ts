import type { Address, Hex } from "viem";

export type Outcome = "passed" | "failed";
export type Stratum = "recent" | "defeated-oversample";
export type VoteLabel = "for" | "against" | "abstain";

export interface DaoSpec {
  key: string;
  name: string;
  governor: Address;
  kind: "bravo" | "oz";
}

/** One real proposal with its final outcome and the named delegate's vote, as stored in data/proposals.json. */
export interface EvalProposal {
  dao: string;
  stratum: Stratum;
  governor: Address;
  proposalId: string;
  proposer: Address;
  createdBlock: string;
  txHash: Hex;
  voteStart: string;
  voteEnd: string;
  description: string;
  targets: Address[];
  values: string[];
  signatures: string[];
  calldatas: Hex[];
  /** Governor state at fetch time, by name. */
  state: string;
  outcome: Outcome;
  votes: { for: string; against: string; abstain: string };
  delegate: { address: Address; name: string; vote: VoteLabel | null };
}

export interface EvalDataset {
  fetchedAt: string;
  rpc: string;
  sample: string;
  daos: Array<DaoSpec & { delegate: { address: Address; name: string; participation: string } }>;
  proposals: EvalProposal[];
}
