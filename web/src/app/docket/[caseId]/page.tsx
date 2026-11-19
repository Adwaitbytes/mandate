import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CaseView, type InitialCase } from "@/components/case/case-view";
import { docketReady } from "@/lib/config";
import { readCase, readProposal } from "@/lib/reads";

function parse(raw: string): bigint | null {
  return /^[1-9]\d{0,30}$/.test(raw) ? BigInt(raw) : null;
}

/** Rendered on first request and kept for a minute; the page keeps reading the chain in the browser after that. */
export const revalidate = 60;

export async function generateStaticParams(): Promise<{ caseId: string }[]> {
  return [];
}

/** Gives up quietly: a slow public RPC must not hold the page, the browser then reads the case itself. */
function within<T>(ms: number, read: () => Promise<T>): Promise<T | undefined> {
  return Promise.race([
    read().catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
}

async function prefetch(caseId: bigint): Promise<InitialCase | undefined> {
  if (!docketReady) return undefined;
  const detail = await within(5_000, () => readCase(caseId));
  if (detail === undefined) return undefined;
  if (detail === null) return { detail: null, proposal: undefined, at: Date.now() };
  const proposal = await within(3_000, () =>
    readProposal(
      detail.docket.originChainId,
      detail.docket.originTxHash,
      detail.docket.governor,
      detail.docket.proposalId,
    ),
  );
  return { detail, proposal, at: Date.now() };
}

export async function generateMetadata({ params }: PageProps<"/docket/[caseId]">): Promise<Metadata> {
  const { caseId } = await params;
  return { title: `Case ${parse(caseId) ?? ""}`.trim() };
}

export default async function CasePage({ params }: PageProps<"/docket/[caseId]">) {
  const { caseId } = await params;
  const id = parse(caseId);
  if (id === null) notFound();
  return <CaseView caseId={id} initial={await prefetch(id)} />;
}
