import Link from "next/link";
import { MandateLetter } from "@/components/mandate-letter";
import { jurors } from "@/lib/config";

export default function MandatePage() {
  const names = jurors.map((j) => j.short);
  return (
    <section className="title-page" aria-labelledby="hero-title">
      <div>
        <h1 id="hero-title">
          Write how your votes should be cast, once. Three jurors read every proposal against it
        </h1>
        <p className="lede">
          Each juror is a different model from a different provider. A reactive contract counts their verdicts
          by weight, gives you a veto window, then votes through your delegate on the governor&apos;s chain.
          No single model and no single key can move your vote.
        </p>
        <div className="actions">
          <Link className="btn seal" href="/docket">
            Open the docket
          </Link>
          <Link className="btn" href="/propose">
            File a test proposal
          </Link>
        </div>

        <ol className="procedure" aria-label="How a case moves">
          <li>
            <b>Filed</b>
            <span>A governor on Base Sepolia or Unichain Sepolia emits ProposalCreated</span>
          </li>
          <li>
            <b>Opened</b>
            <span>The reactive contract on Lasna opens a case on the Docket, on Base Sepolia</span>
          </li>
          <li>
            <b>Heard</b>
            <span>
              {names.slice(0, -1).join(", ")} and {names.at(-1)} each post a verdict, a confidence and the
              hash of a written rationale
            </span>
          </li>
          <li>
            <b>Veto window</b>
            <span>
              Two confident jurors agree and their side holds the weighted majority, so the veto window starts
            </span>
          </li>
          <li>
            <b>Cast</b>
            <span>No veto arrives, so your Delegate calls castVoteWithReason on the governor</span>
          </li>
        </ol>
      </div>
      <MandateLetter />
    </section>
  );
}
