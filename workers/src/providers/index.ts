import { ConfigError, type JurorId, optionalEnv } from "../config.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { type ChainOptions, ProviderChain } from "./chain.ts";
import { GeminiProvider } from "./gemini.ts";
import { GroqProvider } from "./groq.ts";
import { OllamaProvider } from "./ollama.ts";
import { PollinationsProvider } from "./pollinations.ts";
import { type Provider, ProviderError } from "./types.ts";

export type ProviderName = "anthropic" | "groq" | "pollinations" | "gemini" | "ollama";

/**
 * Provider chain per juror, tried in order: `provider[:model][#key]`. A bare `anthropic` or `gemini` expands to one
 * link per configured key (`#1` is ANTHROPIC_API_KEY / GEMINI_API_KEY, `#2` the `_2` key). Families stay apart:
 * juror 1 Anthropic Claude, juror 2 OpenAI gpt-oss, juror 3 Google Gemini then Alibaba Qwen. Juror 1 has no
 * fallback outside Claude because every other family available keylessly or on these keys is already another
 * juror's (Groq serves only gpt-oss, Qwen and small models). No chain ends in a local model: when every link is
 * down the case stays unposted and is retried on the next pass. See docs/JURORS.md.
 */
export const DEFAULT_CHAIN: Record<JurorId, readonly string[]> = {
  1: ["anthropic"],
  2: ["groq", "pollinations", "groq:openai/gpt-oss-20b"],
  3: ["gemini", "groq:qwen/qwen3.8-27b"],
};

export function parseProviderName(raw: string): ProviderName {
  if (raw === "anthropic" || raw === "groq" || raw === "pollinations" || raw === "gemini" || raw === "ollama")
    return raw;
  throw new Error(`Unknown provider ${raw}; expected anthropic, groq, pollinations, gemini or ollama`);
}

/**
 * Builds a provider from env. `model` overrides the provider's model env var; `keySlot` restricts Anthropic or
 * Gemini to one key (1 or 2). Secrets are never logged.
 */
export function providerFromEnv(name: ProviderName, model?: string, keySlot?: KeySlot): Provider {
  switch (name) {
    case "anthropic":
      return new AnthropicProvider({
        apiKeys: keysFor("ANTHROPIC_API_KEY", keySlot),
        ...withOptional("model", model ?? optionalEnv("ANTHROPIC_MODEL")),
      });
    case "groq":
      return new GroqProvider({
        apiKey: optionalEnv("GROQ_API_KEY") ?? "",
        ...withOptional("model", model ?? optionalEnv("GROQ_MODEL")),
      });
    case "pollinations":
      return new PollinationsProvider({
        ...withOptional("model", model ?? optionalEnv("POLLINATIONS_MODEL")),
      });
    case "gemini":
      return new GeminiProvider({
        apiKeys: keysFor("GEMINI_API_KEY", keySlot),
        ...withOptional("model", model ?? optionalEnv("GEMINI_MODEL")),
      });
    case "ollama":
      return new OllamaProvider({
        ...withOptional("baseUrl", optionalEnv("OLLAMA_URL")),
        ...withOptional("model", model ?? optionalEnv("OLLAMA_MODEL")),
      });
  }
}

export type KeySlot = 1 | 2;

function keysFor(base: string, slot: KeySlot | undefined): string[] {
  const all: Array<[KeySlot, string | undefined]> = [
    [1, optionalEnv(base)],
    [2, optionalEnv(`${base}_2`)],
  ];
  return all
    .filter(([s, k]) => k !== undefined && (slot === undefined || s === slot))
    .map(([, k]) => k as string);
}

const MULTI_KEY: ReadonlySet<ProviderName> = new Set(["anthropic", "gemini"]);

export interface LinkSpec {
  provider: ProviderName;
  model?: string;
  keySlot?: KeySlot;
}

