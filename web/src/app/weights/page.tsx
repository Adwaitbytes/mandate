import type { Metadata } from "next";
import { WeightsView } from "@/components/weights-view";

export const metadata: Metadata = {
  title: "Juror weights",
  description:
    "How each juror's weight moved after the owner vetoed or overrode a case, read from WeightsUpdated on Lasna.",
};

export default function WeightsPage() {
  return <WeightsView />;
}
