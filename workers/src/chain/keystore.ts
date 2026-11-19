import { readFile } from "node:fs/promises";
import { ctr } from "@noble/ciphers/aes.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, type Hex, hexToBytes } from "viem";
import { z } from "zod";

const hex = z.string().regex(/^(0x)?[0-9a-fA-F]+$/);

const KeystoreSchema = z.object({
  version: z.literal(3),
  crypto: z.object({
    cipher: z.literal("aes-128-ctr"),
    ciphertext: hex,
    cipherparams: z.object({ iv: hex }),
    kdf: z.literal("scrypt"),
    kdfparams: z.object({
      dklen: z.number().int().positive(),
      n: z.number().int().positive(),
      p: z.number().int().positive(),
      r: z.number().int().positive(),
      salt: hex,
    }),
    mac: hex,
  }),
});

const toBytes = (value: string): Uint8Array =>
  hexToBytes((value.startsWith("0x") ? value : `0x${value}`) as Hex);

/**
 * Decrypts a Web3 Secret Storage v3 keystore (the format Foundry writes) with scrypt and AES-128-CTR, checking
 * the MAC first. The private key never leaves this process and is never logged.
 */
export async function decryptKeystore(json: string, password: string): Promise<Hex> {
  const ks = KeystoreSchema.parse(JSON.parse(json));
  const { kdfparams, ciphertext, cipherparams, mac } = ks.crypto;
  const derived = await scryptAsync(new TextEncoder().encode(password), toBytes(kdfparams.salt), {
    N: kdfparams.n,
    r: kdfparams.r,
    p: kdfparams.p,
    dkLen: kdfparams.dklen,
  });
  const cipherBytes = toBytes(ciphertext);
  const macInput = new Uint8Array(16 + cipherBytes.length);
  macInput.set(derived.slice(16, 32), 0);
  macInput.set(cipherBytes, 16);
  if (bytesToHex(keccak_256(macInput)) !== bytesToHex(toBytes(mac))) {
    throw new Error("Keystore MAC mismatch: wrong password or corrupted keystore");
  }
  const key = ctr(derived.slice(0, 16), toBytes(cipherparams.iv)).decrypt(cipherBytes);
  return bytesToHex(key);
}

export async function decryptKeystoreFile(keystorePath: string, passwordPath: string): Promise<Hex> {
  const [json, password] = await Promise.all([
    readFile(keystorePath, "utf8"),
    readFile(passwordPath, "utf8"),
  ]);
  return decryptKeystore(json, password.replace(/\r?\n$/, ""));
}
