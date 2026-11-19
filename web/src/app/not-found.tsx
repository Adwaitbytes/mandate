import Link from "next/link";
import { Seal } from "@/components/seal";

export default function NotFound() {
  return (
    <section className="empty" aria-labelledby="nf-title">
      <Seal unset />
      <h1 id="nf-title">Nothing is filed at this address</h1>
      <p>Case pages are numbered, such as /docket/12. Everything else is in the running head above.</p>
      <div className="actions">
        <Link className="btn" href="/docket">
          Open the docket
        </Link>
      </div>
    </section>
  );
}
