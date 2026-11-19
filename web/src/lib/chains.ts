import { type Chain, defineChain } from "viem";
import { baseSepolia, unichainSepolia } from "viem/chains";

export const lasna = defineChain({
  id: 5318007,
  name: "Reactive Lasna",
  nativeCurrency: { name: "Lasna REACT", symbol: "lREACT", decimals: 18 },
  rpcUrls: { default: { http: ["https://lasna-rpc.rnk.dev/"] } },
  blockExplorers: { default: { name: "Reactscan", url: "https://lasna.reactscan.net" } },
  testnet: true,
});

export type ChainId = 84532 | 1301 | 5318007;

interface ChainInfo {
  chain: Chain;
  /** Short name used in running text: "Base Sepolia". */
  name: string;
  rpc: string;
  explorer: string;
  /**
   * Blocks per eth_getLogs request. The public endpoints refuse wider ranges: sepolia.base.org answers "limited
   * to a 200 range", sepolia.unichain.org "block range greater than 1000 max" (measured 2026-11-19).
   */
  logChunk: bigint;
}

// NEXT_PUBLIC_ variables must be read with literal names so Next can inline them in the client bundle.
const rpcOverride: Record<ChainId, string | undefined> = {
  84532: process.env.NEXT_PUBLIC_RPC_84532,
  1301: process.env.NEXT_PUBLIC_RPC_1301,
  5318007: process.env.NEXT_PUBLIC_RPC_5318007,
};

function rpcFor(id: ChainId, fallback: string): string {
  const value = rpcOverride[id];
  return value && value.length > 0 ? value : fallback;
}

export const chains: Record<ChainId, ChainInfo> = {
  84532: {
    chain: baseSepolia,
    name: "Base Sepolia",
    rpc: rpcFor(84532, "https://sepolia.base.org"),
    explorer: "https://sepolia.basescan.org",
    logChunk: 200n,
  },
  1301: {
    chain: unichainSepolia,
    name: "Unichain Sepolia",
    rpc: rpcFor(1301, "https://sepolia.unichain.org"),
    explorer: "https://sepolia.uniscan.xyz",
    logChunk: 1_000n,
  },
  5318007: {
    chain: lasna,
    name: "Reactive Lasna",
    rpc: rpcFor(5318007, "https://lasna-rpc.rnk.dev/"),
    explorer: "https://lasna.reactscan.net",
    logChunk: 10_000n,
  },
};

export function isChainId(value: number): value is ChainId {
  return value === 84532 || value === 1301 || value === 5318007;
}

export function chainInfo(id: number): ChainInfo | null {
  return isChainId(id) ? chains[id] : null;
}

export function txUrl(chainId: number, hash: string): string | null {
  const info = chainInfo(chainId);
  return info ? `${info.explorer}/tx/${hash}` : null;
}

export function addressUrl(chainId: number, address: string): string | null {
  const info = chainInfo(chainId);
  return info ? `${info.explorer}/address/${address}` : null;
}
