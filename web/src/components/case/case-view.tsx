"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { type Address, decodeEventLog, type Hex, isAddressEqual } from "viem";
import { demoGovernorAbi } from "@/generated/abi";
import { chainInfo, isChainId, txUrl } from "@/lib/chains";
import { publicClient } from "@/lib/clients";
import { deployments, docketReady, governorFor, jurors, VETO_CUTOFF_SECONDS } from "@/lib/config";
import { formatUtc, shortHash, shortId } from "@/lib/format";
import { type CaseDetail, type Hop, readCase, readProposal, readTrace } from "@/lib/reads";
import { displayText, splitDescription } from "@/lib/sanitize";
import { type CaseCondition, conditionLabel, conditionOf, isTerminal, OWNER_ACTION } from "@/lib/status";
import { DEFAULT_CONFIG, isSupport, type Support, supportLabel, tally } from "@/lib/tally";
import { Seal } from "../seal";
import { SealPress } from "../seal-press";
import { BackToDocket, NotDeployed, ReadError, SkeletonLines } from "../states";
import { OwnerAction, OwnerOnlyNote } from "../wallet/owner-gate";
import type { Intent } from "../wallet/owner-island";
import { LoopTrace } from "./loop-trace";
import { loadRationale, Opinion, rationaleQueryKey, toOnChain } from "./opinion";
import { Ruling } from "./ruling";
import { VetoStub } from "./veto-stub";

const DEFAULT_WINDOW = 600;

export function notDeployedList() {
  const g = deployments.governors;
  return [
    { name: "Docket", chain: "Base Sepolia", address: deployments.docket.address },
    { name: "MandateReactive", chain: "Reactive Lasna", address: deployments.reactive.address },
    ...g.map((x) => ({
      name: "Demo governor",
      chain: chainInfo(x.chainId)?.name ?? String(x.chainId),
      address: x.governor,
    })),
  ];
}

export function CaseView({ caseId }: { caseId: bigint }) {
  if (!docketReady) {
    return (
      <NotDeployed title={`Case ${caseId} cannot be read yet`} what={notDeployedList()}>
        <p>The Docket is not deployed, so there are no cases. This page fills in from chain once it is.</p>
      </NotDeployed>
    );
  }
  return <LiveCase caseId={caseId} />;
}

function CaseSkeleton({ caseId }: { caseId: bigint }) {
  return (
    <div aria-busy="true">
      <p role="status" className="visually-hidden">
        Reading case {caseId.toString()} from the Docket
      </p>
      <div className="caption">
        <div className="big" aria-hidden="true">
          {caseId.toString()}
        </div>
        <div>
          <div className="no">Case No. {caseId.toString()}</div>
          <SkeletonLines lines={2} width="min(36rem, 100%)" />
        </div>
      </div>
      <div className="opinions">
        {jurors.map((j) => (
          <section className="opinion" key={j.id}>
            <SkeletonLines lines={12} />
          </section>
        ))}
      </div>
    </div>
  );
}

