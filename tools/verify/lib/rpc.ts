/**
 * JSON-RPC over public endpoints with retries, rate-limit backoff, endpoint failover and a disk cache for data that
 * cannot change: receipts, blocks and state read at an explicit block number, and log ranges that end at least
 * FINALITY blocks under the head. Cache: tools/verify/.cache (gitignored). FRESH=1 ignores what is cached.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, type Hex, hexToBigInt, toHex } from "viem";
import { BASE, type ChainId, LASNA, UNICHAIN } from "./repo.ts";

const ENDPOINTS: Record<ChainId, readonly string[]> = {
  [BASE]: ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"],
  [UNICHAIN]: ["https://sepolia.unichain.org", "https://unichain-sepolia-rpc.publicnode.com"],
  [LASNA]: ["https://lasna-rpc.rnk.dev/"],
};

/** Largest eth_getLogs range each public endpoint serves (measured): Base 200 blocks, Unichain 1,000, Lasna 30,000. */
export const LOG_CHUNK: Record<ChainId, bigint> = { [BASE]: 200n, [UNICHAIN]: 1_000n, [LASNA]: 30_000n };

/** Blocks under the head after which a log range is treated as final and cached. */
const FINALITY: Record<ChainId, bigint> = { [BASE]: 300n, [UNICHAIN]: 300n, [LASNA]: 50n };

const MAX_ATTEMPTS = 8;
/** Requests in flight per chain. Lasna answers in about 2 s each, so it gets more parallelism to stay latency bound. */
const MAX_IN_FLIGHT: Record<ChainId, number> = { [BASE]: 6, [UNICHAIN]: 6, [LASNA]: 12 };
const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", ".cache");
const FRESH = process.env.FRESH === "1";

export interface RpcLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  logIndex: Hex;
}

export interface RpcReceipt {
  status: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  from: Address;
  to: Address | null;
  contractAddress: Address | null;
  gasUsed: Hex;
  effectiveGasPrice: Hex;
  l1Fee?: Hex;
  logs: RpcLog[];
}

export interface RpcBlock {
  number: Hex;
  timestamp: Hex;
  timestampMs?: Hex;
}

export const stats = { requests: 0, cacheHits: 0, retries: 0 };

class RpcError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const inFlight = new Map<ChainId, number>();
const waiting = new Map<ChainId, (() => void)[]>();

async function acquire(chain: ChainId): Promise<void> {
  if ((inFlight.get(chain) ?? 0) < MAX_IN_FLIGHT[chain]) {
    inFlight.set(chain, (inFlight.get(chain) ?? 0) + 1);
    return;
  }
  await new Promise<void>((resolve) => waiting.set(chain, [...(waiting.get(chain) ?? []), resolve]));
}

function release(chain: ChainId): void {
  const next = waiting.get(chain)?.shift();
  if (next !== undefined) next();
  else inFlight.set(chain, (inFlight.get(chain) ?? 1) - 1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(url: string, method: string, params: unknown[]): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new RpcError(`${url}: ${(e as Error).message}`, true);
  }
  if (res.status === 429 || res.status >= 500) {
    const after = Number(res.headers.get("retry-after"));
    if (Number.isFinite(after) && after > 0) await sleep(Math.min(after, 30) * 1000);
    throw new RpcError(`${url}: HTTP ${res.status}`, true);
  }
  if (!res.ok) throw new RpcError(`${url}: HTTP ${res.status}`, false);
  const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
  if (body.error !== undefined) {
    const m = body.error.message;
    // Rate limits and transient node errors come back as JSON-RPC errors on some endpoints.
    const retryable =
      /rate|limit|too many|timeout|busy|try again|temporar|header not found|unavailable/i.test(m);
    throw new RpcError(`${url}: ${method} ${body.error.code} ${m}`, retryable);
  }
  return body.result;
}

/** One JSON-RPC call with retries and failover. `accept` rejects a well-formed but unusable answer. */
async function call<T>(
  chain: ChainId,
  method: string,
  params: unknown[],
  accept: (r: unknown) => boolean = () => true,
): Promise<T> {
  const urls = ENDPOINTS[chain];
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const url = urls[attempt % urls.length] as string;
    await acquire(chain);
    try {
      stats.requests++;
      const result = await post(url, method, params);
      if (!accept(result)) throw new RpcError(`${url}: unusable answer to ${method}`, true);
      return result as T;
    } catch (e) {
      lastError = e as Error;
      if (e instanceof RpcError && !e.retryable && urls.length === 1) throw e;
    } finally {
      release(chain);
    }
    stats.retries++;
    await sleep(Math.min(15_000, 500 * 2 ** attempt) * (0.5 + Math.random()));
  }
  throw new Error(`${method} on chain ${chain} failed after ${MAX_ATTEMPTS} attempts: ${lastError?.message}`);
}

