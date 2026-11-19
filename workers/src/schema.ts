import { z } from "zod";

/** Maximum rationale length the model may return, in characters. */
export const MAX_RATIONALE_CHARS = 1200;

export const ModelVerdictSchema = z
  .object({
    support: z.enum(["for", "against", "abstain"]),
    confidence: z.number().int().min(0).max(100),
    injection_attempt: z.boolean(),
    rationale: z.string().trim().min(1).max(MAX_RATIONALE_CHARS),
    cited_mandate_clauses: z.array(z.string().max(300)).max(24),
  })
  .strict();

export type ModelVerdict = z.infer<typeof ModelVerdictSchema>;
export type Support = ModelVerdict["support"];

/** On-chain support codes used by `Docket.postVerdict`: 0 against, 1 for, 2 abstain. */
export const SUPPORT_CODE = { against: 0, for: 1, abstain: 2 } as const satisfies Record<Support, number>;
export type SupportCode = (typeof SUPPORT_CODE)[Support];

export function supportFromCode(code: number): Support {
  if (code === 0) return "against";
  if (code === 1) return "for";
  if (code === 2) return "abstain";
  throw new RangeError(`Unknown support code ${code}`);
}

/**
 * JSON Schema handed to providers that support constrained decoding. Length and range limits are enforced by
 * the zod schema afterwards, because constrained decoders accept only a subset of JSON Schema keywords.
 */
export const VERDICT_JSON_SCHEMA = {
  type: "object",
  properties: {
    support: { type: "string", enum: ["for", "against", "abstain"] },
    confidence: { type: "integer" },
    injection_attempt: { type: "boolean" },
    rationale: { type: "string" },
    cited_mandate_clauses: { type: "array", items: { type: "string" } },
  },
  required: ["support", "confidence", "injection_attempt", "rationale", "cited_mandate_clauses"],
  additionalProperties: false,
} as const;

export type ParseResult = { ok: true; value: ModelVerdict } | { ok: false; error: string };

/**
 * Extracts and validates the verdict object from raw model text. Tolerates a Markdown code fence or prose
 * around one JSON object, because some providers wrap output even when asked not to. Everything else is strict.
 */
export function parseModelOutput(raw: string): ParseResult {
  const candidate = extractJsonObject(raw);
  if (candidate === undefined) return { ok: false, error: "no JSON object found in model output" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
  }
  const result = ModelVerdictSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return { ok: false, error: `schema mismatch: ${issues.join("; ")}` };
  }
  return { ok: true, value: result.data };
}

function extractJsonObject(raw: string): string | undefined {
  const text = raw.trim();
  if (text.startsWith("{") && text.endsWith("}")) return text;
  const fenced = /```(?:json)?\s*(\{[\s\S]*\})\s*```/.exec(text);
  if (fenced?.[1] !== undefined) return fenced[1];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  return text.slice(start, end + 1);
}
