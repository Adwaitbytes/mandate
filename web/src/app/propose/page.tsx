import type { Metadata } from "next";
import { Suspense } from "react";
import { ProposeView } from "@/components/propose-view";

export const metadata: Metadata = {
  title: "File a proposal",
  description:
    "File a real proposal on a demo governor without a wallet and follow the loop from chain to chain.",
};

export default function ProposePage() {
  return (
    <Suspense fallback={null}>
      <ProposeView />
    </Suspense>
  );
}
