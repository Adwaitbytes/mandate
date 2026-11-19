import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Hex, keccak256, toBytes } from "viem";
import { describe, expect, it } from "vitest";
import { checkRationale, fetchRationale, type OnChainVerdict, rationaleUrl } from "@/lib/rationale";

// Real documents and the hashes the jurors posted, from the anvil end-to-end run (evidence/e2e-anvil).
const evidence = join(import.meta.dirname, "..", "..", "evidence", "e2e-anvil");
const read = (path: string) => new Uint8Array(readFileSync(join(evidence, path)));

function verdictFor(caseId: string, jurorId: number): { bytes: Uint8Array; verdict: OnChainVerdict } {
  const bytes = read(`rationales/${caseId}/juror-${jurorId}.json`);
  const log = JSON.parse(
    readFileSync(join(evidence, `cases/${caseId}/verdicts/juror-${jurorId}.json`), "utf8"),
  );
  const doc = JSON.parse(new TextDecoder().decode(bytes));
  return {
    bytes,
    verdict: {
      caseId: BigInt(log.caseId),
      juror: log.juror,
      support: log.support,
      confidenceBps: log.confidenceBps,
      injectionFlag: log.injectionFlag,
      rationaleHash: log.rationaleHash as Hex,
      modelIdHash: keccak256(toBytes(doc.model)),
      promptHash: doc.promptHash as Hex,
    },
  };
}

describe("rationale hash verification", () => {
  for (const caseId of ["1", "2"]) {
    for (const jurorId of [1, 2, 3]) {
      it(`verifies case ${caseId} juror ${jurorId} against the hash it posted`, () => {
        const { bytes, verdict } = verdictFor(caseId, jurorId);
        const check = checkRationale(bytes, verdict);
        expect(check.state).toBe("verified");
        if (check.state === "verified") expect(check.discrepancies).toEqual([]);
      });
    }
  }

  it("reports a mismatch when one byte of the document changes", () => {
    const { bytes, verdict } = verdictFor("1", 1);
    const tampered = new TextEncoder().encode(
      new TextDecoder().decode(bytes).replace('"support":2', '"support":1'),
    );
    const check = checkRationale(tampered, verdict);
    expect(check.state).toBe("mismatch");
    if (check.state === "mismatch") {
      expect(check.expected).toBe(verdict.rationaleHash);
      expect(check.computed).not.toBe(verdict.rationaleHash);
      expect(check.doc?.support).toBe(1);
    }
  });

  it("does not normalise whitespace before hashing", () => {
    const { bytes, verdict } = verdictFor("1", 2);
    const pretty = new TextEncoder().encode(
      JSON.stringify(JSON.parse(new TextDecoder().decode(bytes)), null, 2),
    );
    expect(checkRationale(pretty, verdict).state).toBe("mismatch");
  });

  it("flags a correctly hashed document whose fields disagree with the verdict", () => {
    const { bytes, verdict } = verdictFor("1", 3);
    const check = checkRationale(bytes, { ...verdict, support: (verdict.support + 1) % 3 });
    expect(check.state).toBe("verified");
    if (check.state === "verified")
      expect(check.discrepancies).toContain("records a different vote than the one on chain");
  });

  it("flags a model whose hash differs from modelIdHash", () => {
    const { bytes, verdict } = verdictFor("2", 1);
    const check = checkRationale(bytes, { ...verdict, modelIdHash: keccak256(toBytes("anthropic/other")) });
    if (check.state !== "verified") throw new Error("expected verified");
    expect(check.discrepancies).toContain("names a model whose hash differs from the on-chain model id");
  });

  it("builds the store path the workers write", () => {
    expect(rationaleUrl("https://raw.example/evidence", 12n, 3)).toBe(
      "https://raw.example/evidence/rationales/12/juror-3.json",
    );
    expect(rationaleUrl("", 12n, 3)).toBeNull();
    expect(rationaleUrl("https://x", 1n, 0)).toBeNull();
  });

  it("fetches, hashes and classifies store responses", async () => {
    const { bytes, verdict } = verdictFor("2", 2);
    const ok = (async () => new Response(bytes.slice().buffer)) as unknown as typeof fetch;
    const missing = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    const failing = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect((await fetchRationale("https://x/a.json", verdict, ok)).state).toBe("verified");
    expect((await fetchRationale("https://x/a.json", verdict, missing)).state).toBe("not-found");
    expect((await fetchRationale("https://x/a.json", verdict, failing)).state).toBe("unavailable");
    expect((await fetchRationale(null, verdict, ok)).state).toBe("no-store");
  });
});
