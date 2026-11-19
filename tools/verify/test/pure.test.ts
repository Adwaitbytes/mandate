import assert from "node:assert/strict";
import { test } from "node:test";
import { hopsOf, kindOf } from "../../judge/lib/summary.ts";
import { parseCsv } from "../lib/csv.ts";
import { parseDeployments } from "../lib/deployments.ts";
import { checkFirstCases } from "../lib/docclaims.ts";
import { loadEvalRows, pct, recompute } from "../lib/evalcheck.ts";
import { nearestRank, stepStats } from "../lib/steps.ts";

test("parseCsv handles quoted commas, doubled quotes and a trailing newline", () => {
  const rows = parseCsv('a,b\n"x, y","say ""hi"""\n1,\n');
  assert.deepEqual(rows, [
    { a: "x, y", b: 'say "hi"' },
    { a: "1", b: "" },
  ]);
});

test("parseCsv rejects a row with the wrong number of cells", () => {
  assert.throws(() => parseCsv("a,b\n1,2,3\n"), /3 cells/);
});

test("nearestRank matches stats.py (ceil(p/100*n) - 1)", () => {
  assert.equal(nearestRank([5, 1, 3, 2, 4], 50), 3);
  assert.equal(nearestRank([5, 1, 3, 2, 4], 90), 5);
  assert.equal(nearestRank([27000, 251200], 50), 27000);
  assert.throws(() => nearestRank([], 50));
});

const baseRow = {
  label: "C01",
  governor_chain: "84532",
  proposal_ms: "1000",
  docket_open_ms: "2400",
  verdict_ms: "j1:3000 j2:4000 j3:10000",
  window_started_lasna_ms: "9000",
  window_ends_at_ms: "309000",
  cast_ms: "320000",
  override_tx: "",
  deferred_until: "",
  veto_ms: "",
};

test("stepStats subtracts a clock from itself and labels raw steps", () => {
  const steps = stepStats([baseRow]);
  const get = (step: string) => steps.find((s) => s.step === step);
  assert.equal(get("proposal -> case open on Docket")?.p50, 1400);
  assert.equal(get("case open -> third verdict (quorum 3)")?.p50, 7600);
  assert.equal(get("third verdict -> window start on Lasna")?.p50, -1000);
  assert.equal(get("window end -> cast on governor")?.p50, 11000);
  assert.equal(get("proposal -> cast (whole loop)")?.clock, "same clock, Base ms");
});

test("stepStats leaves override cases out of the whole-loop step", () => {
  const steps = stepStats([{ ...baseRow, override_tx: "0xabc" }]);
  assert.equal(
    steps.find((s) => s.step === "proposal -> cast (whole loop)"),
    undefined,
  );
});

test("kindOf classifies from what the chain recorded", () => {
  assert.equal(kindOf({ outcome: "cast for", deferred_until: "1" }), "cast after waiting for voting to open");
  assert.equal(
    kindOf({ final_status: "Held", held: "Injection", source: "sample:injection" }),
    "injection attempt held",
  );
  assert.equal(
    kindOf({ final_status: "Held", held: "Injection", source: "eval:ens:x" }),
    "held by an injection flag (false positive)",
  );
  assert.equal(kindOf({ final_status: "Expired", held: "Split" }), "split, held, then expired");
  assert.equal(
    kindOf({ final_status: "Expired", statuses: "Opening>Open>Window>Expired" }),
    "decided after voting closed, expired",
  );
  assert.equal(kindOf({ override_tx: "0x1", outcome: "cast against (owner override)" }), "owner override");
});

test("hopsOf finds the open acknowledgement by its status change", () => {
  const h = hopsOf([
    { name: "CaseCreated", tx: "0xa", args: {} },
    { name: "CaseStatusChanged", tx: "0xa", args: { status: 1 } },
    { name: "CaseStatusChanged", tx: "0xb", args: { status: 2 } },
    { name: "WindowStarted", tx: "0xc", args: {} },
    { name: "WindowStarted", tx: "0xd", args: {} },
    { name: "CastAcknowledged", tx: "0xe", args: {} },
  ]);
  assert.deepEqual(h, {
    caseCreated: "0xa",
    openAck: "0xb",
    windowStarted: "0xd",
    castDeferred: "",
    castRequested: "",
    castAck: "0xe",
  });
});

