"use client";

import { useQuery } from "@tanstack/react-query";
import type { Juror } from "@/lib/config";
import { promptHash as committedPromptHash, rationaleBaseUrl } from "@/lib/config";
import { formatUtc, shortHash } from "@/lib/format";
import { type AnsweredBy, answeredBy, answeredLine, withPassedOver } from "@/lib/models";
import { checkRationale, type OnChainVerdict, type RationaleFetch, rationaleUrl } from "@/lib/rationale";
import type { VerdictRow } from "@/lib/reads";
import { displayText } from "@/lib/sanitize";
import { isSupport, percentFromBps, supportLabel } from "@/lib/tally";
import { SkeletonLines } from "../states";

/**
 * Loads the rationale through the site's cache route first and straight from the public store second. Either
 * way the bytes are hashed here, in the browser, against the rationaleHash on chain. A mismatch from the cache
 * is retried against the store before it is reported, so a stale cache row cannot cause a false alarm.
 */
export async function loadRationale(
  caseId: bigint,
  juror: Juror | undefined,
  verdict: OnChainVerdict,
): Promise<RationaleFetch> {
  if (!juror) return { state: "no-store" };
  const direct = rationaleUrl(rationaleBaseUrl, caseId, juror.id);
  if (direct === null) return { state: "no-store" };
  try {
    const res = await fetch(`/api/rationale?case=${caseId}&juror=${juror.id}`, { cache: "no-store" });
    if (res.ok) {
      const check = checkRationale(new Uint8Array(await res.arrayBuffer()), verdict);
      if (check.state === "verified" || res.headers.get("x-mandate-source") === "store") return check;
    } else if (res.status === 404) {
      return { state: "not-found", url: direct };
    }
  } catch {
    // The cache route is an optimisation; fall through to the store.
  }
  try {
    const res = await fetch(direct, { cache: "no-store" });
    if (res.status === 404) return { state: "not-found", url: direct };
    if (!res.ok) return { state: "unavailable", url: direct, reason: `HTTP ${res.status}` };
    return checkRationale(new Uint8Array(await res.arrayBuffer()), verdict);
  } catch (err) {
    return {
      state: "unavailable",
      url: direct,
      reason: err instanceof Error ? err.message : "network error",
    };
  }
}

export function toOnChain(caseId: bigint, verdict: VerdictRow): OnChainVerdict {
  return {
    caseId,
    juror: verdict.juror,
    support: verdict.support,
    confidenceBps: verdict.confidenceBps,
    injectionFlag: verdict.injectionFlag,
    rationaleHash: verdict.rationaleHash,
    modelIdHash: verdict.modelIdHash,
    promptHash: verdict.promptHash,
  };
}

export function rationaleQueryKey(caseId: bigint, verdict: VerdictRow) {
  return ["rationale", caseId.toString(), verdict.juror, verdict.rationaleHash] as const;
}

function kindOf(support: number, decided: number | null): string {
  if (decided === null) return "Opinion of the juror";
  if (support === decided) return "Opinion of the juror, concurring";
  if (support === 2) return "Opinion of the juror, abstaining";
  return "Opinion of the juror, dissenting";
}

