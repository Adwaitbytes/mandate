import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  decodeEventLog,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { docketAbi } from "./abi.ts";

export interface CaseOpenedEvent {
  caseId: bigint;
  originChainId: bigint;
  governor: Address;
  proposalId: bigint;
  voteStart: bigint;
  voteEnd: bigint;
  originTxHash: Hex;
  delegate: Address;
  mandateVersion: bigint;
  mandateHash: Hex;
  blockNumber: bigint;
  logIndex: number;
}

export interface MandateRecord {
  mandateHash: Hex;
  setAt: bigint;
  uri: string;
}

export interface VerdictArgs {
  caseId: bigint;
  support: number;
  confidenceBps: number;
  rationaleHash: Hex;
  modelIdHash: Hex;
  promptHash: Hex;
  injectionFlag: boolean;
}

/** Reads the watcher needs. Kept narrow so the watcher can be tested against an in-memory fake. */
export interface DocketReader {
  latestBlock(): Promise<bigint>;
  caseOpenedLogs(fromBlock: bigint, toBlock: bigint): Promise<CaseOpenedEvent[]>;
  hasPosted(caseId: bigint, juror: Address): Promise<boolean>;
}

export const VERDICT_GAS_LIMIT = 200_000n;

export class DocketClient implements DocketReader {
  constructor(
    readonly address: Address,
    private readonly publicClient: PublicClient,
  ) {}

  latestBlock(): Promise<bigint> {
    return this.publicClient.getBlockNumber();
  }

  async caseOpenedLogs(fromBlock: bigint, toBlock: bigint): Promise<CaseOpenedEvent[]> {
    const logs = await this.publicClient.getLogs({
      address: this.address,
      event: docketAbi.find((x) => x.type === "event" && x.name === "CaseOpened") as Extract<
        (typeof docketAbi)[number],
        { type: "event"; name: "CaseOpened" }
      >,
      fromBlock,
      toBlock,
      strict: true,
    });
    const out: CaseOpenedEvent[] = [];
    for (const log of logs) {
      if (log.blockNumber === null || log.logIndex === null) continue;
      const decoded = decodeEventLog({
        abi: docketAbi,
        eventName: "CaseOpened",
        data: log.data,
        topics: log.topics,
      });
      out.push({ ...decoded.args, blockNumber: log.blockNumber, logIndex: log.logIndex });
    }
    return out;
  }

  async hasPosted(caseId: bigint, juror: Address): Promise<boolean> {
    const v = await this.publicClient.readContract({
      address: this.address,
      abi: docketAbi,
      functionName: "getVerdict",
      args: [caseId, juror],
    });
    return v.posted;
  }

  async getMandate(version: bigint): Promise<MandateRecord> {
    const m = await this.publicClient.readContract({
      address: this.address,
      abi: docketAbi,
      functionName: "getMandate",
      args: [version],
    });
    return { mandateHash: m.mandateHash, setAt: m.setAt, uri: m.uri };
  }

  isJuror(account: Address): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.address,
      abi: docketAbi,
      functionName: "isJuror",
      args: [account],
    });
  }

  /**
   * Simulates then sends postVerdict with a fixed 200k gas limit and waits for the receipt. Returns
   * `alreadyPosted` instead of throwing when the Docket reports this juror already ruled on the case.
   */
  async postVerdict(
    wallet: WalletClient,
    args: VerdictArgs,
  ): Promise<{ status: "posted"; txHash: Hex; blockNumber: bigint } | { status: "alreadyPosted" }> {
    const account = wallet.account;
    if (account === undefined) throw new Error("Wallet client has no account");
    const callArgs = [
      args.caseId,
      args.support,
      args.confidenceBps,
      args.rationaleHash,
      args.modelIdHash,
      args.promptHash,
      args.injectionFlag,
    ] as const;
    try {
      await this.publicClient.simulateContract({
        address: this.address,
        abi: docketAbi,
        functionName: "postVerdict",
        args: callArgs,
        account,
      });
    } catch (err) {
      if (revertName(err) === "AlreadyPosted") return { status: "alreadyPosted" };
      throw err;
    }
    const txHash = await wallet.writeContract({
      address: this.address,
      abi: docketAbi,
      functionName: "postVerdict",
      args: callArgs,
      account,
      chain: wallet.chain,
      gas: VERDICT_GAS_LIMIT,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`postVerdict transaction ${txHash} reverted`);
    return { status: "posted", txHash, blockNumber: receipt.blockNumber };
  }
}

export function revertName(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  return revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined;
}
