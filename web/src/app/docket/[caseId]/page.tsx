import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CaseView } from "@/components/case/case-view";

function parse(raw: string): bigint | null {
  return /^[1-9]\d{0,30}$/.test(raw) ? BigInt(raw) : null;
}

export async function generateMetadata({ params }: PageProps<"/docket/[caseId]">): Promise<Metadata> {
  const { caseId } = await params;
  return { title: `Case ${parse(caseId) ?? ""}`.trim() };
}

export default async function CasePage({ params }: PageProps<"/docket/[caseId]">) {
  const { caseId } = await params;
  const id = parse(caseId);
  if (id === null) notFound();
  return <CaseView caseId={id} />;
}
