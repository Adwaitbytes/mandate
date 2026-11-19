import { parseAbi } from "viem";

/** Juror-facing subset of the Docket ABI. Source of truth: contracts/src/Docket.sol and IDocket.sol. */
export const docketAbi = parseAbi([
  "event CaseOpened(uint256 indexed caseId, uint256 originChainId, address governor, uint256 proposalId, uint256 voteStart, uint256 voteEnd, bytes32 originTxHash, address delegate, uint256 mandateVersion, bytes32 mandateHash)",
  "event Verdict(uint256 indexed caseId, address indexed juror, uint8 support, uint16 confidenceBps, bool injectionFlag, bytes32 rationaleHash, bytes32 modelIdHash, bytes32 promptHash)",
  "event MandateSet(uint256 indexed version, bytes32 mandateHash, string uri)",
  "struct VerdictRecord { bool posted; uint8 support; uint16 confidenceBps; bool injectionFlag; uint64 postedAt; bytes32 rationaleHash; bytes32 modelIdHash; bytes32 promptHash; }",
  "struct MandateRecord { bytes32 mandateHash; uint64 setAt; string uri; }",
  "function postVerdict(uint256 caseId, uint8 support, uint16 confidenceBps, bytes32 rationaleHash, bytes32 modelIdHash, bytes32 promptHash, bool injectionFlag)",
  "function getVerdict(uint256 caseId, address juror) view returns (VerdictRecord)",
  "function getMandate(uint256 version) view returns (MandateRecord)",
  "function isJuror(address account) view returns (bool)",
  "function caseCount() view returns (uint256)",
  "function mandateVersion() view returns (uint256)",
  "error UnknownCase(uint256 caseId)",
  "error NotJuror(address account)",
  "error AlreadyPosted(uint256 caseId, address juror)",
  "error InvalidSupport(uint8 support)",
  "error InvalidConfidence(uint16 confidenceBps)",
  "error ZeroHash()",
]);

/** OpenZeppelin Governor and Governor Bravo share this event; topic0 0x7d84a626...d5e0. */
export const proposalCreatedAbi = parseAbi([
  "event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 voteStart, uint256 voteEnd, string description)",
]);

export const PROPOSAL_CREATED_TOPIC =
  "0x7d84a6263ae0d98d3329bd7b46bb4e8d6f98cd35a7adb45c274c8b7fd5ebd5e0" as const;
export const CASE_OPENED_TOPIC =
  "0x79d9758f99914c16528a06bcd2888950a224c5858485987de97ffb82647a16b2" as const;
