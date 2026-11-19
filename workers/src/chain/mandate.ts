import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import { keccakUtf8 } from "../canonical.ts";
import type { FetchLike } from "../providers/types.ts";

export const MAX_MANDATE_BYTES = 256 * 1024;
const IPFS_GATEWAY = "https://ipfs.io/ipfs/";

export class MandateMismatchError extends Error {
  override readonly name = "MandateMismatchError";
}

/** Fetches mandate text by URI. Supports https, http, ipfs (through a public gateway) and file URIs. */
export async function fetchMandateText(uri: string, fetchImpl: FetchLike = fetch): Promise<string> {
  if (uri.startsWith("file://")) {
    const text = await readFile(fileURLToPath(uri), "utf8");
    if (Buffer.byteLength(text) > MAX_MANDATE_BYTES)
      throw new Error(`Mandate at ${uri} exceeds ${MAX_MANDATE_BYTES} bytes`);
    return text;
  }
  const url = uri.startsWith("ipfs://") ? `${IPFS_GATEWAY}${uri.slice("ipfs://".length)}` : uri;
  if (!/^https?:\/\//.test(url)) throw new Error(`Unsupported mandate URI scheme: ${uri}`);
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Mandate fetch ${url} returned HTTP ${response.status}`);
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > MAX_MANDATE_BYTES)
    throw new Error(`Mandate at ${uri} exceeds ${MAX_MANDATE_BYTES} bytes`);
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}

/** Throws MandateMismatchError unless keccak256(utf8 text) equals the on-chain hash. */
export function verifyMandate(text: string, expected: Hex): void {
  const actual = keccakUtf8(text);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new MandateMismatchError(
      `Mandate hash mismatch: on chain ${expected}, fetched text hashes to ${actual}`,
    );
  }
}
