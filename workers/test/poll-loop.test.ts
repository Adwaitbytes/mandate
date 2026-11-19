import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type Address,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  createPublicClient,
  type Hex,
  HttpRequestError,
  LimitExceededRpcError,
  type PublicClient,
  RpcRequestError,
  TimeoutError,
} from "viem";
import { afterEach, describe, expect, it } from "vitest";
import type { CaseOpenedEvent, DocketReader } from "../src/chain/docket.ts";
import { DocketClient } from "../src/chain/docket.ts";
import { isTransientRpcError, rpcTransport } from "../src/chain/rpc.ts";
import { MemoryCheckpoint } from "../src/checkpoint.ts";
import { backoffDelay, retryTransient, runPollLoop } from "../src/loop.ts";
import { pollOnce } from "../src/watcher.ts";

const ME = "0x1111111111111111111111111111111111111111" as Address;
const DOCKET = "0x4444444444444444444444444444444444444444" as Address;

const timeout = () => new TimeoutError({ body: { method: "eth_blockNumber" }, url: "https://rpc.test" });
const httpStatus = (status: number) =>
  new HttpRequestError({ url: "https://rpc.test", status, body: { method: "eth_getLogs" } });
const socketReset = () => {
  const cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  return new HttpRequestError({ url: "https://rpc.test", cause });
};

describe("isTransientRpcError", () => {
  it("accepts timeouts, 429, 5xx, socket resets and RPC limit errors, also when wrapped", () => {
    expect(isTransientRpcError(timeout())).toBe(true);
    expect(isTransientRpcError(httpStatus(429))).toBe(true);
    expect(isTransientRpcError(httpStatus(503))).toBe(true);
    expect(isTransientRpcError(socketReset())).toBe(true);
    expect(isTransientRpcError(new LimitExceededRpcError(new Error("limit")))).toBe(true);
    const wrapped = new ContractFunctionExecutionError(httpStatus(502), {
      abi: [],
      functionName: "getVerdict",
      contractAddress: DOCKET,
    });
    expect(isTransientRpcError(wrapped)).toBe(true);
    expect(isTransientRpcError(new TypeError("fetch failed"))).toBe(true);
  });

  it("rejects reverts, bad requests and programming errors", () => {
    const revert = new ContractFunctionRevertedError({ abi: [], functionName: "postVerdict" });
    expect(isTransientRpcError(revert)).toBe(false);
    expect(isTransientRpcError(httpStatus(400))).toBe(false);
    expect(
      isTransientRpcError(
        new RpcRequestError({ body: {}, url: "x", error: { code: -32602, message: "invalid params" } }),
      ),
    ).toBe(false);
    expect(isTransientRpcError(new Error("boom"))).toBe(false);
    expect(isTransientRpcError(undefined)).toBe(false);
  });
});

describe("backoffDelay", () => {
  it("doubles per consecutive failure, caps, and keeps half the step fixed", () => {
    expect(backoffDelay(1, 2_000, 60_000, () => 0)).toBe(1_000);
    expect(backoffDelay(1, 2_000, 60_000, () => 1)).toBe(2_000);
    expect(backoffDelay(3, 2_000, 60_000, () => 0.5)).toBe(6_000);
    expect(backoffDelay(20, 2_000, 60_000, () => 1)).toBe(60_000);
  });
});

function event(caseId: bigint, blockNumber: bigint): CaseOpenedEvent {
  return {
    caseId,
    originChainId: 84532n,
    governor: "0x2222222222222222222222222222222222222222",
    proposalId: caseId,
    voteStart: 1n,
    voteEnd: 2n,
    originTxHash: `0x${"aa".repeat(32)}` as Hex,
    delegate: "0x3333333333333333333333333333333333333333",
    mandateVersion: 1n,
    mandateHash: `0x${"bb".repeat(32)}` as Hex,
    blockNumber,
    logIndex: 0,
  };
}

/** A Docket whose reads fail with the scripted errors first, the way the public Base RPC did on 2026-11-19. */
class FlakyDocket implements DocketReader {
  readonly posted = new Set<bigint>();
  constructor(
    private readonly headFailures: Error[],
    private readonly logFailures: Error[],
    private readonly events: CaseOpenedEvent[],
  ) {}
  async latestBlock() {
    const e = this.headFailures.shift();
    if (e !== undefined) throw e;
    return 200n;
  }
  async caseOpenedLogs(from: bigint, to: bigint) {
    const e = this.logFailures.shift();
    if (e !== undefined) throw e;
    return this.events.filter((x) => x.blockNumber >= from && x.blockNumber <= to);
  }
  async hasPosted(caseId: bigint) {
    return this.posted.has(caseId);
  }
}

