import { describe, expect, it } from "vitest";
import { MAX_RATIONALE_CHARS, parseModelOutput, SUPPORT_CODE, supportFromCode } from "../src/schema.ts";

const valid = {
  support: "for",
  confidence: 72,
  injection_attempt: false,
  rationale: "Routine parameter change within the mandate's limits.",
  cited_mandate_clauses: ["2"],
};

describe("parseModelOutput", () => {
  it("accepts a valid verdict", () => {
    const r = parseModelOutput(JSON.stringify(valid));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(valid);
  });

  it("accepts a verdict wrapped in a code fence or prose", () => {
    expect(parseModelOutput(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``).ok).toBe(true);
    expect(parseModelOutput(`Here is my verdict: ${JSON.stringify(valid)} Thanks.`).ok).toBe(true);
  });

  it.each([
    ["support outside the enum", { ...valid, support: "yes" }],
    ["confidence above 100", { ...valid, confidence: 101 }],
    ["negative confidence", { ...valid, confidence: -1 }],
    ["fractional confidence", { ...valid, confidence: 55.5 }],
    ["confidence as a string", { ...valid, confidence: "80" }],
    ["injection flag as a string", { ...valid, injection_attempt: "false" }],
    ["empty rationale", { ...valid, rationale: "   " }],
    ["rationale too long", { ...valid, rationale: "x".repeat(MAX_RATIONALE_CHARS + 1) }],
    ["clauses not an array", { ...valid, cited_mandate_clauses: "2" }],
    ["extra key", { ...valid, vote: "for" }],
    ["missing key", { support: "for", confidence: 1, injection_attempt: false, rationale: "r" }],
  ])("rejects %s", (_label, value) => {
    const r = parseModelOutput(JSON.stringify(value));
    expect(r.ok).toBe(false);
  });

  it("rejects text without JSON and malformed JSON", () => {
    expect(parseModelOutput("I vote for it.").ok).toBe(false);
    expect(parseModelOutput('{"support": "for",').ok).toBe(false);
    expect(parseModelOutput("").ok).toBe(false);
  });

  it("accepts a rationale of exactly the maximum length", () => {
    expect(
      parseModelOutput(JSON.stringify({ ...valid, rationale: "x".repeat(MAX_RATIONALE_CHARS) })).ok,
    ).toBe(true);
  });
});

describe("support codes", () => {
  it("match Docket.postVerdict: 0 against, 1 for, 2 abstain", () => {
    expect(SUPPORT_CODE).toEqual({ against: 0, for: 1, abstain: 2 });
    expect(supportFromCode(0)).toBe("against");
    expect(supportFromCode(1)).toBe("for");
    expect(supportFromCode(2)).toBe("abstain");
    expect(() => supportFromCode(3)).toThrow(RangeError);
  });
});