test("pct uses the model card's format", () => {
  assert.equal(pct(2, 72), "2.8% (2/72)");
  assert.equal(pct(26, 72), "36% (26/72)");
  assert.equal(pct(0, 72), "0% (0/72)");
  assert.equal(pct(1, 0), "n/a");
});

const evalCsv = [
  "dao,proposal_id,stratum,outcome,delegate_vote,mandate,j1,j1_conf,j1_flag,j2,j2_conf,j2_flag,j3,j3_conf,j3_flag,heuristic_flag,decision,title",
  'u,1,recent,passed,for,a.md,for,90,false,for,80,false,against,70,false,false,for,"t"',
  'u,1,recent,passed,for,b.md,against,90,false,against,80,false,against,70,false,false,against,"t"',
  'u,2,recent,failed,against,a.md,for,90,true,for,80,false,for,70,false,false,held-injection,"t"',
  'u,2,recent,failed,against,b.md,for,50,false,against,50,false,abstain,90,false,false,held-split,"t"',
].join("\n");

test("eval recompute re-derives the decision column with the contract's tally", () => {
  const t = recompute(loadEvalRows(evalCsv));
  assert.deepEqual(t.tallyMismatches, []);
  assert.equal(t.agreement["a.md"]?.allThree, 1);
  assert.equal(t.agreement["a.md"]?.atLeastTwo, 2);
  assert.equal(t.baseRate, "50% (1/2)");
});

test("eval recompute flags a decision the tally does not produce", () => {
  const t = recompute(loadEvalRows(evalCsv.replace("false,held-split", "false,for")));
  assert.equal(t.tallyMismatches.length, 1);
});

test("parseDeployments separates contracts, transactions and accounts", () => {
  const md = [
    "## Reactive Lasna (5318007)",
    "| Contract | Address | Deploy tx | Gas |",
    "|---|---|---|---|",
    `| MandateReactive | \`0x${"a".repeat(40)}\` | \`0x${"b".repeat(64)}\` | 5,240,036 |`,
    `| \`setDocket\` | \`0x${"c".repeat(64)}\` |`,
    "## Base Sepolia (84532)",
    "| Juror | Address | Model |",
    "|---|---|---|",
    `| 1 | \`0x${"d".repeat(40)}\` | x |`,
    "| `setGovernorLimits` x4 | `0x3a1c15de…de6d4` |",
  ].join("\n");
  const p = parseDeployments(md);
  assert.equal(p.contracts.length, 1);
  assert.equal(p.contracts[0]?.gas, 5240036);
  assert.equal(p.txs.length, 1);
  assert.equal(p.abbreviatedTxs, 1);
});

test("checkFirstCases compares abbreviated hashes and rounded timing cells", () => {
  const md = [
    "## Timing per step",
    "| Step | Clock | n | p50 | p90 | min | max |",
    "|---|---|---|---|---|---|---|",
    "| Proposal → case open on the Docket | Base ms | 1 | **1.4 s** | 1.4 s | 1.4 s | 1.5 s |",
    "## Every case",
    "| Case | No. | Source | Verdicts | Outcome | Proposal tx | Final tx |",
    "|---|---|---|---|---|---|---|",
    "| C01 | 1 | s | v | o | `0x9a61f3c3…6225` | none |",
  ].join("\n");
  const rows = [
    { ...baseRow, case_id: "1", proposal_tx: `0x9a61f3c3${"0".repeat(52)}6225`, cast_tx: "", veto_tx: "" },
  ];
  const { claims } = checkFirstCases(md, {
    rows,
    steps: stepStats(rows),
    reactiveSpentLreact: 0,
    attributedLreact: 0,
    docketSpentEth: 0,
    delegateBaseSpentEth: 0,
    delegateUnichainSpentEth: 0,
    jurorGasEth: {},
    weights: {},
    rationalesOk: 0,
    verdicts: 0,
  });
  const by = (c: string) => claims.find((x) => x.claim === c);
  assert.equal(by("timing Proposal → case open on the Docket: p50")?.ok, true);
  assert.equal(by("timing Proposal → case open on the Docket: max")?.ok, false);
  assert.equal(by("every case C01: proposal tx")?.ok, true);
  assert.equal(by("every case C01: final tx")?.ok, true);
});