function cachePath(chain: ChainId, method: string, params: unknown[]): string {
  const key = createHash("sha256")
    .update(JSON.stringify([method, params]))
    .digest("hex");
  return join(CACHE_DIR, String(chain), `${method}-${key}.json`);
}

async function cached<T>(
  chain: ChainId,
  method: string,
  params: unknown[],
  cacheable: (r: T) => boolean,
  accept?: (r: unknown) => boolean,
): Promise<T> {
  const path = cachePath(chain, method, params);
  if (!FRESH) {
    try {
      const hit = JSON.parse(readFileSync(path, "utf8")) as T;
      stats.cacheHits++;
      return hit;
    } catch {
      // not cached yet
    }
  }
  const result = await call<T>(chain, method, params, accept);
  if (cacheable(result)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(result));
  }
  return result;
}

const heads = new Map<ChainId, bigint>();

/** The head, read once per run so every scan in the run ends at the same block. */
export async function head(chain: ChainId): Promise<bigint> {
  const hit = heads.get(chain);
  if (hit !== undefined) return hit;
  const n = hexToBigInt(await call<Hex>(chain, "eth_blockNumber", []));
  heads.set(chain, n);
  return n;
}

export async function receipt(chain: ChainId, tx: Hex): Promise<RpcReceipt | null> {
  return cached<RpcReceipt | null>(chain, "eth_getTransactionReceipt", [tx], (r) => r !== null);
}

/** Base Sepolia stamps blocks in milliseconds (`timestampMs`); a Base answer without it is retried elsewhere. */
export async function block(chain: ChainId, n: bigint): Promise<RpcBlock> {
  const accept = (r: unknown) => r !== null && (chain !== BASE || (r as RpcBlock).timestampMs !== undefined);
  const b = await cached<RpcBlock | null>(
    chain,
    "eth_getBlockByNumber",
    [toHex(n), false],
    (r) => r !== null,
    accept,
  );
  if (b === null) throw new Error(`block ${n} not found on chain ${chain}`);
  return b;
}

/** Block time in ms: Base's native `timestampMs`, otherwise whole seconds times 1000. */
export async function blockMs(chain: ChainId, n: bigint): Promise<number> {
  const b = await block(chain, n);
  return b.timestampMs !== undefined
    ? Number(hexToBigInt(b.timestampMs))
    : Number(hexToBigInt(b.timestamp)) * 1000;
}

/** The last block whose timestamp is at or before `ms`, by binary search between `low` and the head. */
export async function blockAtOrBefore(chain: ChainId, ms: number, low: bigint): Promise<bigint> {
  let lo = low;
  let hi = await head(chain);
  if ((await blockMs(chain, hi)) <= ms) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if ((await blockMs(chain, mid)) <= ms) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

/** Every log of `address` in [from, to], in the chain's chunk size, in block order. */
export async function logs(chain: ChainId, address: Address, from: bigint, to: bigint): Promise<RpcLog[]> {
  const final = (await head(chain)) - FINALITY[chain];
  const step = LOG_CHUNK[chain];
  const ranges: [bigint, bigint][] = [];
  // Chunks are aligned to multiples of the chunk size so cached ranges are reused when `from` moves.
  for (let a = (from / step) * step; a <= to; a += step) {
    ranges.push([a, a + step - 1n]);
  }
  const parts = await Promise.all(
    ranges.map(([a, b]) => {
      const end = b > to ? to : b;
      const params = [{ address, fromBlock: toHex(a), toBlock: toHex(end) }];
      return cached<RpcLog[]>(chain, "eth_getLogs", params, () => end <= final);
    }),
  );
  return parts
    .flat()
    .filter((l) => {
      const n = hexToBigInt(l.blockNumber);
      return n >= from && n <= to;
    })
    .sort((x, y) => {
      const d = hexToBigInt(x.blockNumber) - hexToBigInt(y.blockNumber);
      return d !== 0n ? (d < 0n ? -1 : 1) : Number(hexToBigInt(x.logIndex) - hexToBigInt(y.logIndex));
    });
}

export async function balanceAt(chain: ChainId, address: Address, n: bigint): Promise<bigint> {
  return hexToBigInt(await cached<Hex>(chain, "eth_getBalance", [address, toHex(n)], () => true));
}

export async function callAt(chain: ChainId, to: Address, data: Hex, n: bigint): Promise<Hex> {
  return cached<Hex>(chain, "eth_call", [{ to, data }, toHex(n)], () => true);
}

export async function codeNow(chain: ChainId, address: Address): Promise<Hex> {
  return call<Hex>(chain, "eth_getCode", [address, "latest"]);
}
