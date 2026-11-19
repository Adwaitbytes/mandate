"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { type Address, decodeEventLog, type Hex, isAddress, isHash } from "viem";
import { demoGovernorAbi } from "@/generated/abi";
import { type ChainId, chainInfo, isChainId, txUrl } from "@/lib/chains";
import { publicClient } from "@/lib/clients";
import { deployments, docketReady, reactiveReady, readyGovernors } from "@/lib/config";
import { spokenDuration } from "@/lib/countdown";
import { formatUtc, shortHash } from "@/lib/format";
import type { ProposeError, ProposeOk } from "@/lib/propose-types";
import { caseOpenedOnDocket, findCaseFor, readCase, readTrace } from "@/lib/reads";
import { samples } from "@/lib/samples";
import { BODY_MAX, BODY_MIN, TITLE_MAX } from "@/lib/sanitize";
import { LoopTrace } from "./case/loop-trace";
import { ReadError } from "./states";

interface Filed {
  chainId: ChainId;
  governor: Address;
  txHash: Hex;
  proposalId: bigint;
}

function fromParams(params: URLSearchParams): Filed | null {
  const chain = Number(params.get("chain"));
  const governor = params.get("governor") ?? "";
  const tx = params.get("tx") ?? "";
  const pid = params.get("pid") ?? "";
  if (!isChainId(chain) || !isAddress(governor) || !isHash(tx) || !/^\d{1,80}$/.test(pid)) return null;
  return { chainId: chain, governor, txHash: tx, proposalId: BigInt(pid) };
}

export function ProposeView() {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const filed = fromParams(new URLSearchParams(params.toString()));
  return (
    <>
      <div className="docket-head">
        <h1>File a proposal</h1>
        <p>
          File a real proposal on a demo governor without a wallet. The site&apos;s relayer pays the gas; you
          watch the loop run from chain to chain. Each visitor can file three an hour.
        </p>
      </div>
      {filed ? (
        <Follow filed={filed} onReset={() => router.replace(path)} />
      ) : (
        <ProposeForm
          onFiled={(f) =>
            router.replace(
              `${path}?chain=${f.chainId}&governor=${f.governor}&tx=${f.txHash}&pid=${f.proposalId.toString()}`,
            )
          }
        />
      )}
    </>
  );
}

type Failure = ProposeError | { code: "network"; error: string };

