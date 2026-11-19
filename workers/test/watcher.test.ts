import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { CaseOpenedEvent, DocketReader } from "../src/chain/docket.ts";
import { MemoryCheckpoint } from "../src/checkpoint.ts";
import { type CaseResult, pollOnce, type WatcherOptions } from "../src/watcher.ts";

const ME = "0x1111111111111111111111111111111111111111" as Address;

function event(caseId: bigint, blockNumber: bigint, logIndex = 0): CaseOpenedEvent {
  return {
    caseId,
    originChainId: 84532n,
    governor: "0x2222222222222222222222222222222222222222",
    proposalId: caseId * 1000n,
    voteStart: 1n,
    voteEnd: 2n,
    originTxHash: `0x${"aa".repeat(32)}` as Hex,
    delegate: "0x3333333333333333333333333333333333333333",
    mandateVersion: 1n,
    mandateHash: `0x${"bb".repeat(32)}` as Hex,
    blockNumber,
    logIndex,
  };
}

class FakeDocket implements DocketReader {
  readonly posted = new Set<bigint>();
  readonly logQueries: Array<[bigint, bigint]> = [];
  readonly postedReads: bigint[] = [];
  constructor(
    public head: bigint,
    public events: CaseOpenedEvent[],
  ) {}
  async latestBlock() {
    return this.head;
  }
  async caseOpenedLogs(from: bigint, to: bigint) {
    this.logQueries.push([from, to]);
    return this.events.filter((e) => e.blockNumber >= from && e.blockNumber <= to);
  }
  async hasPosted(caseId: bigint, juror: Address) {
    this.postedReads.push(caseId);
    return juror === ME && this.posted.has(caseId);
  }
}

function setup(docket: FakeDocket, overrides: Partial<WatcherOptions> = {}) {
  const processed: bigint[] = [];
  const checkpoint = new MemoryCheckpoint();
  const options: WatcherOptions = {
    reader: docket,
    checkpoint,
    juror: ME,
    startBlock: 100n,
    chunkBlocks: 50n,
    confirmations: 0n,
    processCase: async (e): Promise<CaseResult> => {
      processed.push(e.caseId);
      docket.posted.add(e.caseId);
      return "posted";
    },
    ...overrides,
  };
  return { processed, checkpoint, options };
}

describe("pollOnce", () => {
  it("processes each case once even when CaseOpened is re-emitted", async () => {
    const docket = new FakeDocket(200n, [event(1n, 110n), event(2n, 120n), event(1n, 130n), event(1n, 180n)]);
    const { processed, options } = setup(docket);
    const s = await pollOnce(options);
    expect(processed).toEqual([1n, 2n]);
    expect(s).toMatchObject({ seen: 4, duplicates: 2, posted: 2, failed: [], checkpoint: 200n });
  });

  it("is idempotent across passes: a second pass over the same range posts nothing", async () => {
    const docket = new FakeDocket(200n, [event(1n, 110n), event(2n, 120n)]);
    const { processed, checkpoint, options } = setup(docket);
    await pollOnce(options);
    checkpoint.value = undefined; // lost checkpoint: re-scan from the start block
    const again = await pollOnce(options);
    expect(processed).toEqual([1n, 2n]);
    expect(again).toMatchObject({ posted: 0, alreadyPosted: 2 });
  });

  it("skips cases already posted on chain without calling the processor", async () => {
    const docket = new FakeDocket(200n, [event(7n, 150n)]);
    docket.posted.add(7n);
    const { processed, options } = setup(docket);
    const s = await pollOnce(options);
    expect(processed).toEqual([]);
    expect(s.alreadyPosted).toBe(1);
  });

  it("scans from the checkpoint in chunks up to head minus confirmations", async () => {
    const docket = new FakeDocket(300n, []);
    const { checkpoint, options } = setup(docket, { confirmations: 5n });
    checkpoint.value = 149n;
    const s = await pollOnce(options);
    expect(docket.logQueries).toEqual([
      [150n, 199n],
      [200n, 249n],
      [250n, 295n],
    ]);
    expect(s.checkpoint).toBe(295n);
    expect(checkpoint.value).toBe(295n);
  });

  it("does nothing when there are no new blocks", async () => {
    const docket = new FakeDocket(150n, []);
    const { checkpoint, options } = setup(docket);
    checkpoint.value = 150n;
    const s = await pollOnce(options);
    expect(docket.logQueries).toEqual([]);
    expect(s.checkpoint).toBe(150n);
  });

  it("holds the checkpoint before a failed case and retries it next pass", async () => {
    const docket = new FakeDocket(200n, [event(1n, 110n), event(2n, 120n), event(3n, 125n), event(4n, 170n)]);
    let failOnce = true;
    const processed: bigint[] = [];
    const { checkpoint, options } = setup(docket, {
      processCase: async (e) => {
        if (e.caseId === 2n && failOnce) {
          failOnce = false;
          throw new Error("provider down");
        }
        processed.push(e.caseId);
        docket.posted.add(e.caseId);
        return "posted";
      },
    });
    const first = await pollOnce(options);
    expect(first.failed).toEqual([{ caseId: 2n, error: "provider down" }]);
    expect(first.checkpoint).toBe(119n);
    expect(checkpoint.value).toBe(119n);
    expect(processed).toEqual([1n, 3n]);

    const second = await pollOnce(options);
    expect(processed).toEqual([1n, 3n, 2n, 4n]);
    expect(second).toMatchObject({ posted: 2, alreadyPosted: 1, failed: [], checkpoint: 200n });
  });

  it("advances past permanently skipped cases", async () => {
    const docket = new FakeDocket(200n, [event(9n, 140n)]);
    const { options } = setup(docket, { processCase: async () => "skipped" });
    const s = await pollOnce(options);
    expect(s).toMatchObject({ skipped: 1, checkpoint: 200n });
  });

  it("processes logs in block and log-index order", async () => {
    const docket = new FakeDocket(200n, [event(3n, 120n, 2), event(1n, 110n), event(2n, 120n, 1)]);
    const { processed, options } = setup(docket);
    await pollOnce(options);
    expect(processed).toEqual([1n, 2n, 3n]);
  });
});
