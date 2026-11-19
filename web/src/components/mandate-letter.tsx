"use client";

import { useQuery } from "@tanstack/react-query";
import { useId, useMemo, useState } from "react";
import type { Address, Hex } from "viem";
import { addressUrl } from "@/lib/chains";
import { deployments, docketReady, draftMandate } from "@/lib/config";
import { formatUtc, shortHash } from "@/lib/format";
import {
  fetchMandateText,
  hashText,
  type MandateText as MandateTextResult,
  type MandateVersion,
  readMandates,
  resolveMandateUri,
} from "@/lib/reads";
import { MandateText } from "./mandate-text";
import { Seal } from "./seal";
import { SealPress } from "./seal-press";
import { ReadError, SkeletonLines } from "./states";
import { OwnerAction, OwnerOnlyNote } from "./wallet/owner-gate";

/** What the server read before rendering, so the letter shows without waiting for the browser's reads. */
export interface InitialMandate {
  mandates: Awaited<ReturnType<typeof readMandates>>;
  /** undefined when the server did not get the text in time. */
  text: MandateTextResult | undefined;
}

export function MandateLetter({ initial }: { initial?: InitialMandate | undefined }) {
  if (!docketReady) return <DraftLetter />;
  return <OnChainLetter initial={initial} />;
}

/** Before the Docket exists: the draft that the deployment will set, with its hash, and no seal. */
function DraftLetter() {
  return (
    <article className="letter" id="letter" aria-labelledby="letter-title">
      <header>
        <span id="letter-title" className="sc">
          Mandate, draft
        </span>
        <span>
          <span className="tag">not on chain</span> the Docket is not deployed yet
        </span>
      </header>
      <MandateText source={draftMandate.text} />
      <div className="signoff">
        <div className="signature-line">
          keccak256 of this text, which the Docket will store as the mandate hash when it is deployed
          <span className="hash">{draftMandate.hash}</span>
          <span className="check">Nothing on chain to check it against yet</span>
        </div>
        <Seal unset label="Seal, not yet set" />
      </div>
    </article>
  );
}

function LetterSkeleton() {
  return (
    <article
      className="letter"
      aria-busy="true"
      aria-label="Loading the mandate from the Docket"
      style={{ minHeight: "38rem" }}
    >
      <header>
        <span className="sc">Mandate</span>
        <span>Reading the Docket on Base Sepolia</span>
      </header>
      <SkeletonLines lines={2} />
      <div style={{ height: "1.5rem" }} />
      <SkeletonLines lines={8} />
      <div style={{ height: "1.5rem" }} />
      <SkeletonLines lines={4} />
    </article>
  );
}

function OnChainLetter({ initial }: { initial: InitialMandate | undefined }) {
  const mandates = useQuery({
    queryKey: ["mandates"],
    queryFn: readMandates,
    refetchInterval: 30_000,
    // Counted as fresh on arrival: the 30 s poll refreshes it, and an immediate refetch would only repeat the
    // server's read during page load.
    ...(initial ? { initialData: initial.mandates } : {}),
  });
  const current = mandates.data?.versions[0];
  const text = useQuery({
    queryKey: ["mandate-text", current?.uri, current?.hash],
    queryFn: () => fetchMandateText(current?.uri ?? "", current?.hash ?? "0x"),
    enabled: current !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
    // The server's copy shows at once; the browser still fetches and hashes the text itself.
    ...(initial?.text !== undefined && initial.mandates.versions[0]?.hash === current?.hash
      ? { placeholderData: initial.text }
      : {}),
  });

  if (mandates.isPending) return <LetterSkeleton />;
  if (mandates.isError) {
    return (
      <div>
        <ReadError error={mandates.error} retry={() => void mandates.refetch()} />
      </div>
    );
  }
  const { owner, versions } = mandates.data;
  if (!current) {
    return (
      <article className="letter" aria-labelledby="letter-title">
        <header>
          <span id="letter-title" className="sc">
            Mandate
          </span>
          <span>no version set</span>
        </header>
        <p>
          The Docket is deployed but its owner has not set a mandate. Jurors skip every case until there is
          one: a verdict against no mandate is worse than no verdict.
        </p>
        <div className="signoff">
          <div className="signature-line">Mandate version 0 on the Docket</div>
          <Seal unset label="Seal, not yet set" />
        </div>
        <SetMandate owner={owner} nextVersion={1} />
      </article>
    );
  }

  return (
    <div>
      <article className="letter" id="letter" aria-labelledby="letter-title">
        <header>
          <span id="letter-title" className="sc">
            Mandate, version {current.version}
          </span>
          <span>set {formatUtc(current.setAt)}</span>
        </header>
        {text.isPending ? <SkeletonLines lines={10} /> : null}
        {text.data?.state === "unavailable" ? (
          <p className="notice alert" role="alert">
            <strong>The text could not be loaded in your browser</strong>
            <span>
              {text.data.reason}. It is published at <span className="hash">{current.uri}</span>. The hash
              below is what the jurors check it against.
            </span>
          </p>
        ) : null}
        {text.data?.state === "mismatch" ? (
          <p className="notice alert" role="alert">
            <strong>This text does not match the hash on the Docket</strong>
            <span>
              The document at {current.uri} hashes to <span className="hash">{text.data.computed}</span>.
              Jurors refuse to rule against a mismatched mandate, so no case moves until the owner fixes it.
            </span>
          </p>
        ) : null}
        {text.data && text.data.state !== "unavailable" ? <MandateText source={text.data.text} /> : null}
        <div className="signoff">
          <div className="signature-line">
            keccak256 of this text, stored on the Docket as the mandate hash
            <span className="hash">{current.hash}</span>
            {text.data?.state === "verified" && text.isPlaceholderData ? (
              <span className="check">
                Checked by this site&apos;s server; checking again in your browser
              </span>
            ) : text.data?.state === "verified" ? (
              <span className="check">Checked in your browser: the text matches</span>
            ) : text.data?.state === "mismatch" ? (
              <span className="check bad">Does not match the text above</span>
            ) : (
              <span className="check">Not checked yet</span>
            )}
          </div>
          {text.data?.state === "verified" ? (
            <SealPress label="Seal, text verified against the Docket" />
          ) : (
            <Seal unset />
          )}
        </div>
      </article>
      <Versions versions={versions} />
      <SetMandate owner={owner} nextVersion={current.version + 1} />
    </div>
  );
}

