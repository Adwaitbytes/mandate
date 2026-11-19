import { type Hex, isAddressEqual, isHex, keccak256, toBytes } from "viem";

/** The fields the docket shows. The document carries more; the hash covers every byte of it. */
export interface RationaleDocument {
  caseId: string;
  juror: string;
  model: string;
  promptHash: string;
  support: number;
  confidenceBps: number;
  injectionFlag: boolean;
  injectionEvidence: string;
  rationale: string;
  citedMandateClauses: string[];
  mandateVersion: string;
  createdAt: string;
  temperature: number | null;
  /** Rationales from workers 447b215 on: links of the provider chain passed over before the one that answered. */
  providerFallbacks: string[];
  /** The model version the provider reported serving, when it reports one (Gemini). */
  servedModel: string | null;
}

export interface OnChainVerdict {
  caseId: bigint;
  juror: string;
  support: number;
  confidenceBps: number;
  injectionFlag: boolean;
  rationaleHash: Hex;
  modelIdHash: Hex;
  promptHash: Hex;
}

export type RationaleCheck =
  | { state: "verified"; doc: RationaleDocument; computed: Hex; discrepancies: string[] }
  | { state: "mismatch"; computed: Hex; expected: Hex; doc: RationaleDocument | null }
  | { state: "unreadable"; computed: Hex; reason: string };

/** evidence/rationales/<caseId>/juror-<n>.json, as workers/src/store.ts writes it. */
export function rationaleUrl(base: string, caseId: bigint, jurorId: number): string | null {
  if (base.length === 0 || !Number.isInteger(jurorId) || jurorId < 1 || jurorId > 16) return null;
  return `${base}/rationales/${caseId.toString()}/juror-${jurorId}.json`;
}

/** keccak256 over the exact bytes served, which is what the juror hashed before posting. */
export function hashBytes(bytes: Uint8Array): Hex {
  return keccak256(bytes);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function parseRationale(bytes: Uint8Array): RationaleDocument | string {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return "The document is not valid UTF-8 JSON";
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return "The document is not a JSON object";
  const r = raw as Record<string, unknown>;
  const caseId = asString(r.caseId);
  const juror = asString(r.juror);
  const model = asString(r.model);
  const promptHash = asString(r.promptHash);
  const rationale = asString(r.rationale);
  if (caseId === null || juror === null || model === null || promptHash === null || rationale === null) {
    return "The document is missing caseId, juror, model, promptHash or rationale";
  }
  if (
    typeof r.support !== "number" ||
    typeof r.confidenceBps !== "number" ||
    typeof r.injectionFlag !== "boolean"
  ) {
    return "The document is missing support, confidenceBps or injectionFlag";
  }
  const clauses = Array.isArray(r.citedMandateClauses)
    ? r.citedMandateClauses.filter((c): c is string => typeof c === "string")
    : [];
  return {
    caseId,
    juror,
    model,
    promptHash,
    rationale,
    support: r.support,
    confidenceBps: r.confidenceBps,
    injectionFlag: r.injectionFlag,
    injectionEvidence: asString(r.injectionEvidence) ?? "",
    citedMandateClauses: clauses,
    mandateVersion: asString(r.mandateVersion) ?? "",
    createdAt: asString(r.createdAt) ?? "",
    temperature: typeof r.temperature === "number" ? r.temperature : null,
    providerFallbacks: Array.isArray(r.providerFallbacks)
      ? r.providerFallbacks.filter((c): c is string => typeof c === "string")
      : [],
    servedModel: asString(r.servedModel),
  };
}

/**
 * Checks a fetched rationale against the verdict on the Docket. The hash decides; field checks only add notes
 * when a document that hashes correctly still disagrees with the verdict it was posted with.
 */
export function checkRationale(bytes: Uint8Array, verdict: OnChainVerdict): RationaleCheck {
  const computed = hashBytes(bytes);
  const parsed = parseRationale(bytes);
  const doc = typeof parsed === "string" ? null : parsed;
  if (computed.toLowerCase() !== verdict.rationaleHash.toLowerCase()) {
    return { state: "mismatch", computed, expected: verdict.rationaleHash, doc };
  }
  if (doc === null) return { state: "unreadable", computed, reason: parsed as string };

  const discrepancies: string[] = [];
  if (doc.caseId !== verdict.caseId.toString()) discrepancies.push(`names case ${doc.caseId}`);
  if (
    !isHex(doc.juror, { strict: true }) ||
    doc.juror.length !== 42 ||
    !isAddressEqual(doc.juror, verdict.juror as Hex)
  ) {
    discrepancies.push("names a different juror address");
  }
  if (doc.support !== verdict.support) discrepancies.push("records a different vote than the one on chain");
  if (doc.confidenceBps !== verdict.confidenceBps) discrepancies.push("records a different confidence");
  if (doc.injectionFlag !== verdict.injectionFlag) discrepancies.push("records a different injection flag");
  if (keccak256(toBytes(doc.model)).toLowerCase() !== verdict.modelIdHash.toLowerCase()) {
    discrepancies.push("names a model whose hash differs from the on-chain model id");
  }
  if (doc.promptHash.toLowerCase() !== verdict.promptHash.toLowerCase()) {
    discrepancies.push("cites a prompt hash that differs from the one on chain");
  }
  return { state: "verified", doc, computed, discrepancies };
}

export type RationaleFetch =
  | RationaleCheck
  | { state: "no-store" }
  | { state: "not-found"; url: string }
  | { state: "unavailable"; url: string; reason: string };

/** Rationale documents are small; anything larger is not one and is not hashed. */
const MAX_BYTES = 256 * 1024;

export async function fetchRationale(
  url: string | null,
  verdict: OnChainVerdict,
  fetcher: typeof fetch = fetch,
): Promise<RationaleFetch> {
  if (url === null) return { state: "no-store" };
  let response: Response;
  try {
    response = await fetcher(url, { cache: "no-store", redirect: "follow" });
  } catch (err) {
    return { state: "unavailable", url, reason: err instanceof Error ? err.message : "network error" };
  }
  if (response.status === 404) return { state: "not-found", url };
  if (!response.ok) return { state: "unavailable", url, reason: `HTTP ${response.status}` };
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) return { state: "unavailable", url, reason: "document too large" };
  return checkRationale(bytes, verdict);
}
