/**
 * Event ABIs written out by hand from contracts/src, so verification does not depend on a local forge build and a
 * changed event in the source shows up as a decoding failure here.
 */
import { type Abi, decodeEventLog, type Hex, parseAbi } from "viem";
import type { RpcLog } from "./rpc.ts";

export const reactiveAbi = parseAbi([
  "event CaseCreated(uint256 indexed caseId, uint256 indexed originChainId, address indexed governor, uint256 proposalId, uint64 voteStart, uint64 voteEnd, uint256 originTxHash)",
  "event CaseStatusChanged(uint256 indexed caseId, uint8 status)",
  "event OpenCaseRequested(uint256 indexed caseId, uint32 seq, uint8 attempt)",
  "event BallotRecorded(uint256 indexed caseId, address indexed juror, uint8 support, uint16 confidenceBps, bool injection, uint32 weight)",
  "event TallyUpdated(uint256 indexed caseId, uint256 againstWeight, uint256 forWeight, uint256 abstainWeight, uint256 lowConfidenceWeight, uint256 ballots)",
  "event CaseHeld(uint256 indexed caseId, uint8 reason)",
  "event WindowStarted(uint256 indexed caseId, uint8 support, uint64 endsAt)",
  "event DecisionChanged(uint256 indexed caseId, uint8 support)",
  "event CastDeferred(uint256 indexed caseId, uint64 until)",
  "event CastRequested(uint256 indexed caseId, uint32 seq, uint8 support, uint8 attempt)",
  "event CastAcknowledged(uint256 indexed caseId, uint256 seq, uint8 support, uint256 weight)",
  "event CastRefused(uint256 indexed caseId, uint256 seq, uint8 reason)",
  "event CancelRequested(uint256 indexed caseId, uint32 seq, uint8 attempt)",
  "event CancelAcknowledged(uint256 indexed caseId, uint256 seq)",
  "event CancelAbandoned(uint256 indexed caseId, uint32 seq)",
  "event OwnerActionTooLate(uint256 indexed caseId, bool veto)",
  "event WeightsUpdated(uint256 indexed caseId, address[] jurors, uint32[] weights)",
  "event ProposalSkipped(uint256 indexed chainId, address indexed governor, uint256 proposalId, uint8 reason)",
  "event CronToggled(bool active)",
]);

export const docketAbi = parseAbi([
  "event CaseOpened(uint256 indexed caseId, uint256 originChainId, address governor, uint256 proposalId, uint256 voteStart, uint256 voteEnd, bytes32 originTxHash, address delegate, uint256 mandateVersion, bytes32 mandateHash)",
  "event Verdict(uint256 indexed caseId, address indexed juror, uint8 support, uint16 confidenceBps, bool injectionFlag, bytes32 rationaleHash, bytes32 modelIdHash, bytes32 promptHash)",
  "event Vetoed(uint256 indexed caseId)",
  "event Overridden(uint256 indexed caseId, uint8 support)",
  "event MandateSet(uint256 indexed version, bytes32 mandateHash, string uri)",
]);

export const delegateAbi = parseAbi([
  "event Cast(uint256 indexed caseId, address indexed governor, uint256 indexed proposalId, uint256 seq, uint8 support, uint256 weight)",
  "event NotActive(uint256 indexed caseId, uint256 seq, uint8 reason, uint8 proposalState)",
  "event Cancelled(uint256 indexed caseId, uint256 seq)",
]);

export const proposalCreatedAbi = parseAbi([
  "event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 voteStart, uint256 voteEnd, string description)",
]);

export const fundsAbi = parseAbi([
  "function reserves(address) view returns (uint256)",
  "function debt(address) view returns (uint256)",
]);

export const SUPPORT = ["against", "for", "abstain"] as const;
/** MandateReactive.Status */
export const STATUS = [
  "None",
  "Opening",
  "Open",
  "Held",
  "Window",
  "Waiting",
  "Casting",
  "Cast",
  "Vetoed",
  "Expired",
  "Failed",
] as const;
/** MandateReactive.HoldReason */
export const HOLD_REASON = ["None", "Injection", "Split"] as const;
/** MandateReactive.SkipReason */
export const SKIP_REASON = [
  "Malformed",
  "Duplicate",
  "NoDelegate",
  "NoDocket",
  "Capacity",
  "GovernorCapacity",
  "RateLimited",
] as const;
/** IDelegate.Refusal */
export const REFUSAL = [
  "None",
  "NotYetActive",
  "Ended",
  "Paused",
  "CastReverted",
  "StateUnavailable",
  "InvalidSupport",
  "Superseded",
] as const;

export interface Decoded {
  name: string;
  args: Record<string, unknown>;
  tx: Hex;
  block: bigint;
  logIndex: number;
}

/** Decodes the logs this ABI knows; anything else at the address is counted, not silently merged. */
export function decodeAll(abi: Abi, raw: RpcLog[]): { decoded: Decoded[]; unknown: number } {
  const decoded: Decoded[] = [];
  let unknown = 0;
  for (const l of raw) {
    try {
      const d = decodeEventLog({ abi, data: l.data, topics: l.topics as [Hex, ...Hex[]], strict: true });
      decoded.push({
        name: String(d.eventName),
        args: (d.args ?? {}) as Record<string, unknown>,
        tx: l.transactionHash,
        block: BigInt(l.blockNumber),
        logIndex: Number(BigInt(l.logIndex)),
      });
    } catch {
      unknown++;
    }
  }
  return { decoded, unknown };
}

export const caseIdOf = (d: Decoded): string | undefined => (d.args.caseId as bigint | undefined)?.toString();