function LiveCase({ caseId }: { caseId: bigint }) {
  const [terminal, setTerminal] = useState(false);
  const detail = useQuery({
    queryKey: ["case", caseId.toString()],
    queryFn: () => readCase(caseId),
    refetchInterval: terminal ? false : 8_000,
  });
  const d = detail.data;
  const proposal = useQuery({
    queryKey: ["proposal", d?.docket.originChainId, d?.docket.originTxHash],
    queryFn: () =>
      d
        ? readProposal(d.docket.originChainId, d.docket.originTxHash, d.docket.governor, d.docket.proposalId)
        : null,
    enabled: !!d,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const rs = d?.reactive.ok ? d.reactive.value.state : null;
  const condition: CaseCondition = rs ? conditionOf(rs.status, rs.hold) : "unknown";
  useEffect(() => setTerminal(isTerminal(condition)), [condition]);

  const trace = useQuery({
    queryKey: [
      "trace",
      caseId.toString(),
      rs?.status,
      rs?.dueAt,
      d?.verdicts.length,
      d?.docket.ownerAction,
      proposal.data?.timestamp,
    ],
    queryFn: () =>
      d
        ? readTrace({
            docket: d.docket,
            reactive: rs,
            vetoWindow: d.reactive.ok ? (d.reactive.value.config?.vetoWindow ?? null) : null,
            verdicts: d.verdicts,
            proposalTimestamp: proposal.data?.timestamp ?? null,
          })
        : [],
    enabled: !!d && !proposal.isPending,
  });

  if (detail.isPending) return <CaseSkeleton caseId={caseId} />;
  if (detail.isError) {
    return (
      <>
        <BackToDocket />
        <ReadError error={detail.error} retry={() => void detail.refetch()} />
      </>
    );
  }
  if (d === null || d === undefined) {
    return (
      <section className="empty" aria-labelledby="nf">
        <Seal unset />
        <h1 id="nf">There is no case {caseId.toString()} on the Docket</h1>
        <p>
          Cases are numbered by the reactive contract as proposals arrive. This number has not been used yet.
        </p>
        <div className="actions">
          <a className="btn" href="/docket">
            Open the court list
          </a>
        </div>
      </section>
    );
  }

  const cfg =
    d.reactive.ok && d.reactive.value.config
      ? d.reactive.value.config
      : { ...DEFAULT_CONFIG, vetoWindow: DEFAULT_WINDOW, caseTtl: 14 * 86_400 };
  const configIsDefault = !(d.reactive.ok && d.reactive.value.config);
  const weightsKnown = d.verdicts.every((v) => v.weight !== null);
  const overridden = (rs?.overridden ?? false) || d.docket.ownerAction === OWNER_ACTION.Override;
  const result = tally(
    d.verdicts.map((v) => ({
      support: v.support,
      confidenceBps: v.confidenceBps,
      injection: v.injectionFlag,
      weight: v.weight ?? 100,
    })),
    cfg,
    { overridden },
  );
  const decided: number | null = rs?.hasDecision ? rs.support : result.decidedSupport;
  const origin = chainInfo(d.docket.originChainId);
  const gov = governorFor(d.docket.originChainId, d.docket.governor);
  const text = proposal.data ? splitDescription(proposal.data.description) : null;
  const title = text?.title ?? `Proposal ${shortId(d.docket.proposalId)}`;
  const castHop = trace.data?.find((h) => h.key === "cast");

  return (
    <article aria-labelledby="case-title">
      <BackToDocket />
      <header className="caption">
        <div className="big" aria-hidden="true">
          {caseId.toString()}
        </div>
        <div>
          <div className="no">
            Case No. {caseId.toString()}, {conditionLabel[condition].toLowerCase()}
            {overridden && condition !== "vetoed" ? ", overridden by the owner" : ""}
          </div>
          <h1 id="case-title">In re {title}</h1>
          <div className="court">
            Proposal {shortId(d.docket.proposalId)} on {gov ? "the demo governor" : "governor"}{" "}
            <span className="hash">{shortHash(d.docket.governor)}</span>,{" "}
            {origin?.name ?? `chain ${d.docket.originChainId}`}
            {gov ? ` (${gov.clock === "timestamp" ? "timestamp" : "block number"} clock)` : ""}. Opened{" "}
            {formatUtc(d.docket.openedAt)}, judged against mandate version {d.docket.mandateVersion}.
          </div>
        </div>
      </header>

      {!d.reactive.ok ? (
        <ReadError error={new Error(d.reactive.message)} retry={() => void detail.refetch()} />
      ) : null}
      <StatusBanner detail={d} condition={condition} overridden={overridden} />

      <section className="headnote with-notes" aria-labelledby="headnote-title">
        <div>
          <h2 id="headnote-title" className="label">
            The proposal
          </h2>
          {proposal.isPending ? <SkeletonLines lines={5} width="min(44rem, 100%)" /> : null}
          {proposal.isError ? (
            <ReadError error={proposal.error} retry={() => void proposal.refetch()} />
          ) : null}
          {proposal.data === null ? (
            <p className="notice">
              The origin transaction did not contain this proposal&apos;s ProposalCreated log, so its text is
              not shown.
            </p>
          ) : null}
          {text ? (
            <div className="text">
              {text.body.length > 0 ? text.body : "The proposal has no description beyond its title."}
            </div>
          ) : null}
          <InjectionPassage detail={d} />
          <dl className="terms">
            <div>
              <dt>Voting opens</dt>
              <dd>{clockValue(d.docket.voteStart, gov?.clock)}</dd>
            </div>
            <div>
              <dt>Voting closes</dt>
              <dd>{clockValue(d.docket.voteEnd, gov?.clock)}</dd>
            </div>
            <div>
              <dt>Actions</dt>
              <dd>{proposal.data ? proposal.data.actions.length : "not read"}</dd>
            </div>
            <div>
              <dt>Proposer</dt>
              <dd className="hash">{proposal.data ? shortHash(proposal.data.proposer) : "not read"}</dd>
            </div>
          </dl>
          {proposal.data && proposal.data.actions.length > 0 ? (
            <ul className="actions-list" aria-label="On-chain actions">
              {proposal.data.actions.map((a, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: actions are positional; the same target can repeat
                <li key={`${a.target}-${i}`}>
                  {i + 1}. target <span className="hash">{shortHash(a.target)}</span>, value{" "}
                  {a.value.toString()} wei, calldata{" "}
                  <span className="hash">
                    {a.calldata.length > 74 ? `${a.calldata.slice(0, 74)}…` : a.calldata}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <aside aria-label="Notes on the proposal">
          <p className="note">
            <b>Read as data, never as instructions</b>
            Proposal text is hostile input. The jurors read it between random delimiters, and this page prints
            it as plain text with hidden and direction-changing characters removed.
          </p>
        </aside>
      </section>

      <div className="opinions">
        {jurors.map((j) => {
          const v = d.verdicts.find((x) => isAddressEqual(x.juror, j.address));
          return v ? (
            <Opinion
              key={j.id}
              caseId={caseId}
              juror={j}
              verdict={v}
              decided={decided}
              minConfidenceBps={cfg.minConfidenceBps}
            />
          ) : (
            <section className="opinion vacant" key={j.id} aria-labelledby={`vac-${j.id}`}>
              <header>
                <div className="kind">Opinion of the juror</div>
                <h2 id={`vac-${j.id}`}>{j.name}</h2>
                <div className="provenance">
                  {j.provenance}, model {j.model}
                </div>
                <div className="verdict">
                  <span className="side">Not yet</span>
                </div>
              </header>
              <p className="vacancy">
                {isTerminal(condition)
                  ? "This juror did not rule before the case closed."
                  : "Has not ruled yet. Jurors run on a schedule, about every ten minutes."}
              </p>
            </section>
          );
        })}
        {d.verdicts
          .filter((v) => !v.known)
          .map((v) => (
            <Opinion
              key={v.juror}
              caseId={caseId}
              juror={undefined}
              verdict={v}
              decided={decided}
              minConfidenceBps={cfg.minConfidenceBps}
            />
          ))}
      </div>

      <Ruling
        result={result}
        verdicts={d.verdicts}
        config={cfg}
        configIsDefault={configIsDefault}
        weightsKnown={weightsKnown}
      />

      {condition === "window" && rs && decided !== null && isSupport(decided) ? (
        <VetoStub
          caseId={caseId}
          endsAt={rs.dueAt}
          windowSeconds={cfg.vetoWindow}
          support={decided}
          chainName={origin?.name ?? "the governor's chain"}
          owner={d.owner}
        />
      ) : null}

      <CastRecord
        detail={d}
        condition={condition}
        decided={decided}
        castHop={castHop}
        originName={origin?.name ?? ""}
      />

      <section aria-labelledby="trace-title" style={{ marginTop: "2.5rem" }}>
        <h2 id="trace-title" className="label">
          The loop
        </h2>
        {trace.isPending ? <SkeletonLines lines={6} /> : null}
        {trace.isError ? <ReadError error={trace.error} retry={() => void trace.refetch()} /> : null}
        {trace.data ? <LoopTrace hops={trace.data} /> : null}
      </section>
      <p className="visually-hidden">Veto cutoff {VETO_CUTOFF_SECONDS} seconds.</p>
    </article>
  );
}

function clockValue(value: bigint, clock: "timestamp" | "blocknumber" | undefined): string {
  if (clock === "timestamp") return formatUtc(Number(value));
  return `block ${value.toLocaleString("en-GB")}`;
}

function StatusBanner({
  detail,
  condition,
  overridden,
}: {
  detail: CaseDetail;
  condition: CaseCondition;
  overridden: boolean;
}) {
  const rs = detail.reactive.ok ? detail.reactive.value.state : null;
  const [intent, setIntent] = useState<Intent | null>(null);
  const groupId = useId();
  const caseId = detail.docket.caseId;
  const ownerCanAct = detail.docket.ownerAction === OWNER_ACTION.None && !isTerminal(condition);
  const now = Math.floor(Date.now() / 1000);
  const stale =
    rs !== null &&
    !isTerminal(condition) &&
    ((rs.clock === 2 && now > Number(rs.voteEnd)) ||
      now >
        rs.createdAt +
          (detail.reactive.ok ? (detail.reactive.value.config?.caseTtl ?? 14 * 86_400) : 14 * 86_400));

  const override = (
    <fieldset
      className="choice-list"
      style={{ marginTop: "1rem", marginBottom: 0 }}
      aria-labelledby={groupId}
    >
      <legend id={groupId} className="label">
        Vote by hand
      </legend>
      <div className="segmented">
        {([1, 0, 2] as const).map((v) => (
          <label key={v}>
            <input
              type="radio"
              name={`hand-${caseId}`}
              onChange={() => setIntent({ type: "override", caseId, support: v })}
            />
            {supportLabel[v]}
          </label>
        ))}
      </div>
      {intent === null ? <OwnerOnlyNote owner={detail.owner} what="vote by hand" /> : null}
      <OwnerAction intent={intent} owner={detail.owner} />
    </fieldset>
  );

  const stamp = (word: string, body: React.ReactNode, seal = true, extra?: React.ReactNode) => (
    <div className="refused-holding" role="status">
      <span className={seal ? "stamp" : "stamp ink"}>{word}</span>
      <div>
        <p>{body}</p>
        {extra}
      </div>
    </div>
  );

  const expire = stale ? (
    <div style={{ marginTop: "0.75rem" }}>
      <p className="status" style={{ margin: 0 }}>
        This case is past its time limit. Anyone can close it on Lasna; it frees a slot for new cases.
      </p>
      <button type="button" className="text-action" onClick={() => setIntent({ type: "expire", caseId })}>
        Expire this case on Lasna
      </button>
    </div>
  ) : null;

  switch (condition) {
    case "held-injection":
      return stamp(
        "Refused",
        <>
          {rs?.injectionFlags ?? 1} injection {rs?.injectionFlags === 1 ? "flag" : "flags"} held this case, so
          no automated vote will be cast. The owner can still vote by hand before voting ends on the governor.
        </>,
        true,
        ownerCanAct ? override : expire,
      );
    case "held-split":
      return stamp(
        "Held",
        "The jurors split and this mandate holds split cases for you instead of voting. A later verdict that decides the case releases it, or you can vote by hand.",
        false,
        ownerCanAct ? override : expire,
      );
    case "vetoed":
      return stamp(
        "Vetoed",
        "You vetoed this case. No vote was cast, and every juror that ruled moved one step in weight toward or away from your reading.",
      );
    case "waiting":
      return stamp(
        "Not open",
        <>
          Voting on the governor has not opened yet, so the vote waits. Lasna asks the Delegate again at{" "}
          {rs ? formatUtc(rs.dueAt) : "its next tick"}.
        </>,
        false,
        expire,
      );
    case "expired":
      return stamp(
        "Expired",
        "Voting ended on the governor, or the case passed its time limit, before a vote could be cast. Nothing was voted.",
        false,
      );
    case "failed":
      return stamp(
        "Failed",
        "The vote request was refused or went unacknowledged after every retry. Nothing was voted. The trace below shows the last request.",
      );
    case "opening":
      return stamp(
        "Opening",
        "Lasna has asked the Docket to open this case and is waiting for the acknowledgement.",
        false,
      );
    case "unknown":
      return rs === null && detail.reactive.ok
        ? stamp(
            "Unseen",
            "The Docket has this case but Lasna does not report it yet. This clears when the next reactive transaction lands.",
            false,
          )
        : null;
    case "casting":
      return stamp(
        overridden ? "Overridden" : "Sending",
        overridden
          ? "You chose how to vote. The override skips the veto window, so the vote is on its way to the governor."
          : "The window closed without a veto. Lasna has asked your Delegate to cast the vote.",
        false,
      );
    case "cast":
      return overridden
        ? stamp(
            "Overridden",
            "You chose how this case voted. The jurors' weights moved toward those who agreed with you.",
            false,
          )
        : null;
    default:
      return expire;
  }
}

function useVoteReason(castHop: Hop | undefined, chainId: number) {
  return useQuery({
    queryKey: ["vote-reason", castHop?.txHash],
    queryFn: async () => {
      if (!castHop?.txHash || !isChainId(chainId)) return null;
      const receipt = await publicClient(chainId).getTransactionReceipt({ hash: castHop.txHash });
      for (const log of receipt.logs) {
        try {
          const ev = decodeEventLog({ abi: demoGovernorAbi, data: log.data, topics: log.topics });
          if (ev.eventName === "VoteCast") return { reason: ev.args.reason, voter: ev.args.voter as Address };
        } catch {
          // other events in the same transaction
        }
      }
      return null;
    },
    enabled: !!castHop?.txHash,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

function CastRecord({
  detail,
  condition,
  decided,
  castHop,
  originName,
}: {
  detail: CaseDetail;
  condition: CaseCondition;
  decided: number | null;
  castHop: Hop | undefined;
  originName: string;
}) {
  const reason = useVoteReason(castHop, detail.docket.originChainId);
  const supportWord =
    decided !== null && isSupport(decided) ? supportLabel[decided as Support] : "the decision";
  if (condition === "cast") {
    const url = castHop?.txHash ? txUrl(detail.docket.originChainId, castHop.txHash) : null;
    return (
      <section className="cast-record" aria-labelledby="cast-title">
        <SealPress label="Seal, vote cast" delay={0.1} />
        <div>
          <h2 id="cast-title">Case No. {detail.docket.caseId.toString()}, vote cast</h2>
          <p>
            Your Delegate voted {supportWord} on {originName} through the Reactive callback proxy.
          </p>
          {reason.data ? (
            <p className="reason">
              &ldquo;
              {reason.data.reason.split(/(0x[0-9a-fA-F]{8,})/).map((part, i) =>
                /^0x[0-9a-fA-F]{8,}$/.test(part) ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed split of one string
                  <span key={i} className="hash" style={{ fontStyle: "normal" }}>
                    {part}
                  </span>
                ) : (
                  part
                ),
              )}
              &rdquo;
            </p>
          ) : null}
          <p>
            {url && castHop?.txHash ? (
              <a href={url} target="_blank" rel="noopener noreferrer">
                Vote transaction on {originName}, {shortHash(castHop.txHash as Hex, 10, 6)}
              </a>
            ) : (
              "The vote is recorded on Lasna; its transaction on the governor's chain was not found in the scanned range."
            )}
          </p>
        </div>
      </section>
    );
  }
  if (condition === "window" || condition === "casting" || condition === "waiting") {
    return (
      <section className="cast-record" aria-labelledby="cast-title">
        <Seal unset />
        <div>
          <h2 id="cast-title">Vote to be cast</h2>
          <p className="fig">
            castVoteWithReason(proposalId, {decided ?? "?"}, reason) from your Delegate on {originName},
            through the Reactive callback proxy
          </p>
          <p>The seal presses here when the Delegate emits Cast.</p>
        </div>
      </section>
    );
  }
  return null;
}

function InjectionPassage({ detail }: { detail: CaseDetail }) {
  const flagged = detail.verdicts.find((v) => v.injectionFlag);
  const q = useQuery({
    queryKey: flagged ? rationaleQueryKey(detail.docket.caseId, flagged) : ["rationale", "none"],
    queryFn: () =>
      flagged
        ? loadRationale(detail.docket.caseId, flagged.known, toOnChain(detail.docket.caseId, flagged))
        : null,
    enabled: !!flagged,
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (!flagged) return null;
  const doc = q.data && q.data.state === "verified" ? q.data.doc : null;
  if (!doc || doc.injectionEvidence.length === 0) return null;
  return (
    <blockquote className="passage">
      <span className="from">
        The passage {flagged.known?.name ?? "a juror"} flagged as addressed to an AI voter, quoted from its
        verified opinion
      </span>
      {displayText(doc.injectionEvidence, 2000).text}
    </blockquote>
  );
}