/** Parses `provider[:model][#key]`, for example `groq:qwen/qwen3.8-27b` or `gemini#2`. */
export function parseLinkSpec(raw: string): LinkSpec {
  const m = /^([a-z]+)(?::([^#]+))?(?:#([12]))?$/.exec(raw.trim());
  if (m === null) throw new Error(`Invalid provider spec ${raw}; expected provider[:model][#1|#2]`);
  const provider = parseProviderName(m[1] ?? "");
  if (m[3] !== undefined && !MULTI_KEY.has(provider))
    throw new Error(`Provider spec ${raw}: only anthropic and gemini take a key slot`);
  return {
    provider,
    ...(m[2] === undefined ? {} : { model: m[2] }),
    ...(m[3] === undefined ? {} : { keySlot: Number(m[3]) as KeySlot }),
  };
}

/** A bare multi-key provider becomes one link per configured key, so each key gets its own breaker. */
function expandKeys(spec: LinkSpec): LinkSpec[] {
  if (!MULTI_KEY.has(spec.provider) || spec.keySlot !== undefined) return [spec];
  const base = spec.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "GEMINI_API_KEY";
  const slots = ([1, 2] as const).filter((s) => keysFor(base, s).length > 0);
  return slots.length <= 1 ? [spec] : slots.map((keySlot) => ({ ...spec, keySlot }));
}

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "");
}

/**
 * The link specs a juror runs, before key expansion: JUROR_<n>_CHAIN (comma list) replaces the whole chain;
 * otherwise the primary is PROVIDER, then JUROR_<n>_PROVIDER, then the default, followed by JUROR_<n>_FALLBACK
 * (comma list, `none` for no fallback) or the default fallbacks. `withFallback: false` keeps the primary only.
 */
export function chainSpecsForJuror(jurorId: JurorId, withFallback = true): string[] {
  const full = optionalEnv(`JUROR_${jurorId}_CHAIN`);
  if (full !== undefined) return withFallback ? splitList(full) : splitList(full).slice(0, 1);
  const defaults = DEFAULT_CHAIN[jurorId];
  const primary = optionalEnv("PROVIDER") ?? optionalEnv(`JUROR_${jurorId}_PROVIDER`) ?? defaults[0];
  if (primary === undefined) throw new Error(`No provider configured for juror ${jurorId}`);
  if (!withFallback) return [primary];
  const fallbackEnv = optionalEnv(`JUROR_${jurorId}_FALLBACK`);
  const fallbacks =
    fallbackEnv === undefined ? defaults.slice(1) : fallbackEnv === "none" ? [] : splitList(fallbackEnv);
  return [primary, ...fallbacks];
}

export interface JurorProviderOptions {
  withFallback?: boolean;
  log?: (message: string) => void;
  chain?: Omit<ChainOptions, "log">;
}

/**
 * The provider a juror runs: its chain (chainSpecsForJuror) with a circuit breaker per link and a time budget
 * per completion. A link that cannot be built (its key is missing) is left out with a warning; a chain with no
 * buildable link is a configuration error.
 */
export function providerForJuror(jurorId: JurorId, options: JurorProviderOptions = {}): ProviderChain {
  const log = options.log ?? ((m: string) => console.warn(m));
  const links: Array<{ label: string; provider: Provider }> = [];
  const problems: string[] = [];
  for (const raw of chainSpecsForJuror(jurorId, options.withFallback ?? true)) {
    for (const spec of expandKeys(parseLinkSpec(raw))) {
      let provider: Provider;
      try {
        provider = providerFromEnv(spec.provider, spec.model, spec.keySlot);
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        problems.push(`${raw}: ${err.message}`);
        continue;
      }
      const label = spec.keySlot === undefined ? provider.modelId : `${provider.modelId}#${spec.keySlot}`;
      if (!links.some((l) => l.label === label)) links.push({ label, provider });
    }
  }
  for (const p of problems) log(`juror ${jurorId}: provider left out of the chain: ${p}`);
  if (links.length === 0)
    throw new ConfigError(`Juror ${jurorId} has no usable provider: ${problems.join("; ") || "empty chain"}`);
  return new ProviderChain(links, {
    ...options.chain,
    log: (m) => log(`juror ${jurorId}: ${m}`),
  });
}

function withOptional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: string };
}

const PREFIX_TO_PROVIDER: Record<string, ProviderName> = {
  anthropic: "anthropic",
  groq: "groq",
  pollinations: "pollinations",
  google: "gemini",
  ollama: "ollama",
};

/** Rebuilds the provider that produced a recorded `<provider>/<model>` id, for replays. */
export function providerForModelId(modelId: string): Provider {
  const slash = modelId.indexOf("/");
  const name = PREFIX_TO_PROVIDER[modelId.slice(0, slash)];
  if (slash === -1 || name === undefined)
    throw new Error(`Cannot rebuild a provider for model id ${modelId}`);
  return providerFromEnv(name, modelId.slice(slash + 1));
}