function ProposeForm({ onFiled }: { onFiled: (f: Filed) => void }) {
  const governors = deployments.governors.filter((g) => g.role === "main");
  const ready = readyGovernors();
  const [chainId, setChainId] = useState<number>(ready[0]?.chainId ?? governors[0]?.chainId ?? 84532);
  const [choice, setChoice] = useState<string>(samples[0]?.id ?? "own");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const titleId = useId();
  const bodyId = useId();
  const own = choice === "own";
  const closed = ready.length === 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      const res = await fetch("/api/propose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(own ? { chainId, sample: "own", title, body } : { chainId, sample: choice }),
      });
      const json = (await res.json()) as ProposeOk | ProposeError;
      if (!res.ok || !("txHash" in json)) {
        setFailure(json as ProposeError);
        return;
      }
      if (!isChainId(json.chainId)) throw new Error("unexpected chain");
      onFiled({
        chainId: json.chainId,
        governor: json.governor,
        txHash: json.txHash,
        proposalId: BigInt(json.proposalId),
      });
    } catch (err) {
      setFailure({ code: "network", error: err instanceof Error ? err.message : "The request failed" });
    } finally {
      setBusy(false);
    }
  };

  const fieldError = (f: string) =>
    failure?.code === "invalid" && failure.field === f ? failure.error : null;

  return (
    <form className="with-notes" style={{ marginTop: "2rem" }} onSubmit={submit} noValidate>
      <div>
        {closed ? (
          <div className="notice" role="note">
            <strong>Filing is closed until the demo governors are deployed</strong>
            <span>
              Neither demo governor has an address yet, so there is nowhere to file. The form below shows what
              you will be able to send.
            </span>
          </div>
        ) : null}
        <fieldset className="field" style={{ border: 0, padding: 0, marginTop: "1.5rem" }}>
          <legend>Governor</legend>
          <div className="segmented">
            {governors.map((g) => (
              <label key={g.chainId}>
                <input
                  type="radio"
                  name="chain"
                  value={g.chainId}
                  checked={chainId === g.chainId}
                  onChange={() => setChainId(g.chainId)}
                />
                {chainInfo(g.chainId)?.name}, {g.clock === "timestamp" ? "timestamp" : "block"} clock
              </label>
            ))}
          </div>
          <span className="hint">
            Voting opens one minute after filing and lasts thirty, counted in seconds on Base Sepolia and in
            blocks on Unichain Sepolia.
          </span>
        </fieldset>

        <fieldset className="choice-list">
          <legend className="label">What to propose</legend>
          {samples.map((s) => (
            <label className="choice" key={s.id}>
              <input
                type="radio"
                name="sample"
                value={s.id}
                checked={choice === s.id}
                onChange={() => setChoice(s.id)}
              />
              <span style={{ color: "var(--ink)", fontSize: "var(--text-body)" }}>
                <b>{s.title}</b>
                <span className={s.injection ? "flagged" : undefined}>{s.tests}</span>
              </span>
            </label>
          ))}
          <label className="choice">
            <input type="radio" name="sample" value="own" checked={own} onChange={() => setChoice("own")} />
            <span style={{ color: "var(--ink)", fontSize: "var(--text-body)" }}>
              <b>Write your own</b>
              <span>
                Any text up to {BODY_MAX.toLocaleString("en-GB")} characters, shown to the jurors as written
              </span>
            </span>
          </label>
        </fieldset>

        {own ? (
          <>
            <div className="field">
              <label htmlFor={titleId}>Title</label>
              <input
                id={titleId}
                type="text"
                value={title}
                maxLength={TITLE_MAX}
                onChange={(e) => setTitle(e.target.value)}
                aria-invalid={fieldError("title") ? true : undefined}
                aria-describedby={`${titleId}-err`}
              />
              <span id={`${titleId}-err`} className="error" role={fieldError("title") ? "alert" : undefined}>
                {fieldError("title")}
              </span>
            </div>
            <div className="field">
              <label htmlFor={bodyId}>What the proposal does</label>
              <textarea
                id={bodyId}
                value={body}
                maxLength={BODY_MAX}
                onChange={(e) => setBody(e.target.value)}
                aria-invalid={fieldError("body") ? true : undefined}
                aria-describedby={`${bodyId}-hint ${bodyId}-err`}
              />
              <span id={`${bodyId}-hint`} className="hint fig">
                {[...body].length.toLocaleString("en-GB")} of {BODY_MAX.toLocaleString("en-GB")} characters,
                at least {BODY_MIN}. Hidden and direction-changing characters are removed before filing.
              </span>
              <span id={`${bodyId}-err`} className="error" role={fieldError("body") ? "alert" : undefined}>
                {fieldError("body")}
              </span>
            </div>
          </>
        ) : null}

        <div className="actions">
          <button type="submit" className="btn seal" disabled={busy || closed}>
            {busy ? "Filing on chain" : "File this proposal"}
          </button>
        </div>
        <FailureNotice failure={failure} />
      </div>
      <aside aria-label="Notes on filing">
        <p className="note">
          <b>What gets filed</b>
          The title and text as a governor proposal with one on-chain action, a token transfer on the demo
          token, plus a line saying the site&apos;s relayer filed it. The proposal is never executed.
        </p>
        <p className="note">
          <b>Why an injection sample</b>
          Proposal text is hostile input. That sample speaks to the jurors instead of to voters; any juror
          that flags it holds the case, and it never votes on its own.
        </p>
        <p className="note">
          <b>What you will see</b>
          The proposal on its governor, the reactive transaction on Lasna, the case opening on Base Sepolia,
          three verdicts, the tally, the veto window and the cast vote, each with its transaction.
        </p>
      </aside>
    </form>
  );
}

