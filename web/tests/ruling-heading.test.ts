import { describe, expect, it } from "vitest";
import { rulingHeading } from "@/lib/status";

const base = { overridden: false, verdictsNeeded: 0 };

describe("tally heading", () => {
  it("reads Cast on a cast case, never Held", () => {
    expect(rulingHeading({ ...base, condition: "cast", decided: 0 })).toEqual({
      word: "Cast",
      text: "Against",
    });
  });

  it("names the veto", () => {
    expect(rulingHeading({ ...base, condition: "vetoed", decided: 1 }).word).toBe("Vetoed");
  });

  it("holds only held cases", () => {
    expect(rulingHeading({ ...base, condition: "held-injection", decided: null }).word).toBe("Held");
    expect(rulingHeading({ ...base, condition: "held-split", decided: null }).word).toBe("Held");
  });

  it("reports an override with the owner's side", () => {
    expect(rulingHeading({ ...base, condition: "cast", decided: 0, overridden: true })).toEqual({
      word: "Overridden",
      text: "the owner chose Against, cast",
    });
  });

  it("explains an expired decision", () => {
    expect(rulingHeading({ ...base, condition: "expired", decided: 0 }).text).toContain("voting closed");
  });

  it("counts verdicts still needed", () => {
    expect(rulingHeading({ ...base, condition: "hearing", decided: null, verdictsNeeded: 1 }).text).toBe(
      "1 more verdict needed for quorum",
    );
  });
});
