import { chains, txUrl } from "@/lib/chains";
import { formatUtc, gap, shortHash } from "@/lib/format";
import type { Hop, HopKey } from "@/lib/reads";

const words: Record<HopKey, { title: string; what: string }> = {
  proposed: { title: "Proposal filed", what: "ProposalCreated on the governor" },
  reacted: { title: "Seen on Lasna", what: "MandateReactive created the case and asked for it to open" },
  opened: { title: "Case opened", what: "Docket.openCase, delivered by the callback proxy" },
  verdicts: { title: "Verdicts", what: "Each juror posts from its own key" },
  tally: { title: "Tally", what: "Counted by weight in a reactive transaction" },
  window: { title: "Veto window", what: "Started by the decision; ends on Lasna time" },
  owner: { title: "Owner action", what: "From the owner's wallet" },
  requested: { title: "Vote requested", what: "Lasna asks the Delegate to cast" },
  cast: { title: "Vote cast", what: "castVoteWithReason through the Delegate" },
};

const stateWord: Record<Hop["state"], string> = {
  done: "done",
  waiting: "not yet",
  skipped: "not needed",
  unread: "happened, transaction not found in the scanned range",
};

function TxLink({ chainId, hash }: { chainId: number; hash: string }) {
  const url = txUrl(chainId, hash);
  return url ? (
    <a href={url} target="_blank" rel="noopener noreferrer" className="hash">
      {shortHash(hash, 8, 6)}
    </a>
  ) : (
    <span className="hash">{shortHash(hash, 8, 6)}</span>
  );
}

export function LoopTrace({ hops }: { hops: Hop[] }) {
  let previous: number | null = null;
  return (
    <ol className="trace" aria-label="The loop, hop by hop">
      {hops.map((h) => {
        const since = gap(previous, h.at);
        if (h.at) previous = h.at;
        const w = words[h.key];
        return (
          <li key={h.key} data-state={h.state}>
            <span className="mark" aria-hidden="true" />
            <span className="chain">{chains[h.chainId].name}</span>
            <span className="what">
              <b>
                {w.title}
                <span className="visually-hidden">, {stateWord[h.state]}</span>
              </b>
              <span>
                {h.detail ? `${w.what}: ${h.detail}` : w.what}
                {h.state !== "done" && h.state !== "waiting" ? `, ${stateWord[h.state]}` : ""}
                {h.state === "waiting" ? ", waiting" : ""}
              </span>
              {h.txHash ? (
                <span>
                  {" "}
                  <TxLink chainId={h.chainId} hash={h.txHash} />
                </span>
              ) : null}
              {h.extra.length > 0 ? (
                <ul className="sub">
                  {h.extra.map((e) => (
                    <li key={e.txHash}>
                      {e.label}: <TxLink chainId={h.chainId} hash={e.txHash} />, {formatUtc(e.at)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </span>
            <span className="when">
              {h.at ? formatUtc(h.at) : ""}
              {since ? (
                <>
                  <br />+{since}
                </>
              ) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