function Versions({ versions }: { versions: MandateVersion[] }) {
  const docket = deployments.docket.address;
  return (
    <section className="versions" aria-labelledby="versions-title">
      <h2 id="versions-title" className="label" style={{ marginTop: "1rem" }}>
        Versions on the Docket
      </h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Version</th>
            <th scope="col">Set</th>
            <th scope="col">Hash</th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.version}>
              <td className="fig">{v.version}</td>
              <td>{formatUtc(v.setAt)}</td>
              <td className="hash">{shortHash(v.hash, 10, 8)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {docket ? (
        <p className="note" style={{ marginTop: "1rem" }}>
          <b>Why versions</b>
          Each case is judged against the version that was current when it opened, so changing the mandate
          never changes a case in flight. Read them on the{" "}
          <a href={addressUrl(84532, docket) ?? "#"} target="_blank" rel="noopener noreferrer">
            Docket contract
          </a>
          .
        </p>
      ) : null}
    </section>
  );
}

function SetMandate({ owner, nextVersion }: { owner: Address; nextVersion: number }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [uri, setUri] = useState("");
  const [intent, setIntent] = useState<{ hash: Hex; uri: string } | null>(null);
  const textId = useId();
  const uriId = useId();
  const hash = useMemo(() => (text.length > 0 ? hashText(text) : null), [text]);
  const uriOk = uri.length > 0 && resolveMandateUri(uri) !== null;

  return (
    <section className="owner-panel" aria-label="Change the mandate">
      <OwnerOnlyNote owner={owner} what="set a new version" />
      {!open ? (
        <button type="button" className="text-action" onClick={() => setOpen(true)}>
          Write a new version
        </button>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (hash && uriOk) setIntent({ hash, uri });
          }}
        >
          <div className="field">
            <label htmlFor={textId}>Text of version {nextVersion}</label>
            <textarea id={textId} value={text} onChange={(e) => setText(e.target.value)} maxLength={20_000} />
            <span className="hint hash">keccak256 {hash ?? "of nothing yet"}</span>
          </div>
          <div className="field">
            <label htmlFor={uriId}>Where the text is published</label>
            <input
              id={uriId}
              type="text"
              inputMode="url"
              value={uri}
              onChange={(e) => setUri(e.target.value.trim())}
              aria-invalid={uri.length > 0 && !uriOk}
              placeholder="https:// or ipfs://"
            />
            <span className="hint">
              Publish the exact bytes there first. Jurors fetch it and refuse to rule if its hash differs.
            </span>
          </div>
          <button type="submit" className="btn" disabled={!hash || !uriOk}>
            Review and sign
          </button>
        </form>
      )}
      <OwnerAction
        owner={owner}
        intent={intent ? { type: "set-mandate", hash: intent.hash, uri: intent.uri, nextVersion } : null}
      />
    </section>
  );
}
