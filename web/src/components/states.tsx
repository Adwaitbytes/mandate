import Link from "next/link";
import { chains } from "@/lib/chains";
import { ChainReadError } from "@/lib/clients";
import { Seal } from "./seal";

/** Shown wherever a contract the page reads has no address yet. Never replaced by sample data. */
export function NotDeployed({
  title,
  what,
  children,
}: {
  title: string;
  what: { name: string; chain: string; address: string | null }[];
  children?: React.ReactNode;
}) {
  return (
    <section className="empty" aria-labelledby="nd-title">
      <Seal unset />
      <h1 id="nd-title">{title}</h1>
      {children}
      <ul className="watching" aria-label="Contracts this page reads">
        {what.map((w) => (
          <li key={`${w.name}-${w.chain}`}>
            <span>
              {w.name}, {w.chain}
            </span>
            <span className={w.address ? "hash" : undefined}>{w.address ?? "not deployed"}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function describeError(error: unknown): { chain: string | null; message: string } {
  if (error instanceof ChainReadError) {
    const chain = chains[error.chainId].name;
    const message = error.message.startsWith(`${chain}: `)
      ? error.message.slice(chain.length + 2)
      : error.message;
    return { chain, message: message.charAt(0).toUpperCase() + message.slice(1) };
  }
  return { chain: null, message: error instanceof Error ? error.message : "The read failed" };
}

/** RPC or read failure: says which chain did not answer and offers a retry. */
export function ReadError({ error, retry }: { error: unknown; retry?: () => void }) {
  const { chain, message } = describeError(error);
  return (
    <div className="notice alert" role="alert">
      <strong>{chain ? `${chain} did not answer` : "This page could not be read from chain"}</strong>
      <span>
        {message}. Public testnet endpoints rate limit and drop requests; nothing on this page is shown until
        the chain answers.
      </span>
      {retry ? (
        <span>
          <button type="button" className="text-action" onClick={retry}>
            Read again
          </button>
        </span>
      ) : null}
    </div>
  );
}

export function SkeletonLines({ lines = 3, width = "100%" }: { lines?: number; width?: string }) {
  return (
    <span aria-hidden="true" style={{ display: "block", width }}>
      {Array.from({ length: lines }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows with no identity
        <span key={i} className="skeleton" style={{ width: i === lines - 1 ? "62%" : "100%" }}>
          &nbsp;
        </span>
      ))}
    </span>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <p role="status" className="visually-hidden">
      {label}
    </p>
  );
}

export function BackToDocket() {
  return (
    <p className="back">
      <Link href="/docket">Back to the docket</Link>
    </p>
  );
}
