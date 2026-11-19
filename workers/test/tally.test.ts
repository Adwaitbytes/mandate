import { describe, expect, it } from "vitest";
import { type Ballot, DEFAULT_TALLY, tally } from "../src/tally.ts";

const b = (support: Ballot["support"], confidenceBps = 9000, injectionFlag = false): Ballot => ({
  support,
  confidenceBps,
  injectionFlag,
  weight: 100,
});

describe("tally mirror of MandateReactive", () => {
  it("decides on a confident majority", () => {
    expect(tally([b("for"), b("for"), b("against")])).toBe("for");
  });
  it("waits below quorum", () => {
    expect(tally([b("for")])).toBe("waiting");
  });
  it("holds on any injection flag", () => {
    expect(tally([b("for"), b("for"), b("for", 9000, true)])).toBe("held-injection");
  });
  it("counts low-confidence ballots in the denominator only", () => {
    expect(tally([b("for"), b("for", 5000), b("against")])).toBe("held-split");
    expect(tally([b("for"), b("for"), b("against", 1000)])).toBe("for");
  });
  it("needs two confident ballots on a side, however heavy one juror is", () => {
    const heavy: Ballot = { ...b("for"), weight: 400 };
    expect(tally([heavy, b("against", 1000), b("abstain", 1000)])).toBe("held-split");
    expect(tally([heavy, b("for"), b("against")])).toBe("for");
  });
  it("respects a higher injection threshold", () => {
    const cfg = { ...DEFAULT_TALLY, injectionFlagsToHold: 2 };
    expect(tally([b("for", 9000, true), b("for"), b("for")], cfg)).toBe("for");
    expect(tally([b("for", 9000, true), b("for", 9000, true), b("for")], cfg)).toBe("held-injection");
  });
  it("needs strictly more than half: one each way of two is a split", () => {
    expect(tally([b("for"), b("against")])).toBe("held-split");
    expect(tally([b("for"), b("against")], { ...DEFAULT_TALLY, splitPolicy: "abstain" })).toBe("abstain");
  });
});
