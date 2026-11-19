import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, getAddress } from "viem";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export const repoPath = (...parts: string[]): string => join(REPO, ...parts);

export const readText = (...parts: string[]): string => readFileSync(repoPath(...parts), "utf8");

export const BASE = 84532;
export const UNICHAIN = 1301;
export const LASNA = 5318007;
export type ChainId = typeof BASE | typeof UNICHAIN | typeof LASNA;
export const CHAINS: readonly ChainId[] = [LASNA, BASE, UNICHAIN];

export const CHAIN_NAME: Record<ChainId, string> = {
  [LASNA]: "Reactive Lasna",
  [BASE]: "Base Sepolia",
  [UNICHAIN]: "Unichain Sepolia",
};

export const EXPLORER_TX: Record<ChainId, string> = {
  [LASNA]: "https://lasna.reactscan.net/tx/",
  [BASE]: "https://sepolia.basescan.org/tx/",
  [UNICHAIN]: "https://unichain-sepolia.blockscout.com/tx/",
};

export const EXPLORER_ADDRESS: Record<ChainId, string> = {
  [LASNA]: "https://lasna.reactscan.net/address/",
  [BASE]: "https://sepolia.basescan.org/address/",
  [UNICHAIN]: "https://unichain-sepolia.blockscout.com/address/",
};

/** Reactive system contract on Lasna and the callback proxies on the destination chains (tools/live/funds.sh). */
export const FUNDS_SERVICE: Record<ChainId, Address> = {
  [LASNA]: "0x8888888888888888888888888888888888888888",
  [BASE]: "0x476F44b11F5C942c58f4c8E3d0300E5710743585",
  [UNICHAIN]: "0x775c9B990ADe401060B78D0e98684eEf8d2466C1",
};

/** Juror addresses in juror-number order (docs/DEPLOYMENTS.md). */
export const JURORS: readonly Address[] = [
  "0x1e1005C3Ac959A66e8cE5423382fC7a28a24839F",
  "0xEa5C14faC05Aa8a4C9a3A4184aE6E17E65402f54",
  "0x1e0702541FC8cd645Bf955fA5c26e4DfC0eF9fc7",
];

export function asChainId(n: number): ChainId {
  if (n === BASE || n === UNICHAIN || n === LASNA) return n;
  throw new Error(`unknown chain id ${n}`);
}

/** contracts/deployments/<chainId>.env, last line per key wins (docs/DEPLOYMENTS.md). */
export function deployment(chain: ChainId, key: string): Address {
  const hits = readText("contracts/deployments", `${chain}.env`)
    .split("\n")
    .filter((l) => l.startsWith(`${key}=`));
  const last = hits.at(-1);
  if (last === undefined) throw new Error(`${key} missing in contracts/deployments/${chain}.env`);
  return getAddress(last.slice(key.length + 1).trim());
}

export function readJsonl<T>(...parts: string[]): T[] {
  return readText(...parts)
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);
}
