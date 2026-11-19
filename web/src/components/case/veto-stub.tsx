"use client";

import { domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import { useEffect, useId, useState } from "react";
import type { Address } from "viem";
import { VETO_CUTOFF_SECONDS } from "@/lib/config";
import { formatClock, isoDuration, spokenDuration, windowState } from "@/lib/countdown";
import { type Support, supportLabel } from "@/lib/tally";
import { OwnerAction, OwnerOnlyNote } from "../wallet/owner-gate";
import type { Intent } from "../wallet/owner-island";

function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** The veto window as a tear-off stub. Its clock is Lasna's `dueAt` for this case; the stub closes at the cutoff. */
export function VetoStub({
  caseId,
  endsAt,
  windowSeconds,
  support,
  chainName,
  owner,
}: {
  caseId: bigint;
  endsAt: number;
  windowSeconds: number;
  support: Support;
  chainName: string;
  owner: Address;
}) {
  const now = useNow();
  const reduce = useReducedMotion();
  const s = windowState(now, endsAt, windowSeconds, VETO_CUTOFF_SECONDS);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [notOwner, setNotOwner] = useState(false);
  const groupId = useId();
  const open = s.phase === "open";
  const sideWord = supportLabel[support];

  return (
    <section className={`stub ${s.phase === "closed" ? "torn" : ""}`} aria-labelledby="stub-title">
      <span className="perf" aria-hidden="true" />
      <span className="tear" aria-hidden="true">
        {open ? "Tear here to veto" : "Stub closed"}
      </span>
      <div className="stub-grid">
        <div>
          <h2 id="stub-title">Veto window</h2>
          <p>
            {s.phase === "closed"
              ? `The window has closed. Lasna requests the vote ${sideWord} from your Delegate on its next timer tick.`
              : `If you do nothing, your Delegate votes ${sideWord} on ${chainName} when this reaches zero. A veto sent in the last ${spokenDuration(VETO_CUTOFF_SECONDS)} may reach Lasna after the vote has gone out, so the stub closes at the dashed line.`}
          </p>
        </div>
        <div className="clock">
          <time dateTime={isoDuration(s.leftSeconds)}>{formatClock(s.leftSeconds)}</time>
          <span>left of {formatClock(windowSeconds)}</span>
        </div>
      </div>

      <LazyMotion features={domAnimation} strict>
        <div className="timeline" aria-hidden="true">
          <span className="rail" />
          <m.span
            className="done"
            initial={false}
            animate={{ scaleX: s.elapsed }}
            transition={reduce ? { duration: 0 } : { duration: 1, ease: "linear" }}
          />
          <span className="cut" style={{ left: `${s.cutoff * 100}%` }} />
          <m.span
            className="now"
            initial={false}
            animate={{ left: `${s.elapsed * 100}%` }}
            transition={reduce ? { duration: 0 } : { duration: 1, ease: "linear" }}
          />
          <span className="label" style={{ left: 0 }}>
            window opened
          </span>
          <span className="label cutl" style={{ left: `${s.cutoff * 100}%` }}>
            veto stops
          </span>
          <span className="label end">vote requested</span>
        </div>
      </LazyMotion>
      <p className="visually-hidden" aria-live="polite">
        {s.phase === "closing" ? "The veto is no longer reliable; the stub has closed." : ""}
      </p>

      <div className="actions">
        <button
          type="button"
          className={notOwner ? "btn" : "btn seal"}
          disabled={!open || notOwner}
          onClick={() => {
            setChoosing(false);
            setIntent({ type: "veto", caseId });
          }}
        >
          Veto this vote
        </button>
        <button
          type="button"
          className="text-action"
          disabled={!open || notOwner}
          onClick={() => setChoosing((c) => !c)}
        >
          Vote differently
        </button>
      </div>
      {choosing && open ? (
        <fieldset className="choice-list" style={{ marginTop: "1rem" }} aria-labelledby={groupId}>
          <legend id={groupId} className="label">
            Cast this instead
          </legend>
          <div className="segmented">
            {([1, 0, 2] as const)
              .filter((v) => v !== support)
              .map((v) => (
                <label key={v}>
                  <input
                    type="radio"
                    name={`override-${caseId}`}
                    onChange={() => setIntent({ type: "override", caseId, support: v })}
                  />
                  {supportLabel[v]}
                </label>
              ))}
          </div>
        </fieldset>
      ) : null}
      {intent === null ? <OwnerOnlyNote owner={owner} what="veto or vote differently" /> : null}
      <OwnerAction intent={open ? intent : null} owner={owner} onRole={setNotOwner} />
    </section>
  );
}
