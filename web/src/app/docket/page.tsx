import type { Metadata } from "next";
import { DocketView } from "@/components/docket-view";

export const metadata: Metadata = {
  title: "Docket",
  description:
    "Cases opened from governance proposals, the three juror opinions, the weighted tally, the veto window and the cast vote.",
};

export default function DocketPage() {
  return <DocketView />;
}
