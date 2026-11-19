"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { chainInfo } from "@/lib/chains";
import { deployments, docketReady, governorFor } from "@/lib/config";
import { shortHash, shortId } from "@/lib/format";
import { type DocketRow, readDocketIndex, readProposal } from "@/lib/reads";
import { splitDescription } from "@/lib/sanitize";
import { conditionLabel, conditionOf, isTerminal, OWNER_ACTION } from "@/lib/status";
import { isSupport, supportLabel } from "@/lib/tally";
import { notDeployedList } from "./case/case-view";
import { Seal } from "./seal";
import { NotDeployed, ReadError, SkeletonLines } from "./states";

export function DocketView() {
  if (!docketReady) {
    return (
      <NotDeployed title="The docket opens when the contracts are deployed" what={notDeployedList()}>
        <p>
          Cases appear here as watched governors emit ProposalCreated. Nothing is deployed to the testnets
          yet, so there is nothing to list, and this page will not show sample cases in their place.
        </p>
      </NotDeployed>
    );
  }
  return <LiveDocket />;
}

function Head({ mandateVersion }: { mandateVersion: number | null }) {
  return (
    <div className="docket-head">
      <h1>Docket</h1>
      <p>
        Cases open when a watched governor emits ProposalCreated.
        {mandateVersion ? ` Judged against mandate version ${mandateVersion}.` : ""} Read from the Docket on
        Base Sepolia and MandateReactive on Lasna every ten seconds.
      </p>
    </div>
  );
}

function LiveDocket() {
  const index = useQuery({
    queryKey: ["docket"],
    queryFn: () => readDocketIndex(40),
    refetchInterval: 10_000,
  });
  if (index.isPending) {
    return (
      <>
        <Head mandateVersion={null} />
        <p role="status" className="visually-hidden">
          Reading the court list
        </p>
        <table className="court-list" aria-hidden="true">
          <caption className="sc">Court list</caption>
          <tbody>
            {[0, 1, 2, 3, 4].map((i) => (
              <tr key={i}>
                <td>
                  <span className="skeleton">00</span>
                </td>
                <td colSpan={4}>
                  <SkeletonLines lines={1} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    );
  }
  if (index.isError) {
    return (
      <>
        <Head mandateVersion={null} />
        <ReadError error={index.error} retry={() => void index.refetch()} />
      </>
    );
  }
  const { rows, total, mandateVersion } = index.data;
  if (total === 0) return <EmptyDocket mandateVersion={mandateVersion} />;
  const current = rows.find(
    (r) =>
      r.reactive.ok &&
      r.reactive.value &&
      !isTerminal(conditionOf(r.reactive.value.status, r.reactive.value.hold)),
  );
  const lasnaDown = rows.find((r) => !r.reactive.ok);
  return (
    <>
      <Head mandateVersion={mandateVersion} />
      {lasnaDown && !lasnaDown.reactive.ok ? (
        <ReadError
          error={new Error(`Reactive Lasna: ${lasnaDown.reactive.message}`)}
          retry={() => void index.refetch()}
        />
      ) : null}
      <table className="court-list">
        <caption className="sc">
          Court list, {total} {total === 1 ? "case" : "cases"}
          {total > rows.length ? `, latest ${rows.length} shown` : ""}
        </caption>
        <thead>
          <tr>
            <th scope="col">No.</th>
            <th scope="col">Case</th>
            <th scope="col">Governor</th>
            <th scope="col">Status</th>
            <th scope="col">Disposition</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Row key={r.docket.caseId.toString()} row={r} current={r === current} />
          ))}
        </tbody>
      </table>
    </>
  );
}

function disposition(row: DocketRow): { text: string; refused: boolean } {
  if (!row.reactive.ok) return { text: "Lasna did not answer", refused: false };
  const s = row.reactive.value;
  if (!s) return { text: "Waiting for Lasna", refused: false };
  const c = conditionOf(s.status, s.hold);
  const side = isSupport(s.support) ? supportLabel[s.support] : "";
  if (row.docket.ownerAction === OWNER_ACTION.Override && isSupport(row.docket.overrideSupport)) {
    return { text: `${supportLabel[row.docket.overrideSupport]}, overridden by you`, refused: false };
  }
  switch (c) {
    case "held-injection":
      return { text: "Refused, no automated vote", refused: true };
    case "held-split":
      return { text: "Split, waiting for you", refused: false };
    case "window":
      return { text: `${side}, unless vetoed`, refused: false };
    case "waiting":
    case "casting":
      return { text: `${side}, on its way`, refused: false };
    case "cast":
      return { text: `${side}, cast`, refused: false };
    case "vetoed":
      return { text: "No vote cast", refused: false };
    case "expired":
    case "failed":
      return { text: "No vote cast", refused: false };
    default:
      return { text: "Awaiting verdicts", refused: false };
  }
}

function Row({ row, current }: { row: DocketRow; current: boolean }) {
  const d = row.docket;
  const proposal = useQuery({
    queryKey: ["proposal", d.originChainId, d.originTxHash],
    queryFn: () => readProposal(d.originChainId, d.originTxHash, d.governor, d.proposalId),
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });
  const s = row.reactive.ok ? row.reactive.value : null;
  const condition = s ? conditionOf(s.status, s.hold) : "unknown";
  const disp = disposition(row);
  const gov = governorFor(d.originChainId, d.governor);
  const chain = chainInfo(d.originChainId)?.name ?? `chain ${d.originChainId}`;
  const title = proposal.data ? splitDescription(proposal.data.description).title : null;
  return (
    <tr aria-current={current ? "true" : undefined}>
      <td>{d.caseId.toString()}</td>
      <td data-label="Case">
        <Link href={`/docket/${d.caseId}`}>
          {title ??
            (proposal.isPending ? `Proposal ${shortId(d.proposalId)}` : `Proposal ${shortId(d.proposalId)}`)}
        </Link>{" "}
        <span className="muted">({d.verdictCount} of 3 verdicts)</span>
      </td>
      <td data-label="Governor">
        {gov ? "Demo" : <span className="hash">{shortHash(d.governor)}</span>}, {chain}
      </td>
      <td data-label="Status">{conditionLabel[condition]}</td>
      <td data-label="Disposition" className={disp.refused ? "refused" : undefined}>
        {disp.text}
      </td>
    </tr>
  );
}

function EmptyDocket({ mandateVersion }: { mandateVersion: number }) {
  return (
    <section className="empty" aria-labelledby="empty-title">
      <Seal unset />
      <h1 id="empty-title">No cases yet</h1>
      <p>
        The Docket is deployed and listening. A case opens here a few seconds after a watched governor emits
        ProposalCreated, and the jurors rule on it on their next run.
        {mandateVersion === 0
          ? " The owner has not set a mandate yet, so jurors will skip cases until there is one."
          : ""}
      </p>
      <div className="actions">
        <Link className="btn seal" href="/propose">
          File a test proposal
        </Link>
      </div>
      <ul className="watching" aria-label="Watched governors">
        {deployments.governors.map((g) => (
          <li key={g.chainId}>
            <span>
              Demo governor, {chainInfo(g.chainId)?.name},{" "}
              {g.clock === "timestamp" ? "timestamp" : "block number"} clock
            </span>
            <span className="hash">{g.governor ? shortHash(g.governor) : "not deployed"}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