function FailureNotice({ failure }: { failure: Failure | null }) {
  if (!failure || failure.code === "invalid") {
    return failure?.code === "invalid" && failure.field !== "title" && failure.field !== "body" ? (
      <p className="notice alert" role="alert">
        <strong>The site refused the request</strong>
        <span>{failure.error}</span>
      </p>
    ) : null;
  }
  const body: Record<Exclude<Failure["code"], "invalid">, { title: string; text: string }> = {
    "rate-limited": {
      title:
        failure.code === "rate-limited" && failure.scope === "site"
          ? "The site has reached its hourly limit"
          : "You have reached the hourly limit",
      text:
        failure.code === "rate-limited"
          ? `${failure.error}. You can file again in about ${spokenDuration(Math.min(failure.retryAfterSeconds, 3600)).replace(/ \d+ seconds?$/, "")}. The limit keeps the demo governor and the reactive contract's budget from being spent by one visitor.`
          : "",
    },
    "relayer-unset": {
      title: "Filing is switched off on this deployment",
      text: `${failure.error}. The relayer's key is set only on the hosted site, never in the repository. You can still read every case on the docket.`,
    },
    "relayer-empty": {
      title: "The relayer is out of gas",
      text: `${failure.error}. It is topped up by hand from the testnet faucets; try the other governor or come back later.`,
    },
    "not-deployed": { title: "Nothing to file on yet", text: failure.error },
    chain: {
      title: "The chain refused the proposal",
      text: `${failure.error}. Nothing was filed and your hourly allowance was not used.`,
    },
    network: {
      title: "The site did not answer",
      text: `${failure.error}. Nothing was filed. Check your connection and try again.`,
    },
  };
  const b = body[failure.code];
  return (
    <div className="notice alert" role="alert" style={{ marginTop: "1.25rem" }}>
      <strong>{b.title}</strong>
      <span>{b.text}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------

function Follow({ filed, onReset }: { filed: Filed; onReset: () => void }) {
  const info = chainInfo(filed.chainId);
  const receipt = useQuery({
    queryKey: ["filed-receipt", filed.txHash],
    queryFn: async () => {
      const client = publicClient(filed.chainId);
      const r = await client.waitForTransactionReceipt({ hash: filed.txHash, timeout: 120_000 });
      const block = await client.getBlock({ blockNumber: r.blockNumber });
      let created = false;
      for (const log of r.logs) {
        try {
          const ev = decodeEventLog({ abi: demoGovernorAbi, data: log.data, topics: log.topics });
          if (ev.eventName === "ProposalCreated" && ev.args.proposalId === filed.proposalId) created = true;
        } catch {
          // other logs
        }
      }
      return { status: r.status, at: Number(block.timestamp), created };
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: 2,
  });
  const caseId = useQuery({
    queryKey: ["case-for", filed.chainId, filed.governor, filed.proposalId.toString()],
    queryFn: () => findCaseFor(filed.chainId, filed.governor, filed.proposalId),
    enabled: reactiveReady && receipt.data?.created === true,
    refetchInterval: (q) => (q.state.data ? false : 5_000),
  });
  const id = caseId.data ?? null;
  const opened = useQuery({
    queryKey: ["opened", id?.toString()],
    queryFn: () => (id ? caseOpenedOnDocket(id) : false),
    enabled: id !== null && docketReady,
    refetchInterval: (q) => (q.state.data ? false : 5_000),
  });

  const [startedAt] = useState(() => Date.now());
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const waited = Math.round((Date.now() - startedAt) / 1000);

  const url = txUrl(filed.chainId, filed.txHash);
  return (
    <section style={{ marginTop: "2rem" }} aria-labelledby="follow-title">
      <h2 id="follow-title" className="label">
        Following your proposal
      </h2>
      <p style={{ maxWidth: "44rem" }}>
        Filed on {info?.name} by the relayer in{" "}
        {url ? (
          <a href={url} target="_blank" rel="noopener noreferrer" className="hash">
            {shortHash(filed.txHash, 10, 6)}
          </a>
        ) : (
          <span className="hash">{filed.txHash}</span>
        )}
        . This page reads each chain every five seconds; nothing here is simulated.
      </p>

      {id && opened.data ? (
        <LiveTrace caseId={id} />
      ) : (
        <ol className="trace" aria-label="The loop so far">
          <li data-state={receipt.data ? "done" : "waiting"}>
            <span className="mark" aria-hidden="true" />
            <span className="chain">{info?.name}</span>
            <span className="what">
              <b>Proposal filed</b>
              <span>
                {receipt.isError
                  ? "The transaction was not found in time; it may have been dropped"
                  : receipt.data
                    ? receipt.data.created
                      ? "ProposalCreated on the demo governor"
                      : "Included, but the governor did not emit ProposalCreated"
                    : "Waiting for inclusion"}
              </span>
            </span>
            <span className="when">{receipt.data ? formatUtc(receipt.data.at) : `${waited} s`}</span>
          </li>
          <li data-state={id ? "done" : "waiting"}>
            <span className="mark" aria-hidden="true" />
            <span className="chain">Reactive Lasna</span>
            <span className="what">
              <b>Seen on Lasna</b>
              <span>
                {!reactiveReady
                  ? "MandateReactive is not deployed, so nothing will pick this up"
                  : id
                    ? `Case ${id} created`
                    : "Waiting for the reactive contract to pick up ProposalCreated"}
              </span>
            </span>
            <span className="when" />
          </li>
          <li data-state="waiting">
            <span className="mark" aria-hidden="true" />
            <span className="chain">Base Sepolia</span>
            <span className="what">
              <b>Case opened</b>
              <span>{id ? "Waiting for Docket.openCase to arrive by callback" : "After Lasna"}</span>
            </span>
            <span className="when" />
          </li>
        </ol>
      )}
      {caseId.isError ? <ReadError error={caseId.error} retry={() => void caseId.refetch()} /> : null}
      <div className="actions" style={{ marginTop: "1.5rem" }}>
        {id ? (
          <Link className="btn seal" href={`/docket/${id}`}>
            Open case {id.toString()}
          </Link>
        ) : null}
        <button type="button" className="text-action" onClick={onReset}>
          File another
        </button>
      </div>
    </section>
  );
}

function LiveTrace({ caseId }: { caseId: bigint }) {
  const detail = useQuery({
    queryKey: ["case", caseId.toString()],
    queryFn: () => readCase(caseId),
    refetchInterval: 8_000,
  });
  const d = detail.data;
  const rs = d?.reactive.ok ? d.reactive.value.state : null;
  const trace = useQuery({
    queryKey: [
      "trace",
      caseId.toString(),
      rs?.status,
      rs?.dueAt,
      d?.verdicts.length,
      d?.docket.ownerAction,
      null,
    ],
    queryFn: () =>
      d
        ? readTrace({
            docket: d.docket,
            reactive: rs,
            vetoWindow: d.reactive.ok ? (d.reactive.value.config?.vetoWindow ?? null) : null,
            verdicts: d.verdicts,
            proposalTimestamp: null,
          })
        : [],
    enabled: !!d,
  });
  if (detail.isError) return <ReadError error={detail.error} retry={() => void detail.refetch()} />;
  if (trace.isError) return <ReadError error={trace.error} retry={() => void trace.refetch()} />;
  return trace.data ? <LoopTrace hops={trace.data} /> : <p role="status">Reading case {caseId.toString()}</p>;
}
