/**
 * Every contract address and full transaction hash in docs/DEPLOYMENTS.md, checked against chain: the receipt
 * succeeded, a deploy receipt created (or, for a factory, emitted) the listed address, the listed gas matches, the
 * address has code today, and Sourcify reports a match.
 */
import { getAddress, type Hex, hexToBigInt } from "viem";
import { BASE, type ChainId, LASNA, readText, UNICHAIN } from "./repo.ts";
import * as rpc from "./rpc.ts";

export interface DeployedContract {
  chainId: ChainId;
  name: string;
  address: Hex;
  deployTx: Hex;
  gas: number | null;
}

export interface TxClaim {
  chainId: ChainId;
  label: string;
  tx: Hex;
}

export interface ParsedDeployments {
  contracts: DeployedContract[];
  txs: TxClaim[];
  abbreviatedTxs: number;
}

const SECTION: [RegExp, ChainId][] = [
  [/^## Reactive Lasna/, LASNA],
  [/^## Base Sepolia/, BASE],
  [/^## Unichain Sepolia/, UNICHAIN],
];

export function parseDeployments(md: string): ParsedDeployments {
  const contracts: DeployedContract[] = [];
  const txs: TxClaim[] = [];
  let abbreviatedTxs = 0;
  let chain: ChainId | undefined;
  for (const line of md.split("\n")) {
    if (line.startsWith("## ")) chain = SECTION.find(([re]) => re.test(line))?.[1];
    if (chain === undefined || !line.startsWith("|") || /^\|\s*-/.test(line)) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    const name = (cells[0] ?? "").replace(/`/g, "");
    const address = cells.map((c) => /^`(0x[0-9a-fA-F]{40})`$/.exec(c)?.[1]).find((x) => x !== undefined);
    const tx = line.match(/`(0x[0-9a-fA-F]{64})`/)?.[1] as Hex | undefined;
    abbreviatedTxs += (line.match(/`0x[0-9a-f]{6,10}…[0-9a-f]{4,6}`/g) ?? []).length;
    const gasCell = cells.length === 4 && chain === LASNA ? cells[3] : undefined;
    const gas = gasCell !== undefined && /^[\d,]+$/.test(gasCell) ? Number(gasCell.replace(/,/g, "")) : null;
    // A row with an address and no transaction is an account (the jurors), not a contract.
    if (address !== undefined && tx !== undefined) {
      contracts.push({ chainId: chain, name, address: getAddress(address), deployTx: tx, gas });
    } else if (tx !== undefined) {
      txs.push({ chainId: chain, label: name, tx });
    }
  }
  return { contracts, txs, abbreviatedTxs };
}

export interface ContractCheck extends DeployedContract {
  deployBlock: string | null;
  receiptOk: boolean;
  createdAddress: boolean;
  gasOk: boolean | null;
  hasCode: boolean;
  sourcify: string;
}

export async function sourcifyStatus(chainId: number, address: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(`https://sourcify.dev/server/v2/contract/${chainId}/${address}`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 404) return "not verified";
      if (res.ok) return String(((await res.json()) as { match?: string | null }).match ?? "not verified");
    } catch {
      // retried below
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
  throw new Error(`Sourcify did not answer for ${chainId}/${address}`);
}

export async function checkDeployments(parsed: ParsedDeployments): Promise<{
  contracts: ContractCheck[];
  txs: (TxClaim & { ok: boolean })[];
}> {
  const contracts = await Promise.all(
    parsed.contracts.map(async (c): Promise<ContractCheck> => {
      const rec = await rpc.receipt(c.chainId, c.deployTx);
      const created =
        rec !== null &&
        (rec.contractAddress?.toLowerCase() === c.address.toLowerCase() ||
          // factory.create: the new address is in the factory's event data, not in contractAddress
          rec.logs.some((l) => l.data.toLowerCase().includes(c.address.slice(2).toLowerCase())));
      const code = await rpc.codeNow(c.chainId, c.address);
      return {
        ...c,
        deployBlock: rec === null ? null : hexToBigInt(rec.blockNumber).toString(),
        receiptOk: rec?.status === "0x1",
        createdAddress: created,
        gasOk: c.gas === null || rec === null ? null : Number(hexToBigInt(rec.gasUsed)) === c.gas,
        hasCode: code !== "0x" && code.length > 2,
        sourcify: await sourcifyStatus(c.chainId, c.address),
      };
    }),
  );
  const txs = await Promise.all(
    parsed.txs.map(async (t) => ({ ...t, ok: (await rpc.receipt(t.chainId, t.tx))?.status === "0x1" })),
  );
  return { contracts, txs };
}

export const loadDeployments = (): ParsedDeployments => parseDeployments(readText("docs/DEPLOYMENTS.md"));