export function Opinion({
  caseId,
  juror,
  verdict,
  decided,
  minConfidenceBps,
}: {
  caseId: bigint;
  juror: Juror | undefined;
  verdict: VerdictRow;
  decided: number | null;
  minConfidenceBps: number;
}) {
  const onChain = toOnChain(caseId, verdict);
  const rationale = useQuery({
    queryKey: rationaleQueryKey(caseId, verdict),
    queryFn: () => loadRationale(caseId, juror, onChain),
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });

  const promptMatches = verdict.promptHash.toLowerCase() === committedPromptHash.toLowerCase();
  const below = verdict.confidenceBps < minConfidenceBps;
  const side = isSupport(verdict.support) ? supportLabel[verdict.support] : `support ${verdict.support}`;
  const headingId = `op-${verdict.juror}`;
  const r = rationale.data;
  const doc = r && (r.state === "verified" || r.state === "mismatch") ? r.doc : null;
  // Only a document whose hash matches the chain may name the model; a mismatched one proves nothing.
  const fromHash =
    verdict.answered.kind === "unknown" && juror && r?.state === "verified"
      ? answeredBy(juror.models, verdict.modelIdHash, r.doc.model)
      : verdict.answered;
  const answered = r?.state === "verified" ? withPassedOver(fromHash, r.doc.providerFallbacks) : fromHash;

  return (
    <section className="opinion" aria-labelledby={headingId} data-seal={r?.state}>
      <header>
        <div className="kind">{kindOf(verdict.support, decided)}</div>
        <h2 id={headingId}>
          {answered.kind === "unknown"
            ? juror
              ? `Juror ${juror.id}`
              : "Unlisted juror"
            : answered.model.name}
        </h2>
        <div className="provenance">
          {juror ? (
            <>
              Juror {juror.id}. {answeredLine(answered)}
              {answered.kind === "unknown" ? (
                ""
              ) : (
                <>
                  , model <span className="model-id">{answered.id}</span>
                </>
              )}
            </>
          ) : (
            <span className="hash">{verdict.juror}</span>
          )}
        </div>
        <div className="verdict">
          <span className="side">{side}</span>
          <span className="conf">
            confidence {percentFromBps(verdict.confidenceBps)}
            {below ? `, below the ${percentFromBps(minConfidenceBps)} floor` : ""}
          </span>
          {verdict.injectionFlag ? <span className="flag">Injection flagged</span> : null}
        </div>
      </header>

      <div className="opinion-main">
        <RationaleSeal result={r} pending={rationale.isPending} />

        <div className="body">
          {rationale.isPending ? <SkeletonLines lines={7} /> : null}
          {doc
            ? displayText(doc.rationale, 6000)
                .text.split(/\n{2,}/)
                .map((p, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs of one fixed document
                  <p key={i}>{p}</p>
                ))
            : null}
          {r && (r.state === "not-found" || r.state === "unavailable" || r.state === "no-store") ? (
            <p className="vacancy" style={{ fontStyle: "italic", color: "var(--ink-3)" }}>
              The written opinion is not shown because it could not be loaded. The verdict above is on chain
              either way.
            </p>
          ) : null}
        </div>

        <footer>
          <dl>
            {doc && doc.citedMandateClauses.length > 0 ? (
              <>
                <dt>Cites</dt>
                <dd>
                  {doc.citedMandateClauses
                    .map((c) => /^(\d+)\./.exec(c)?.[1] ?? "")
                    .filter(Boolean)
                    .join(", ") || "none"}
                </dd>
              </>
            ) : null}
            <dt>Injection</dt>
            <dd>
              {verdict.injectionFlag
                ? doc?.injectionEvidence
                  ? "flagged, passage quoted above"
                  : "flagged"
                : "none found"}
            </dd>
            <dt>Posted</dt>
            <dd>{formatUtc(verdict.postedAt)}</dd>
            <dt>Model id</dt>
            <dd>
              <span className="hash">{shortHash(verdict.modelIdHash)}</span>
              {modelNote(answered)}
            </dd>
            {doc?.servedModel ? (
              <>
                <dt>Served as</dt>
                <dd>{displayText(doc.servedModel, 120).text}</dd>
              </>
            ) : null}
            {doc && doc.providerFallbacks.length > 0 ? (
              <>
                <dt>Passed over</dt>
                <dd>{doc.providerFallbacks.map((f) => displayText(f, 240).text).join("; ")}</dd>
              </>
            ) : null}
            <dt>Prompt</dt>
            <dd>
              <span className="hash">{shortHash(verdict.promptHash)}</span>
              {promptMatches ? ", juror.v1.md" : ", not the committed prompt"}
            </dd>
            <dt>Rationale</dt>
            <dd className="hash">{shortHash(verdict.rationaleHash)}</dd>
            {verdict.weight !== null ? (
              <>
                <dt>Weight</dt>
                <dd className="fig">{verdict.weight}</dd>
              </>
            ) : null}
          </dl>
        </footer>
      </div>
    </section>
  );
}

function modelNote(a: AnsweredBy): string {
  switch (a.kind) {
    case "primary":
      return `, ${a.id}, the juror's primary model`;
    case "fallback":
      return `, ${a.id}, a fallback in the juror's provider chain`;
    case "named":
      return `, ${a.id}, as named in the verified opinion`;
    case "unknown":
      return ", not a model this site lists for the juror";
  }
}

function RationaleSeal({ result, pending }: { result: RationaleFetch | undefined; pending: boolean }) {
  if (pending || !result) {
    return (
      <p className="seal-check" role="status">
        Fetching the written opinion and checking its hash
      </p>
    );
  }
  switch (result.state) {
    case "verified":
      return (
        <p className="seal-check">
          Written opinion matches the hash on chain{result.discrepancies.length > 0 ? ", but it " : ""}
          {result.discrepancies.join(", ")}
        </p>
      );
    case "mismatch":
      return (
        <div className="seal-check bad" role="alert">
          <b>Hash mismatch.</b> The published opinion is not the one this juror posted. It hashes to
          <span className="hash">{result.computed}</span>
          but the Docket holds
          <span className="hash">{result.expected}</span>
          The text below is shown so you can see what changed; do not rely on it.
        </div>
      );
    case "unreadable":
      return (
        <p className="seal-check bad" role="alert">
          <b>Hash matches but the document cannot be read:</b> {result.reason}
        </p>
      );
    case "not-found":
      return (
        <p className="seal-check">
          The written opinion is not published yet at <span className="hash">{result.url}</span>
        </p>
      );
    case "unavailable":
      return (
        <p className="seal-check">
          The rationale store did not answer ({result.reason}). Only the hash is on chain; the text lives in
          the store.
        </p>
      );
    case "no-store":
      return (
        <p className="seal-check">
          This site has no rationale store configured, so only the verdict and its hash are shown
        </p>
      );
  }
}
