import Link from "next/link";
import { type InitialMandate, MandateLetter } from "@/components/mandate-letter";
import { docketReady, jurors } from "@/lib/config";
import { fetchMandateText, readMandates } from "@/lib/reads";

/** Rendered with the mandate read on the server and kept for a minute; the browser keeps it fresh after that. */
export const revalidate = 60;

function within<T>(ms: number, read: () => Promise<T>): Promise<T | undefined> {
  return Promise.race([
    read().catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
}

async function prefetch(): Promise<InitialMandate | undefined> {
  if (!docketReady) return undefined;
  const mandates = await within(5_000, readMandates);
  if (!mandates) return undefined;
  const current = mandates.versions[0];
  const text = current
    ? await within(3_000, () => fetchMandateText(current.uri, current.hash, { next: { revalidate: 300 } }))
    : undefined;
  return { mandates, text };
}

export default async function MandatePage() {
  const initial = await prefetch();
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
      <MandateLetter initial={initial} />
    </section>
  );
}
