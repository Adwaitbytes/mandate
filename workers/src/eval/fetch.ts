import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Address,
  createPublicClient,
  decodeEventLog,
  getAddress,
  http,
  type Log,
  type PublicClient,
  parseAbi,
} from "viem";
import { mainnet } from "viem/chains";
import { PROPOSAL_CREATED_TOPIC } from "../chain/abi.ts";
import { decodeProposalCreated } from "../chain/proposal.ts";
import { intEnv, optionalEnv, REPO_DIR } from "../config.ts";
import type { DaoSpec, EvalDataset, EvalProposal, Outcome, Stratum, VoteLabel } from "./types.ts";

/**
 * Fetches real past proposals from Ethereum mainnet governors over a keyless public RPC: ProposalCreated logs
 * for the text, state() for the outcome, and VoteCast logs for the tally and the named delegate's vote.
 * Governor addresses were checked on chain: Uniswap's is Timelock(0x1a9C...35BC).admin().
 */
export const DAOS: DaoSpec[] = [
  { key: "uniswap", name: "Uniswap", governor: "0x408ED6354d4973f66138C91495F2f2FCbd8724C3", kind: "bravo" },
  {
    key: "compound",
    name: "Compound",
    governor: "0xc0Da02939E1441F497fd74F78cE7Decb17B66529",
    kind: "bravo",
  },
  { key: "ens", name: "ENS", governor: "0x323A76393544d5ecca80cd6ef2A560C6a395b7E3", kind: "oz" },
];

const DEFAULT_RPC = "https://mainnet.gateway.tenderly.co";
const VOTE_CAST_TOPIC = "0xb8e138887d0aa13bab447e82de9d5c1777041ecd21ca36ba824ff1e6c07ddda4";
const voteCastAbi = parseAbi([
  "event VoteCast(address indexed voter, uint256 proposalId, uint8 support, uint256 votes, string reason)",
]);
const governorAbi = parseAbi(["function state(uint256 proposalId) view returns (uint8)"]);
const STATE_NAMES = [
  "Pending",
  "Active",
  "Canceled",
  "Defeated",
  "Succeeded",
  "Queued",
  "Expired",
  "Executed",
];

function outcomeOf(state: string): Outcome | undefined {
  if (state === "Defeated") return "failed";
  if (state === "Succeeded" || state === "Queued" || state === "Expired" || state === "Executed")
    return "passed";
  return undefined; // Pending, Active, Canceled: no vote outcome to compare against
}

const SUPPORT: VoteLabel[] = ["against", "for", "abstain"];

