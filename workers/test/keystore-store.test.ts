import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { keccakUtf8 } from "../src/canonical.ts";
import { decryptKeystore } from "../src/chain/keystore.ts";
import { MandateMismatchError, verifyMandate } from "../src/chain/mandate.ts";
import { FileCheckpoint } from "../src/checkpoint.ts";
import { evidencePaths, RepoEvidenceStore } from "../src/store.ts";

const fixture = resolve(import.meta.dirname, "fixtures", "anvil0.keystore.json");

describe("decryptKeystore", () => {
  // Fixture: Foundry keystore of anvil's public test key 0, password "fixture-password".
  it("decrypts a Foundry keystore to the right account", async () => {
    const key = await decryptKeystore(await readFile(fixture, "utf8"), "fixture-password");
    expect(privateKeyToAccount(key).address).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  });

  it("rejects a wrong password via the MAC", async () => {
    await expect(decryptKeystore(await readFile(fixture, "utf8"), "wrong")).rejects.toThrow(/MAC mismatch/);
  });
});

describe("verifyMandate", () => {
  it("accepts matching text and rejects any change", () => {
    const text = "1. Protect the treasury.\n";
    expect(() => verifyMandate(text, keccakUtf8(text))).not.toThrow();
    expect(() => verifyMandate(`${text} `, keccakUtf8(text))).toThrow(MandateMismatchError);
  });
});

describe("RepoEvidenceStore and FileCheckpoint", () => {
  it("writes evidence under safe paths and returns raw URLs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mandate-evidence-"));
    const store = new RepoEvidenceStore(dir, "https://raw.example/evidence/", "fs");
    const path = evidencePaths.rationale("12", 2);
    const urls = await store.publish([{ path, content: "{}" }], "test");
    expect(path).toBe(join("rationales", "12", "juror-2.json"));
    expect(urls.get(path)).toBe("https://raw.example/evidence/rationales/12/juror-2.json");
    expect(await store.read(path)).toBe("{}");
    expect(await store.read("missing.json")).toBeUndefined();
  });

  it("refuses path traversal through case or juror ids", () => {
    expect(() => evidencePaths.rationale("../etc", 1)).toThrow();
    expect(() => evidencePaths.rationale("1", 0)).toThrow();
  });

  it("round-trips the checkpoint and treats a missing file as no checkpoint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mandate-ckpt-"));
    const cp = new FileCheckpoint(join(dir, "sub", "c.json"));
    expect(await cp.load()).toBeUndefined();
    await cp.save(123456789012345678901234567890n);
    expect(await cp.load()).toBe(123456789012345678901234567890n);
  });
});
