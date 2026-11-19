import type { Address } from "viem";

export type GovernorClock = "timestamp" | "blocknumber";

export interface ContractDeployment {
  chainId: number;
  address: Address | null;
  /** First block worth scanning for this contract's logs; null until a broadcast file records it. */
  startBlock: number | null;
}

export interface GovernorDeployment {
  chainId: number;
  clock: GovernorClock;
  governor: Address | null;
  token: Address | null;
  delegate: Address | null;
  startBlock: number | null;
}

export interface Deployments {
  reactive: ContractDeployment;
  docket: ContractDeployment;
  governors: GovernorDeployment[];
  /** Mainnet radar (wildcard ProposalCreated subscription). Not built; stays null until it exists. */
  radar: ContractDeployment | null;
}
