import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { canonicalJson, keccakBytes, keccakUtf8 } from "../src/canonical.ts";

function castAvailable(): boolean {
  try {
    execFileSync("cast", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("canonicalJson", () => {
  it("sorts keys recursively and drops whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: null, y: true }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":true,"z":null}]},"b":1}',
    );
  });

  it("is independent of insertion order", () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  it("keeps non-ASCII as raw UTF-8 and escapes control characters", () => {
    expect(canonicalJson({ s: "é\n\u0001" })).toBe('{"s":"é\\n\\u0001"}');
  });

  it("rejects floats and unsafe integers", () => {
    expect(() => canonicalJson({ n: 1.5 })).toThrow(TypeError);
    expect(() => canonicalJson({ n: 2 ** 53 })).toThrow(TypeError);
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(TypeError);
  });
});

describe("keccak hashing matches Solidity keccak256(bytes)", () => {
  // Vectors computed with `cast keccak` (Foundry), which is Solidity's keccak256 over the same bytes.
  it("hashes the empty string to the well-known value", () => {
    expect(keccakUtf8("")).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  });

  it("hashes canonical JSON bytes with a multi-byte character", () => {
    const text = canonicalJson({ b: [true, null, "é"], a: 1 });
    expect(Buffer.from(text, "utf8").toString("hex")).toBe(
      "7b2261223a312c2262223a5b747275652c6e756c6c2c22c3a9225d7d",
    );
    expect(keccakUtf8(text)).toBe("0xb484b71047b774d5acd53717bdc7e009085496674e9f052747b99c3dd1ae272e");
    expect(keccakBytes(new TextEncoder().encode(text))).toBe(keccakUtf8(text));
  });

  it.runIf(castAvailable())("agrees with cast keccak on a rationale-shaped document", () => {
    const text = canonicalJson({
      caseId: "12",
      rationale: "Ein Vorschlag, der 40 % der Kasse ausgibt, widerspricht Abschnitt 1.",
      confidenceBps: 8200,
      injectionFlag: false,
    });
    const hex = `0x${Buffer.from(text, "utf8").toString("hex")}`;
    const fromCast = execFileSync("cast", ["keccak", hex], { encoding: "utf8" }).trim();
    expect(keccakUtf8(text)).toBe(fromCast);
  });
});
