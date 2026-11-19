import { describe, expect, it } from "vitest";
import { type BallotInput, DEFAULT_CONFIG, SUPPORT, type TallyConfig, tally } from "@/lib/tally";

// Vectors are the cases in contracts/test/unit/Tally.t.sol. Ballot order matches the order jurors post in each
// test; weights are 100 unless the test changed them through learning.
const { AGAINST, FOR, ABSTAIN } = SUPPORT;
const b = (support: number, confidenceBps = 9000, injection = false, weight = 100): BallotInput => ({
  support,
  confidenceBps,
  injection,
  weight,
});
const cfg = (patch: Partial<TallyConfig>): TallyConfig => ({ ...DEFAULT_CONFIG, ...patch });

describe("tally mirror of MandateReactive._tally and _onVerdict", () => {
  it("test_belowQuorum_staysOpen", () => {
    expect(tally([b(FOR)], DEFAULT_CONFIG).outcome).toEqual({ kind: "waiting", verdictsNeeded: 1 });
  });

  it("test_quorumDecisive_startsWindowWithSupport: TallyUpdated(200, 0, 0, 0, 2)", () => {
    const t = tally([b(AGAINST), b(AGAINST)], DEFAULT_CONFIG);
    expect(t.weights).toEqual({ against: 200, for: 0, abstain: 0, low: 0, total: 200 });
    expect(t.ballots).toBe(2);
    expect(t.outcome).toEqual({ kind: "decided", support: AGAINST });
  });

  it("test_quorumThree_needsThree", () => {
    const c = cfg({ quorum: 3 });
    expect(tally([b(FOR), b(FOR)], c).outcome.kind).toBe("waiting");
    expect(tally([b(FOR), b(FOR), b(FOR)], c).outcome).toEqual({ kind: "decided", support: FOR });
  });

  it("test_lowConfidence_countsTowardQuorumNotTowardSide: TallyUpdated(0, 100, 0, 100, 2), split held", () => {
    const t = tally([b(FOR, 9000), b(FOR, 5999)], DEFAULT_CONFIG);
    expect(t.weights).toEqual({ against: 0, for: 100, abstain: 0, low: 100, total: 200 });
    expect(t.outcome).toEqual({ kind: "split", policy: "hold" });
  });

  it("test_minConfidenceBoundary_isInclusive", () => {
    expect(tally([b(FOR, 6000), b(FOR, 6000)], DEFAULT_CONFIG).outcome).toEqual({
      kind: "decided",
      support: FOR,
    });
  });

  it("test_split_holdPolicy_holdsWithoutCron", () => {
    expect(tally([b(FOR), b(AGAINST)], DEFAULT_CONFIG).outcome).toEqual({ kind: "split", policy: "hold" });
  });

  it("test_split_holdPolicy_reEvaluatedWhenThirdVerdictDecides", () => {
    expect(tally([b(FOR), b(AGAINST), b(AGAINST)], DEFAULT_CONFIG).outcome).toEqual({
      kind: "decided",
      support: AGAINST,
    });
  });

  it("test_split_abstainPolicy_castsAbstain", () => {
    const t = tally([b(FOR), b(AGAINST)], cfg({ splitPolicy: "abstain" }));
    expect(t.outcome).toEqual({ kind: "split", policy: "abstain" });
    expect(t.decidedSupport).toBe(ABSTAIN);
  });

  it("test_threeWaySplit_isSplit", () => {
    expect(tally([b(FOR), b(AGAINST), b(ABSTAIN)], DEFAULT_CONFIG).outcome.kind).toBe("split");
  });

  it("test_abstainMajority_castsAbstain", () => {
    expect(tally([b(ABSTAIN), b(ABSTAIN)], DEFAULT_CONFIG).outcome).toEqual({
      kind: "decided",
      support: ABSTAIN,
    });
  });

  it("test_higherMajorityBar: 200 / 300 is not above 70%", () => {
    const t = tally([b(FOR), b(FOR), b(AGAINST)], cfg({ majorityBps: 7000, quorum: 3 }));
    expect(t.outcome).toEqual({ kind: "split", policy: "hold" });
  });

  it("test_learnedWeight_canBlockButNotCarry: 125 against 75 holds; 75 + 100 of 300 carries", () => {
    expect(tally([b(AGAINST, 9000, false, 125), b(FOR, 9000, false, 75)], DEFAULT_CONFIG).outcome.kind).toBe(
      "split",
    );
    const t = tally(
      [b(AGAINST, 9000, false, 125), b(FOR, 9000, false, 75), b(FOR, 9000, false, 100)],
      DEFAULT_CONFIG,
    );
    expect(t.weights.total).toBe(300);
    expect(t.outcome).toEqual({ kind: "decided", support: FOR });
  });

  it("test_minAgreeing_three_needsThreeOnOneSide", () => {
    const t = tally([b(FOR), b(FOR), b(ABSTAIN)], cfg({ quorum: 3, minAgreeing: 3 }));
    expect(t.outcome.kind).toBe("split");
  });

  it("test_injectionFlag_holdsBeforeQuorum_andNeverAutoVotes", () => {
    expect(tally([b(FOR, 9000, true)], DEFAULT_CONFIG).outcome).toEqual({ kind: "held-injection", flags: 1 });
    expect(tally([b(FOR, 9000, true), b(FOR), b(FOR)], DEFAULT_CONFIG).outcome.kind).toBe("held-injection");
  });

  it("test_injectionFlag_withLowConfidence_stillHolds", () => {
    expect(tally([b(ABSTAIN, 100, true)], DEFAULT_CONFIG).outcome.kind).toBe("held-injection");
  });

  it("injection threshold of 2 lets a single flag through to the tally", () => {
    const t = tally([b(FOR, 9000, true), b(FOR)], cfg({ injectionFlagsToHold: 2 }));
    expect(t.outcome).toEqual({ kind: "decided", support: FOR });
    expect(t.injectionFlags).toBe(1);
  });

  it("an owner override releases the injection hold", () => {
    const t = tally([b(FOR, 9000, true), b(FOR)], DEFAULT_CONFIG, { overridden: true });
    expect(t.outcome.kind).toBe("decided");
  });

  it("the majority test is strict: exactly half never wins", () => {
    const t = tally([b(FOR), b(FOR), b(AGAINST), b(AGAINST)], cfg({ quorum: 2 }));
    expect(t.outcome.kind).toBe("split");
  });

  it("checks sides in contract order (against, for, abstain)", () => {
    expect(tally([b(AGAINST), b(AGAINST), b(FOR)], DEFAULT_CONFIG).outcome).toEqual({
      kind: "decided",
      support: AGAINST,
    });
  });

  it("rejects support codes the contract would ignore", () => {
    expect(() => tally([b(3)], DEFAULT_CONFIG)).toThrow();
  });
});
