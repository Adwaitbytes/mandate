import { type Hex, keccak256, toBytes } from "viem";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Serializes JSON with object keys sorted by UTF-16 code unit order and no insignificant whitespace, so the
 * same document always yields the same bytes. Only safe integers are allowed as numbers: large integers go in
 * strings (see docs/JUROR_INTERFACE.md) and floats are rejected so no serializer can disagree on their form.
 */
export function canonicalJson(value: Json): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new TypeError(`canonical JSON allows only safe integers, got ${value}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const item = value[key];
    if (item === undefined) throw new TypeError(`canonical JSON value for key ${key} is undefined`);
    parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
  }
  return `{${parts.join(",")}}`;
}

/** keccak256 of the UTF-8 bytes of a string, identical to Solidity `keccak256(bytes(s))`. */
export function keccakUtf8(text: string): Hex {
  return keccak256(toBytes(text));
}

/** keccak256 of raw bytes. */
export function keccakBytes(bytes: Uint8Array): Hex {
  return keccak256(bytes);
}
