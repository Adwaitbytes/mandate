import { createHash } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import {
  BaseError,
  ContractFunctionRevertedError,
  createWalletClient,
  encodeFunctionData,
  type Hex,
  http,
  InsufficientFundsError,
  isHex,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { demoGovernorAbi, demoVotesTokenAbi } from "@/generated/abi";
import { chains, isChainId } from "@/lib/chains";
import { publicClient } from "@/lib/clients";
import { deployments } from "@/lib/config";
import type { ProposeError, ProposeOk } from "@/lib/propose-types";
import { buildDescription, filingFooter, sampleById } from "@/lib/samples";
import { sanitizeProposal } from "@/lib/sanitize";
import { proposeRules, pruneWindows, refundAll, takeAll } from "@/server/limits";

export const dynamic = "force-dynamic";

const fail = (body: ProposeError, status: number) => NextResponse.json(body, { status });

/** Visitors are counted by a salted hash of their address, never by the address itself. */
function visitorKey(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || request.headers.get("x-real-ip") || "unknown";
  return createHash("sha256").update(`mandate-propose:${ip}`).digest("hex").slice(0, 32);
}

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!sameOrigin(request))
    return fail({ code: "invalid", field: "request", error: "Proposals are filed from this site only" }, 403);
  const raw = await request.text();
  if (raw.length > 16_384)
    return fail({ code: "invalid", field: "request", error: "The request is too large" }, 413);
  let input: { chainId?: unknown; sample?: unknown; title?: unknown; body?: unknown };
  try {
    input = JSON.parse(raw);
  } catch {
    return fail({ code: "invalid", field: "request", error: "The request is not JSON" }, 400);
  }

  const chainId = typeof input.chainId === "number" ? input.chainId : Number.NaN;
  const target = deployments.governors.find((g) => g.chainId === chainId);
  if (!target || !isChainId(chainId))
    return fail({ code: "invalid", field: "chain", error: "Pick Base Sepolia or Unichain Sepolia" }, 400);

  // Validate the text before touching the limiter, so a typo does not cost a visitor one of their proposals.
  let title: string;
  let body: string;
  let transfer: { to: Hex | null; tokens: number };
  const ownText = input.sample === undefined || input.sample === null || input.sample === "own";
  if (ownText) {
    const clean = sanitizeProposal(input.title, input.body);
    if (!clean.ok) return fail({ code: "invalid", field: clean.field, error: clean.error }, 400);
    title = clean.title;
    body = clean.body;
    transfer = { to: null, tokens: 0 };
  } else {
    const sample = typeof input.sample === "string" ? sampleById(input.sample) : undefined;
    if (!sample) return fail({ code: "invalid", field: "sample", error: "Pick one of the samples" }, 400);
    title = sample.title;
    body = sample.body;
    transfer = { to: sample.recipient, tokens: sample.transferTokens };
  }

  if (!target.governor || !target.token) {
    return fail(
      { code: "not-deployed", error: `The demo governor on ${chains[chainId].name} is not deployed yet` },
      503,
    );
  }
  const key = process.env.DEMO_RELAYER_PK?.trim();
  if (!key) {
    return fail(
      {
        code: "relayer-unset",
        error: "This deployment has no relayer wallet, so it cannot file proposals for visitors",
      },
      503,
    );
  }
  const pk = (key.startsWith("0x") ? key : `0x${key}`) as Hex;
  if (!isHex(pk) || pk.length !== 66) {
    console.error("propose: DEMO_RELAYER_PK is not a 32-byte hex key");
    return fail({ code: "relayer-unset", error: "The relayer wallet is misconfigured" }, 503);
  }

  const rules = proposeRules(visitorKey(request));
  const limit = await takeAll(rules);
  if (!limit.allowed) {
    const retryAfterSeconds = Math.ceil(limit.retryAfterMs / 1000);
    return NextResponse.json(
      {
        code: "rate-limited",
        scope: limit.scope,
        retryAfterSeconds,
        error:
          limit.scope === "visitor"
            ? "You have filed the most proposals allowed from one address in an hour"
            : "The site has filed its hourly allowance of proposals",
      } satisfies ProposeError,
      { status: 429, headers: { "retry-after": String(retryAfterSeconds) } },
    );
  }
  if (Math.random() < 0.05) void pruneWindows().catch(() => undefined);

  const account = privateKeyToAccount(pk);
  const info = chains[chainId];
  const wallet = createWalletClient({ account, chain: info.chain, transport: http(info.rpc) });
  const reader = publicClient(chainId);
  const iso = new Date().toISOString();
  const description = buildDescription(title, body, filingFooter(iso, ownText));
  const calldata = encodeFunctionData({
    abi: demoVotesTokenAbi,
    functionName: "transfer",
    args: [transfer.to ?? account.address, parseUnits(String(transfer.tokens), 18)],
  });
  const args = [[target.token], [0n], [calldata], description] as const;

  try {
    const { result: proposalId, request: tx } = await reader.simulateContract({
      account,
      address: target.governor,
      abi: demoGovernorAbi,
      functionName: "propose",
      args,
    });
    const txHash = await wallet.writeContract(tx);
    return NextResponse.json({
      chainId,
      governor: target.governor,
      txHash,
      proposalId: proposalId.toString(),
    } satisfies ProposeOk);
  } catch (err) {
    await refundAll(rules);
    if (err instanceof BaseError && err.walk((e) => e instanceof InsufficientFundsError)) {
      return fail({ code: "relayer-empty", error: `The relayer wallet is out of ${info.name} gas` }, 503);
    }
    const revert =
      err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : null;
    const reason =
      revert instanceof ContractFunctionRevertedError
        ? (revert.data?.errorName ?? revert.shortMessage)
        : null;
    console.error("propose failed", err instanceof BaseError ? err.shortMessage : err);
    return fail(
      {
        code: "chain",
        error: reason
          ? `The governor refused the proposal: ${reason}`
          : `${info.name} did not accept the transaction`,
      },
      502,
    );
  }
}
