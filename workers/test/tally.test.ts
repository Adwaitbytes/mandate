import { describe, expect, it } from "vitest";
import { type Ballot, tally } from "../src/tally.ts";

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
  it("needs strictly more than half: one each way of two is a split", () => {
    expect(tally([b("for"), b("against")])).toBe("held-split");
    expect(
      tally([b("for"), b("against")], {
        quorum: 2,
        minConfidenceBps: 6000,
        majorityBps: 5000,
        splitPolicy: "abstain",
      }),
    ).toBe("abstain");
  });
});
