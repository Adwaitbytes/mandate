import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPublicClient, http, type Log, type PublicClient } from "viem";
import { mainnet } from "viem/chains";
import { PROPOSAL_CREATED_TOPIC } from "../chain/abi.ts";
import { decodeProposalCreated } from "../chain/proposal.ts";
import { optionalEnv } from "../config.ts";
import { detectInjection } from "../injection.ts";
import { renderProposal } from "../proposal.ts";
import { DAOS } from "./daos.ts";
import { EVAL_DIR } from "./shared.ts";

/**
 * False-positive check for the injection pre-filter on every proposal these three governors ever emitted (no
 * model calls). None is known to target AI voters, so each flag is treated as a false positive. Writes
 * data/heuristic-corpus.json, which the model card reads.
 */
async function main(): Promise<void> {
  const rpc = optionalEnv("EVAL_RPC_URL") ?? "https://mainnet.gateway.tenderly.co";
  const client = createPublicClient({
    chain: mainnet,
    transport: http(rpc, { timeout: 120_000 }),
  }) as PublicClient;
  const latest = await client.getBlockNumber();
  const perDao: Array<{ dao: string; proposals: number; flagged: number }> = [];
  const hits: Array<{ dao: string; proposalId: string; title: string; rules: string[]; excerpts: string[] }> =
    [];
  for (const dao of DAOS) {
    const logs = (await client.request({
      method: "eth_getLogs",
      params: [
        {
          address: dao.governor,
          topics: [PROPOSAL_CREATED_TOPIC],
          fromBlock: "0x0",
          toBlock: `0x${latest.toString(16)}`,
        },
      ],
    })) as unknown as Log[];
    let flagged = 0;
    for (const log of logs) {
      const p = decodeProposalCreated(log);
      const report = detectInjection(renderProposal(p));
      if (!report.flagged) continue;
      flagged++;
      hits.push({
        dao: dao.key,
        proposalId: p.proposalId.toString(),
        title: (p.description.split("\n").find((l) => l.trim() !== "") ?? "")
          .replace(/^#+\s*/, "")
          .slice(0, 100),
        rules: report.matches.map((m) => m.rule),
        excerpts: report.matches.map((m) => m.excerpt),
      });
    }
    perDao.push({ dao: dao.key, proposals: logs.length, flagged });
    console.log(`${dao.name}: ${flagged}/${logs.length} flagged`);
  }
  await writeFile(
    join(EVAL_DIR, "data", "heuristic-corpus.json"),
    `${JSON.stringify({ fetchedAt: new Date().toISOString(), rpc, block: latest.toString(), perDao, hits }, null, 2)}\n`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