async function retry<T>(label: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw new Error(`${label}: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
}

/** Raw JSON-RPC logs carry hex quantities; viem's Log type expects bigints. */
type RawLog = Omit<Log, "blockNumber"> & { blockNumber: string | null };
type MinedLog = Log & { blockNumber: bigint };

function normalizeLog(raw: RawLog): MinedLog {
  if (raw.blockNumber === null) throw new Error("pending log in a historical range");
  return { ...raw, blockNumber: BigInt(raw.blockNumber) } as MinedLog;
}

interface Vote {
  voter: Address;
  support: number;
  weight: bigint;
}

async function votesFor(
  client: PublicClient,
  governor: Address,
  proposalId: bigint,
  from: bigint,
  to: bigint,
) {
  const votes: Vote[] = [];
  const step = 200_000n;
  for (let start = from; start <= to; start += step) {
    const end = start + step - 1n < to ? start + step - 1n : to;
    const logs = (await retry(`VoteCast ${proposalId}`, () =>
      client.request({
        method: "eth_getLogs",
        params: [
          {
            address: governor,
            topics: [VOTE_CAST_TOPIC],
            fromBlock: `0x${start.toString(16)}`,
            toBlock: `0x${end.toString(16)}`,
          },
        ],
      }),
    )) as unknown as Log[];
    for (const log of logs) {
      const d = decodeEventLog({
        abi: voteCastAbi,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      if (d.args.proposalId === proposalId)
        votes.push({ voter: d.args.voter, support: d.args.support, weight: d.args.votes });
    }
  }
  return votes;
}

async function main(): Promise<void> {
  const rpc = optionalEnv("EVAL_RPC_URL") ?? DEFAULT_RPC;
  const perDao = intEnv("EVAL_PER_DAO", 20);
  const extraDefeated = intEnv("EVAL_EXTRA_DEFEATED", 5);
  const client = createPublicClient({
    chain: mainnet,
    transport: http(rpc, { timeout: 120_000 }),
  }) as PublicClient;
  const latest = await client.getBlockNumber();
  const dataset: EvalDataset = {
    fetchedAt: new Date().toISOString(),
    rpc,
    sample: `per governor: the ${perDao} most recent proposals that reached a vote outcome (stratum "recent"; Canceled, Pending and Active excluded), plus up to ${extraDefeated} older Defeated proposals (stratum "defeated-oversample"), as of block ${latest}`,
    daos: [],
    proposals: [],
  };

  for (const dao of DAOS) {
    console.log(`${dao.name}: reading ProposalCreated logs`);
    const logs = (await retry(`${dao.name} ProposalCreated`, () =>
      client.request({
        method: "eth_getLogs",
        params: [
          {
            address: dao.governor,
            topics: [PROPOSAL_CREATED_TOPIC],
            fromBlock: "0x0",
            toBlock: `0x${latest.toString(16)}`,
          },
        ],
      }),
    )) as unknown as RawLog[];
    console.log(`${dao.name}: ${logs.length} proposals on chain`);
    const ordered = logs.map(normalizeLog).sort((a, b) => (a.blockNumber < b.blockNumber ? 1 : -1));

    // Recent proposals are mostly passes, so failed ones from further back are added as a labelled stratum.
    const picked: Array<{ log: MinedLog; state: string; outcome: Outcome; stratum: Stratum }> = [];
    let recent = 0;
    let oversampled = 0;
    for (const log of ordered) {
      if (recent >= perDao && oversampled >= extraDefeated) break;
      const p = decodeProposalCreated(log);
      const code = await client
        .readContract({
          address: dao.governor,
          abi: governorAbi,
          functionName: "state",
          args: [p.proposalId],
        })
        .catch((err: unknown) => {
          // Bravo reverts state() for ids carried over from Governor Alpha; those have no outcome here.
          if (err instanceof Error && /invalid proposal id/i.test(err.message)) return undefined;
          return retry(`state ${p.proposalId}`, () =>
            client.readContract({
              address: dao.governor,
              abi: governorAbi,
              functionName: "state",
              args: [p.proposalId],
            }),
          );
        });
      if (code === undefined) continue;
      const state = STATE_NAMES[code] ?? `Unknown(${code})`;
      const outcome = outcomeOf(state);
      if (outcome === undefined) continue;
      if (recent < perDao) {
        picked.push({ log, state, outcome, stratum: "recent" });
        recent++;
      } else if (outcome === "failed" && oversampled < extraDefeated) {
        picked.push({ log, state, outcome, stratum: "defeated-oversample" });
        oversampled++;
      }
    }

    const perProposalVotes: Vote[][] = [];
    for (const { log } of picked) {
      const p = decodeProposalCreated(log);
      perProposalVotes.push(await votesFor(client, dao.governor, p.proposalId, p.voteStart, p.voteEnd + 1n));
    }

    // Named delegate: the voter who took part in the most sampled proposals and has a primary ENS name.
    const participation = new Map<Address, number>();
    for (const votes of perProposalVotes)
      for (const v of votes) participation.set(v.voter, (participation.get(v.voter) ?? 0) + 1);
    const ranked = [...participation.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
    let delegate: { address: Address; name: string; count: number } | undefined;
    for (const [address, count] of ranked) {
      const name = await retry(`ENS ${address}`, () => client.getEnsName({ address })).catch(() => null);
      if (name !== null) {
        delegate = { address: getAddress(address), name, count };
        break;
      }
    }
    if (delegate === undefined) throw new Error(`${dao.name}: no frequent voter with a primary ENS name`);
    console.log(`${dao.name}: delegate ${delegate.name} voted on ${delegate.count}/${picked.length}`);
    dataset.daos.push({
      ...dao,
      delegate: {
        address: delegate.address,
        name: delegate.name,
        participation: `${delegate.count}/${picked.length}`,
      },
    });

    picked.forEach(({ log, state, outcome, stratum }, i) => {
      const p = decodeProposalCreated(log);
      const votes = perProposalVotes[i] ?? [];
      const tally = [0n, 0n, 0n];
      for (const v of votes) tally[v.support] = (tally[v.support] ?? 0n) + v.weight;
      const mine = votes.find((v) => v.voter === delegate.address);
      const proposal: EvalProposal = {
        dao: dao.key,
        stratum,
        governor: dao.governor,
        proposalId: p.proposalId.toString(),
        proposer: p.proposer,
        createdBlock: log.blockNumber.toString(),
        txHash: log.transactionHash ?? "0x",
        voteStart: p.voteStart.toString(),
        voteEnd: p.voteEnd.toString(),
        description: p.description,
        targets: [...p.targets],
        values: p.values.map(String),
        signatures: [...p.signatures],
        calldatas: [...p.calldatas],
        state,
        outcome,
        votes: {
          against: (tally[0] ?? 0n).toString(),
          for: (tally[1] ?? 0n).toString(),
          abstain: (tally[2] ?? 0n).toString(),
        },
        delegate: {
          address: delegate.address,
          name: delegate.name,
          vote: mine === undefined ? null : (SUPPORT[mine.support] ?? null),
        },
      };
      dataset.proposals.push(proposal);
    });
  }

  const out = join(REPO_DIR, "analysis", "eval", "data", "proposals.json");
  await mkdir(join(REPO_DIR, "analysis", "eval", "data"), { recursive: true });
  await writeFile(out, `${JSON.stringify(dataset, null, 2)}\n`);
  console.log(`wrote ${dataset.proposals.length} proposals to ${out}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
