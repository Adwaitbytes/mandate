import { describe, expect, it } from "vitest";
import { evidenceIndex } from "@/generated/evidence";
import { jurorRoster, jurors } from "@/lib/config";
import { answeredBy, answeredLine, modelHash, withPassedOver } from "@/lib/models";

const juror3 = {
  chain: ["google/gemini-flash-latest", "groq/qwen/qwen3.8-27b"],
  live: ["ollama/qwen3.5:2b"],
};

describe("which model answered a verdict", () => {
  it("names the primary model", () => {
    const a = answeredBy(juror3, modelHash("google/gemini-flash-latest"));
    expect(a.kind).toBe("primary");
    expect(answeredLine(a)).toBe("Answered by Gemini Flash, Google Gemini API");
  });

  it("names a fallback honestly instead of calling it a mismatch", () => {
    const a = answeredBy(juror3, modelHash("groq/qwen/qwen3.8-27b"));
    expect(a.kind).toBe("fallback");
    expect(answeredLine(a)).toContain("Answered by Qwen 3.8 27B, fallback for Gemini Flash");
  });

  it("counts a model the juror answered with in the live run as a fallback", () => {
    expect(answeredBy(juror3, modelHash("ollama/qwen3.5:2b")).kind).toBe("fallback");
  });

  it("accepts a model named by a verified rationale only when its hash matches", () => {
    const hash = modelHash("groq/llama-9-70b");
    expect(answeredBy(juror3, hash, "groq/llama-9-70b").kind).toBe("named");
    expect(answeredBy(juror3, hash, "groq/other").kind).toBe("unknown");
    expect(answeredBy(juror3, hash).kind).toBe("unknown");
  });

  it("recognises every model recorded in the live evidence for its juror", () => {
    // verdict_models in evidence/cases.csv is the ground truth the generated live lists come from.
    for (const j of jurors) {
      for (const id of j.models.live) expect(answeredBy(j.models, modelHash(id)).kind).not.toBe("unknown");
    }
    expect(jurors.find((j) => j.id === 3)?.models.live).toContain("groq/qwen/qwen3.8-27b");
  });

  it("lists the fallbacks in the roster", () => {
    const j2 = jurors.find((j) => j.id === 2);
    expect(j2 && jurorRoster(j2)).toMatch(/^gpt-oss-120b, falling back to gpt-oss-20b \(Pollinations\)/);
  });
});

describe("evidence index", () => {
  it("holds the recorded cast of case 4 and its Docket", () => {
    expect(evidenceIndex.docket).toBe("0xE48a9dFdDBb8dD3bDE49a06d1113DaB58599F40c");
    expect(evidenceIndex.cases["4"].cast).toBe(
      "0x0d950ad59a6345a09a4bcc8f351b769d6de2c2ad36dd0d7c1df981d5ff3eee90",
    );
  });
});

describe("providerFallbacks from a rationale", () => {
  it("names the models passed over, key slots stripped", () => {
    const j2 = {
      chain: ["groq/openai/gpt-oss-120b", "pollinations/openai-fast", "groq/openai/gpt-oss-20b"],
      live: [],
    };
    const a = withPassedOver(answeredBy(j2, modelHash("groq/openai/gpt-oss-20b")), [
      "groq/openai/gpt-oss-120b: circuit open 40 s more (429)",
      "pollinations/openai-fast#1: completion budget spent",
    ]);
    expect(answeredLine(a)).toContain(
      "Answered by gpt-oss-20b (Groq), fallback for gpt-oss-120b and gpt-oss-20b (Pollinations)",
    );
  });

  it("leaves an answer alone when nothing was passed over", () => {
    const a = answeredBy(juror3, modelHash("google/gemini-flash-latest"));
    expect(withPassedOver(a, [])).toBe(a);
  });
});
