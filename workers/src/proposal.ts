import type { Address, Hex } from "viem";

/** A governor proposal as decoded from `ProposalCreated` (OpenZeppelin Governor and Governor Bravo). */
export interface ProposalData {
  proposalId: bigint;
  proposer: Address;
  targets: readonly Address[];
  values: readonly bigint[];
  signatures: readonly string[];
  calldatas: readonly Hex[];
  voteStart: bigint;
  voteEnd: bigint;
  description: string;
}

/** Upper bound on proposal characters handed to a model. The same cap applies to every juror and the eval. */
export const MAX_PROPOSAL_CHARS = 12_000;
const MAX_CALLDATA_HEX_CHARS = 202;

/**
 * Renders a proposal for the model: the description first, then each on-chain action. Calldata is shown as hex
 * (truncated), because the juror has no ABI for arbitrary targets; the description is what claims to explain it.
 */
export function renderProposal(p: ProposalData): string {
  const lines: string[] = [];
  lines.push(`Proposal id: ${p.proposalId.toString()}`);
  lines.push(`Proposer: ${p.proposer}`);
  lines.push("");
  lines.push("Description:");
  lines.push(p.description);
  lines.push("");
  lines.push(`On-chain actions (${p.targets.length}):`);
  for (let i = 0; i < p.targets.length; i++) {
    const signature = p.signatures[i] ?? "";
    const calldata = p.calldatas[i] ?? "0x";
    const shown =
      calldata.length > MAX_CALLDATA_HEX_CHARS
        ? `${calldata.slice(0, MAX_CALLDATA_HEX_CHARS)}... (${(calldata.length - 2) / 2} bytes)`
        : calldata;
    lines.push(
      `${i + 1}. target ${p.targets[i] ?? "?"}, value ${(p.values[i] ?? 0n).toString()} wei, signature "${signature}", calldata ${shown}`,
    );
  }
  return capText(lines.join("\n"), MAX_PROPOSAL_CHARS);
}

export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const omitted = text.length - max;
  return `${text.slice(0, max)}\n[truncated by the juror runtime: ${omitted} more characters not shown]`;
}