describe("runPollLoop", () => {
  it("survives eth_blockNumber timeouts, 429 and socket resets, backs off with jitter, then posts the case", async () => {
    const docket = new FlakyDocket(
      [timeout(), httpStatus(429), socketReset()],
      [httpStatus(503)],
      [event(7n, 150n)],
    );
    const checkpoint = new MemoryCheckpoint();
    const processed: bigint[] = [];
    const sleeps: number[] = [];
    const logs: string[] = [];
    const stop = new AbortController();
    await runPollLoop({
      poll: () =>
        pollOnce({
          reader: docket,
          checkpoint,
          juror: ME,
          startBlock: 100n,
          chunkBlocks: 50n,
          confirmations: 0n,
          processCase: async (e) => {
            processed.push(e.caseId);
            docket.posted.add(e.caseId);
            stop.abort();
            return "posted";
          },
        }),
      intervalMs: 1_000,
      log: (m) => void logs.push(m),
      backoff: { transientBaseMs: 2_000, unexpectedBaseMs: 10_000, maxMs: 60_000 },
      sleep: async (ms) => void sleeps.push(ms),
      random: () => 1,
      signal: stop.signal,
    });
    expect(processed).toEqual([7n]);
    // Four failed passes in a row (three head reads, one log query), each backing off twice as long.
    expect(sleeps).toEqual([2_000, 4_000, 8_000, 16_000]);
    expect(logs).toHaveLength(4);
    expect(logs[0]).toMatch(/transient RPC error, 1 in a row\): TimeoutError/);
    expect(logs[3]).toMatch(/4 in a row/);
    expect(await checkpoint.load()).toBe(200n);
  });

  it("never rethrows an unexpected error, backs off longer for it, and resets after a good pass", async () => {
    const outcomes: Array<Error | "ok"> = [new Error("disk full"), "ok", timeout(), "ok"];
    const sleeps: number[] = [];
    const logs: string[] = [];
    const stop = new AbortController();
    let passes = 0;
    await runPollLoop({
      poll: async () => {
        passes++;
        const next = outcomes.shift();
        if (outcomes.length === 0) stop.abort();
        if (next instanceof Error) throw next;
        return passes;
      },
      intervalMs: 500,
      log: (m) => void logs.push(m),
      backoff: { transientBaseMs: 2_000, unexpectedBaseMs: 10_000, maxMs: 60_000 },
      sleep: async (ms) => void sleeps.push(ms),
      random: () => 0,
      signal: stop.signal,
    });
    expect(passes).toBe(4);
    expect(sleeps).toEqual([5_000, 500, 1_000]);
    expect(logs[0]).toMatch(/unexpected error, 1 in a row\): Error: disk full/);
    expect(logs[1]).toMatch(/transient RPC error, 1 in a row/);
  });

  it("does not shorten the poll interval when the backoff step is smaller", async () => {
    const sleeps: number[] = [];
    const stop = new AbortController();
    let n = 0;
    await runPollLoop({
      poll: async () => {
        if (++n === 2) stop.abort();
        throw timeout();
      },
      intervalMs: 10_000,
      log: () => {},
      sleep: async (ms) => void sleeps.push(ms),
      random: () => 0,
      signal: stop.signal,
    });
    expect(sleeps).toEqual([10_000]);
  });
});

describe("retryTransient", () => {
  it("retries a transient startup read and throws anything else at once", async () => {
    let calls = 0;
    const value = await retryTransient(
      "eth_chainId",
      async () => {
        if (++calls < 3) throw timeout();
        return 84532;
      },
      { log: () => {}, sleep: async () => {}, random: () => 0 },
    );
    expect(value).toBe(84532);
    expect(calls).toBe(3);
    await expect(
      retryTransient("isJuror", async () => Promise.reject(new Error("not a juror")), {
        log: () => {},
        sleep: async () => {},
      }),
    ).rejects.toThrow("not a juror");
  });
});

// Two local JSON-RPC endpoints stand in for the public RPCs: the first stalls or errors, the second answers.
type Behaviour = "hang" | "503" | "ok";
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => {
      s.closeAllConnections();
      return new Promise<void>((r) => s.close(() => r()));
    }),
  );
});

async function endpoint(behaviour: () => Behaviour, seen: string[]): Promise<string> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      seen.push(method);
      const b = behaviour();
      if (b === "hang") return; // never answers; the client must time out
      if (b === "503") {
        res.writeHead(503).end("busy");
        return;
      }
      const result = method === "eth_blockNumber" ? "0xc8" : method === "eth_chainId" ? "0x14a34" : null;
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("rpcTransport failover", () => {
  it("answers from the second endpoint when the first times out", async () => {
    const seenA: string[] = [];
    const seenB: string[] = [];
    const a = await endpoint(() => "hang", seenA);
    const b = await endpoint(() => "ok", seenB);
    const client = createPublicClient({ transport: rpcTransport([a, b], { timeoutMs: 150 }) });
    const docket = new DocketClient(DOCKET, client as PublicClient);
    await expect(docket.latestBlock()).resolves.toBe(200n);
    expect(seenA).toEqual(["eth_blockNumber"]);
    expect(seenB).toEqual(["eth_blockNumber"]);
  });

  it("answers from the second endpoint when the first returns 503", async () => {
    const seenB: string[] = [];
    const a = await endpoint(() => "503", []);
    const b = await endpoint(() => "ok", seenB);
    const client = createPublicClient({ transport: rpcTransport([a, b], { timeoutMs: 1_000 }) });
    await expect(client.getChainId()).resolves.toBe(84532);
    expect(seenB).toEqual(["eth_chainId"]);
  });

  it("surfaces a transient error when every endpoint is down, which the poll loop then backs off on", async () => {
    const a = await endpoint(() => "503", []);
    const b = await endpoint(() => "503", []);
    const client = createPublicClient({ transport: rpcTransport([a, b], { timeoutMs: 1_000 }) });
    const err = await client.getBlockNumber().catch((e: unknown) => e);
    expect(isTransientRpcError(err)).toBe(true);
  });
});
