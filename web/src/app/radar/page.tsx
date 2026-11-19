import type { Metadata } from "next";
import Link from "next/link";
import { Seal } from "@/components/seal";
import { deployments, jurors } from "@/lib/config";

export const metadata: Metadata = {
  title: "Radar",
  description:
    "A read-only feed of every governance proposal on a chain, caught by one wildcard reactive subscription. Not live yet.",
};

export default function RadarPage() {
  if (deployments.radar?.address) {
    // A radar deployment would be listed in src/generated/deployments.ts; until then this branch never renders.
    return null;
  }
  return (
    <section className="empty" aria-labelledby="radar-title">
      <Seal unset />
      <h1 id="radar-title">The radar is not live yet</h1>
      <p>
        The radar is one reactive subscription per mainnet chain to the ProposalCreated topic with the
        contract left open. It catches every OpenZeppelin and Bravo governor on that chain with no indexer,
        and the three jurors write a brief on each proposal, read only.
      </p>
      <p>
        It needs a subscription cost estimate and a Reactive Mainnet budget before it is switched on, so there
        is no feed to show. This page will not show sample proposals in its place.
      </p>
      <ul className="watching" aria-label="What the radar needs">
        <li>
          <span>Radar contract, Reactive Mainnet</span>
          <span>not deployed</span>
        </li>
        <li>
          <span>Jurors that would write the briefs</span>
          <span>{jurors.map((j) => j.short).join(", ")}</span>
        </li>
      </ul>
      <div className="actions">
        <Link className="btn" href="/docket">
          Open the testnet docket
        </Link>
      </div>
    </section>
  );
}
