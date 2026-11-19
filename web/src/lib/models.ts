import { type Hex, keccak256, toBytes } from "viem";

/** How the site names a `<provider>/<model>` id. The id itself is what the juror hashes into modelIdHash. */
export interface ModelName {
  /** "Qwen 3.8 27B" */
  name: string;
  /** "Alibaba open weights on Groq" */
  provenance: string;
  /** One word for tables: "Qwen" */
  short: string;
}

const NAMES: Record<string, ModelName> = {
  "anthropic/claude-haiku-5-5": { name: "Claude Haiku 5.5", provenance: "Anthropic API", short: "Claude" },
  "groq/openai/gpt-oss-120b": {
    name: "gpt-oss-120b",
    provenance: "OpenAI open weights on Groq",
    short: "gpt-oss-120b",
  },
  "groq/openai/gpt-oss-20b": {
    name: "gpt-oss-20b (Groq)",
    provenance: "OpenAI open weights on Groq",
    short: "gpt-oss-20b",
  },
  "pollinations/openai-fast": {
    name: "gpt-oss-20b (Pollinations)",
    provenance: "OpenAI open weights on Pollinations",
    short: "gpt-oss-20b",
  },
  "google/gemini-flash-latest": { name: "Gemini Flash", provenance: "Google Gemini API", short: "Gemini" },
  "groq/qwen/qwen3.8-27b": {
    name: "Qwen 3.8 27B",
    provenance: "Alibaba open weights on Groq",
    short: "Qwen",
  },
  "ollama/qwen3.5:2b": {
    name: "Qwen 3.5 2B",
    provenance: "Alibaba open weights, run locally on Ollama",
    short: "Qwen 2B",
  },
  "ollama/qwen2.5:3b-instruct": {
    name: "Qwen 2.5 3B Instruct",
    provenance: "Alibaba open weights, run locally on Ollama",
    short: "Qwen 3B",
  },
};

/** A readable name for any model id; ids the site does not know are shown as they are. */
export function modelName(id: string): ModelName {
  return NAMES[id] ?? { name: id, provenance: "provider not listed by this site", short: id };
}

export function modelHash(id: string): Hex {
  return keccak256(toBytes(id));
}

/**
 * Which model answered a verdict, read from its modelIdHash.
 * - primary: the juror's first choice.
 * - fallback: a later link in the juror's provider chain, or a model the juror answered with in the live run.
 * - named: not one of this juror's models, but the verified rationale names a model whose hash matches.
 * - unknown: the hash matches nothing the site knows and no verified rationale names it.
 */
export type AnsweredBy =
  | { kind: "primary"; id: string; model: ModelName }
  | { kind: "fallback"; id: string; model: ModelName; primary: ModelName }
  | { kind: "named"; id: string; model: ModelName }
  | { kind: "unknown" };

export interface JurorModels {
  /** The provider chain in order; the first is the primary. */
  chain: readonly string[];
  /** Models that answered for this juror in the recorded live run. */
  live: readonly string[];
}

export function answeredBy(models: JurorModels, modelIdHash: Hex, namedInRationale?: string): AnsweredBy {
  const hash = modelIdHash.toLowerCase();
  const [primaryId] = models.chain;
  const candidates = [...models.chain, ...models.live.filter((m) => !models.chain.includes(m))];
  const id = candidates.find((m) => modelHash(m).toLowerCase() === hash);
  if (id !== undefined) {
    if (id === primaryId) return { kind: "primary", id, model: modelName(id) };
    return {
      kind: "fallback",
      id,
      model: modelName(id),
      primary: modelName(primaryId ?? id),
    };
  }
  if (namedInRationale !== undefined && modelHash(namedInRationale).toLowerCase() === hash) {
    return { kind: "named", id: namedInRationale, model: modelName(namedInRationale) };
  }
  return { kind: "unknown" };
}

/**
 * Refines the answer with the rationale's providerFallbacks (workers 447b215 on), entries like
 * `google/gemini-flash-latest#1: circuit open 40 s more (...)`. When it lists what was passed over, the opinion
 * names those models rather than assuming the juror's primary.
 */
export function withPassedOver(a: AnsweredBy, passedOver: readonly string[]): AnsweredBy {
  if (a.kind === "unknown" || passedOver.length === 0) return a;
  const ids = passedOver.map((p) => p.split(":")[0]?.split("#")[0]?.trim() ?? "").filter((id) => id !== a.id);
  const names = [...new Set(ids.filter((id) => id.length > 0).map((id) => modelName(id).name))];
  if (names.length === 0) return a;
  return {
    kind: "fallback",
    id: a.id,
    model: a.model,
    primary: { name: names.join(" and "), provenance: "", short: names.join(", ") },
  };
}

/** "Qwen 3.8 27B, fallback for Gemini Flash" and the like, for a provenance line. */
export function answeredLine(a: AnsweredBy): string {
  switch (a.kind) {
    case "primary":
      return `Answered by ${a.model.name}, ${a.model.provenance}`;
    case "fallback":
      return `Answered by ${a.model.name}, fallback for ${a.primary.name} (${a.model.provenance})`;
    case "named":
      return `Answered by ${a.model.name}, named in the verified opinion; not in this juror's provider chain`;
    case "unknown":
      return "The model id on chain is not one this site lists for this juror";
  }
}
