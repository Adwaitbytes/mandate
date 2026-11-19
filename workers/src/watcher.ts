import type { Address } from "viem";
import type { CaseOpenedEvent, DocketReader } from "./chain/docket.ts";
import type { CheckpointStore } from "./checkpoint.ts";

export type CaseResult = "posted" | "alreadyPosted" | "skipped";

export interface WatcherOptions {
  reader: DocketReader;
  checkpoint: CheckpointStore;
  juror: Address;
  /** First block to scan when there is no checkpoint (the Docket deployment block). */
  startBlock: bigint;
  /** Blocks per eth_getLogs call. */
  chunkBlocks: bigint;
  /** Blocks to stay behind the head, to avoid acting on a log that a reorg removes. */
  confirmations: bigint;
  processCase: (event: CaseOpenedEvent) => Promise<CaseResult>;
  log?: (message: string) => void;
}

export interface PollSummary {
  fromBlock: bigint;
  toBlock: bigint;
  seen: number;
  duplicates: number;
  alreadyPosted: number;
  posted: number;
  skipped: number;
  failed: { caseId: bigint; error: string }[];
  checkpoint: bigint;
}

/**
 * One pass over new CaseOpened logs. Idempotent: duplicates of a caseId (the Docket re-emits on resend) are
 * handled once, cases this juror already ruled on are skipped by an on-chain read, and the checkpoint only moves
 * past a block once every case in it either succeeded or was skipped for good. A failed case is retried on the
 * next pass.
 */
export async function pollOnce(options: WatcherOptions): Promise<PollSummary> {
  const log = options.log ?? (() => {});
  const saved = await options.checkpoint.load();
  const fromBlock = saved === undefined ? options.startBlock : saved + 1n;
  const head = await options.reader.latestBlock();
  const toBlock = head > options.confirmations ? head - options.confirmations : 0n;
  const summary: PollSummary = {
    fromBlock,
    toBlock,
    seen: 0,
    duplicates: 0,
    alreadyPosted: 0,
    posted: 0,
    skipped: 0,
    failed: [],
    checkpoint: saved ?? options.startBlock - 1n,
  };
  if (toBlock < fromBlock) return summary;

  const handled = new Set<bigint>();
  for (let start = fromBlock; start <= toBlock; start += options.chunkBlocks) {
    const end = start + options.chunkBlocks - 1n < toBlock ? start + options.chunkBlocks - 1n : toBlock;
    const events = await options.reader.caseOpenedLogs(start, end);
    events.sort((a, b) =>
      a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
    );
    let firstFailedBlock: bigint | undefined;

    for (const event of events) {
      summary.seen++;
      if (handled.has(event.caseId)) {
        summary.duplicates++;
        continue;
      }
      handled.add(event.caseId);
      try {
        if (await options.reader.hasPosted(event.caseId, options.juror)) {
          summary.alreadyPosted++;
          continue;
        }
        const result = await options.processCase(event);
        if (result === "posted") summary.posted++;
        else if (result === "alreadyPosted") summary.alreadyPosted++;
        else summary.skipped++;
      } catch (err) {
        const message = (err as Error).message;
        summary.failed.push({ caseId: event.caseId, error: message });
        log(`case ${event.caseId}: failed, will retry next pass: ${message}`);
        if (firstFailedBlock === undefined || event.blockNumber < firstFailedBlock)
          firstFailedBlock = event.blockNumber;
      }
    }

    if (firstFailedBlock !== undefined) {
      // Stop here so the next pass re-reads from the failed case's block. Cases after it are idempotent.
      const safe = firstFailedBlock - 1n;
      if (safe > summary.checkpoint) {
        summary.checkpoint = safe;
        await options.checkpoint.save(safe);
      }
      return summary;
    }
    summary.checkpoint = end;
    await options.checkpoint.save(end);
  }
  return summary;
}
