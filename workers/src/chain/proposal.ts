import { type Address, decodeEventLog, type Hex, isAddressEqual, type Log, type PublicClient } from "viem";
import type { ProposalData } from "../proposal.ts";
import { PROPOSAL_CREATED_TOPIC, proposalCreatedAbi } from "./abi.ts";

export interface ProposalLookup {
  governor: Address;
  proposalId: bigint;
  originTxHash: Hex;
}

export interface FetchedProposal {
  proposal: ProposalData;
  source: "receipt" | "logs";
  txHash: Hex;
  blockNumber: bigint;
}

export interface ProposalFetchOptions {
  /** Block window per eth_getLogs call in the fallback scan. */
  chunkBlocks?: bigint;
  /** How far back the fallback scan goes from the latest block. */
  maxLookbackBlocks?: bigint;
}

type MinimalLog = Pick<Log, "address" | "topics" | "data" | "transactionHash" | "blockNumber">;

export function decodeProposalCreated(log: MinimalLog): ProposalData {
  const decoded = decodeEventLog({
    abi: proposalCreatedAbi,
    data: log.data,
    topics: log.topics,
    strict: true,
  });
  const a = decoded.args;
  return {
    proposalId: a.proposalId,
    proposer: a.proposer,
    targets: a.targets,
    values: a.values,
    signatures: a.signatures,
    calldatas: a.calldatas,
    voteStart: a.voteStart,
    voteEnd: a.voteEnd,
    description: a.description,
  };
}

function matches(log: MinimalLog, lookup: ProposalLookup): boolean {
  if (!isAddressEqual(log.address, lookup.governor) || log.topics[0] !== PROPOSAL_CREATED_TOPIC) return false;
  try {
    return decodeProposalCreated(log).proposalId === lookup.proposalId;
  } catch {
    return false;
  }
}

/**
 * Loads the proposal text from the origin chain: the receipt of the origin transaction first, then a backwards
 * log scan over the governor (address plus topic0, since the event has no indexed fields).
 */
export async function fetchProposal(
  client: PublicClient,
  lookup: ProposalLookup,
  options: ProposalFetchOptions = {},
): Promise<FetchedProposal> {
  const receiptHit = await fromReceipt(client, lookup).catch(() => undefined);
  if (receiptHit !== undefined) return receiptHit;

  const chunk = options.chunkBlocks ?? 5_000n;
  const lookback = options.maxLookbackBlocks ?? 500_000n;
  const latest = await client.getBlockNumber();
  const floor = latest > lookback ? latest - lookback : 0n;
  for (let to = latest; to >= floor; ) {
    const from = to >= floor + chunk ? to - chunk + 1n : floor;
    const logs = await client.getLogs({
      address: lookup.governor,
      fromBlock: from,
      toBlock: to,
      // viem's typed filter needs an event; raw topics keep the filter to address plus topic0.
      topics: [PROPOSAL_CREATED_TOPIC],
    } as Parameters<PublicClient["getLogs"]>[0]);
    const hit = (logs as MinimalLog[]).find((l) => matches(l, lookup));
    if (hit?.transactionHash != null && hit.blockNumber != null) {
      return {
        proposal: decodeProposalCreated(hit),
        source: "logs",
        txHash: hit.transactionHash,
        blockNumber: hit.blockNumber,
      };
    }
    if (from === floor) break;
    to = from - 1n;
  }
  throw new Error(
    `ProposalCreated for proposal ${lookup.proposalId} not found on governor ${lookup.governor} (receipt and ${lookback} block scan)`,
  );
}

async function fromReceipt(
  client: PublicClient,
  lookup: ProposalLookup,
): Promise<FetchedProposal | undefined> {
  const receipt = await client.getTransactionReceipt({ hash: lookup.originTxHash });
  const hit = receipt.logs.find((l) => matches(l, lookup));
  if (hit === undefined) return undefined;
  return {
    proposal: decodeProposalCreated(hit),
    source: "receipt",
    txHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
  };
}
