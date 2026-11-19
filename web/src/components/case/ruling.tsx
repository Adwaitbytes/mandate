import type { CaseConfig, VerdictRow } from "@/lib/reads";
import { percentFromBps, share, supportLabel, type TallyResult } from "@/lib/tally";

function names(verdicts: VerdictRow[], pick: (v: VerdictRow) => boolean): string {
  const list = verdicts.filter(pick).map((v) => v.known?.short ?? "unlisted juror");
  return list.length === 0 ? "none" : list.join(", ");
}

export function Ruling({
  result,
  verdicts,
  config,
  configIsDefault,
  weightsKnown,
}: {
  result: TallyResult;
  verdicts: VerdictRow[];
  config: CaseConfig;
  configIsDefault: boolean;
  weightsKnown: boolean;
}) {
  const { weights, confident, outcome } = result;
  const conf = (v: VerdictRow) => v.confidenceBps >= config.minConfidenceBps;
  const rows = [
    {
      key: "for",
      label: "For",
      weight: weights.for,
      who: names(verdicts, (v) => conf(v) && v.support === 1),
    },
    {
      key: "against",
      label: "Against",
      weight: weights.against,
      who: names(verdicts, (v) => conf(v) && v.support === 0),
    },
    {
      key: "abstain",
      label: "Abstain",
      weight: weights.abstain,
      who: names(verdicts, (v) => conf(v) && v.support === 2),
    },
    { key: "low", label: "Below floor", weight: weights.low, who: names(verdicts, (v) => !conf(v)) },
  ] as const;
  const leading =
    outcome.kind === "decided"
      ? { 0: weights.against, 1: weights.for, 2: weights.abstain }[outcome.support]
      : Math.max(weights.for, weights.against, weights.abstain);

  let holding: string;
  switch (outcome.kind) {
    case "decided":
      holding = supportLabel[outcome.support];
      break;
    case "split":
      holding = outcome.policy === "abstain" ? "Split, so the vote is abstain" : "Split, held for the owner";
      break;
    case "held-injection":
      holding = "Refused, an injection flag stops every automated vote";
      break;
    case "waiting":
      holding = `Not yet, ${outcome.verdictsNeeded} more ${outcome.verdictsNeeded === 1 ? "verdict" : "verdicts"} needed for quorum`;
      break;
  }

  const lowJurors = verdicts.filter((v) => !conf(v));
  return (
    <div className="ruling">
      <section className="disposition" aria-labelledby="tally-title">
        <h2 id="tally-title" className="label">
          Tally by weight
        </h2>
        <p className="holding">
          <strong>Held:</strong> {holding}
        </p>
        <p className="fraction">
          <span className="num">
            {leading} / {weights.total}
          </span>
          <span className="of">
            weight on the leading side, of all posted weight
            {weightsKnown ? "" : " (Lasna did not answer, so these use the default weight of 100)"}
          </span>
        </p>
        <table className="tally">
          <thead>
            <tr>
              <th scope="col">Side</th>
              <th scope="col">Jurors</th>
              <th scope="col" className="num">
                Weight
              </th>
              <th scope="col" className="num">
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <th scope="row">{r.label}</th>
                <td>{r.who}</td>
                <td className="num">{r.weight}</td>
                <td className="num">
                  {share(r.weight, weights.total)}
                  <span className="bar">
                    <i
                      className={r.key === "low" ? "low" : undefined}
                      style={{ width: share(r.weight, weights.total) }}
                    />
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Posted</td>
              <td>{verdicts.length} verdicts</td>
              <td className="num">{weights.total}</td>
              <td className="num">{weights.total > 0 ? "100%" : "0%"}</td>
            </tr>
          </tfoot>
        </table>
        <ul className="rule-check" aria-label="The contract's rules for this case">
          <li className={verdicts.length >= config.quorum ? "" : "unmet"}>
            Quorum of {config.quorum} verdicts {verdicts.length >= config.quorum ? "reached" : "not reached"},{" "}
            {verdicts.length} posted
          </li>
          <li
            className={
              Math.max(confident.for, confident.against, confident.abstain) >= config.minAgreeing
                ? ""
                : "unmet"
            }
          >
            {Math.max(confident.for, confident.against, confident.abstain)} confident jurors agree on one
            side, the minimum is {config.minAgreeing}
          </li>
          <li className={outcome.kind === "decided" ? "" : "unmet"}>
            A side needs more than {percentFromBps(config.majorityBps)} of posted weight; the leading side has{" "}
            {share(leading, weights.total)}
          </li>
          <li>Confidence floor is {percentFromBps(config.minConfidenceBps)}</li>
          <li className={result.injectionFlags >= config.injectionFlagsToHold ? "unmet" : ""}>
            {result.injectionFlags} injection {result.injectionFlags === 1 ? "flag" : "flags"};{" "}
            {config.injectionFlagsToHold} holds the case
          </li>
        </ul>
      </section>
      <aside className="notes" aria-label="Notes on the tally">
        {lowJurors.length > 0 ? (
          <p className="note">
            <b>
              Why {lowJurors.map((v) => v.known?.short ?? "one juror").join(" and ")} does not count toward a
              side
            </b>
            A verdict under the confidence floor adds to the total weight but to no side. It can block a
            majority, never carry one.
          </p>
        ) : null}
        <p className="note">
          <b>Weight can block a side, never carry it</b>A side wins only with at least {config.minAgreeing}{" "}
          confident jurors on it. A juror the owner has learned to trust weighs more, but cannot decide a case
          alone.
        </p>
        {outcome.kind === "split" ? (
          <p className="note">
            <b>What a split does</b>
            {config.splitPolicy === "hold"
              ? "This mandate holds split cases for the owner instead of voting. A later verdict that decides the case releases it."
              : "This mandate abstains on split cases, so the vote goes out as abstain after the veto window."}
          </p>
        ) : null}
        <p className="note">
          <b>Where these rules come from</b>
          {configIsDefault
            ? "Lasna did not return this case's settings, so the contract's defaults are shown."
            : "Read from caseConfig on Lasna: the settings snapshotted when this case opened, so later changes never touch it."}
        </p>
      </aside>
    </div>
  );
}
