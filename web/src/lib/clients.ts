import { createPublicClient, http, type PublicClient } from "viem";
import { type ChainId, chains } from "./chains";

const cache = new Map<ChainId, PublicClient>();

/** One read client per chain, JSON-RPC batched, with a short retry for flaky public endpoints. */
export function publicClient(chainId: ChainId): PublicClient {
  const existing = cache.get(chainId);
  if (existing) return existing;
  const info = chains[chainId];
  const client = createPublicClient({
    chain: info.chain,
    transport: http(info.rpc, {
      batch: { batchSize: 24, wait: 16 },
      retryCount: 2,
      retryDelay: 400,
      timeout: 15_000,
    }),
  }) as PublicClient;
  cache.set(chainId, client);
  return client;
}

/** Thrown for any failed read, so the page can say which chain did not answer. */
export class ChainReadError extends Error {
  constructor(
    readonly chainId: ChainId,
    readonly what: string,
    cause: unknown,
  ) {
    super(`${chains[chainId].name}: could not read ${what}`, { cause });
    this.name = "ChainReadError";
  }
}

export async function onChain<T>(chainId: ChainId, what: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    throw new ChainReadError(chainId, what, err);
  }
}
