import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenvFile } from "dotenv";
import { type Address, getAddress, isAddress } from "viem";

/** Root of the workers package, resolved from this file so CLIs work from any cwd. */
export const WORKERS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Root of the mandate repository. */
export const REPO_DIR = resolve(WORKERS_DIR, "..");

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/**
 * Loads secrets from a dotenv file without overriding variables already set in the environment.
 * `MANDATE_ENV_FILE` wins; otherwise the workspace `.env.local` two levels above the repo is used if present.
 * Values are never logged.
 */
export function loadSecretsFile(): void {
  const explicit = process.env.MANDATE_ENV_FILE;
  const candidate = explicit ?? resolve(REPO_DIR, "..", ".env.local");
  if (!existsSync(candidate)) {
    if (explicit !== undefined)
      throw new ConfigError(`MANDATE_ENV_FILE points at a missing file: ${explicit}`);
    return;
  }
  loadDotenvFile({ path: candidate, override: false, quiet: true });
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new ConfigError(`Missing required environment variable ${name}`);
  }
  return value.trim();
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

export function requireAddress(name: string): Address {
  const value = requireEnv(name);
  if (!isAddress(value, { strict: false })) throw new ConfigError(`${name} is not an address: ${value}`);
  return getAddress(value);
}

export function intEnv(name: string, fallback: number): number {
  const value = optionalEnv(name);
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new ConfigError(`${name} must be a non-negative integer, got ${value}`);
  return Number(value);
}

export function bigintEnv(name: string): bigint | undefined {
  const value = optionalEnv(name);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new ConfigError(`${name} must be a non-negative integer, got ${value}`);
  return BigInt(value);
}

/** RPC URL for a chain id, from `RPC_URL_<chainId>`. Fails loudly when absent. */
export function rpcUrlFor(chainId: bigint | number): string {
  return requireEnv(`RPC_URL_${chainId.toString()}`);
}

export type JurorId = 1 | 2 | 3;

export function parseJurorId(raw: string | undefined): JurorId {
  if (raw === "1" || raw === "2" || raw === "3") return Number(raw) as JurorId;
  throw new ConfigError(`JUROR_ID must be 1, 2 or 3, got ${raw ?? "(unset)"}`);
}
