import { type JurorId, optionalEnv } from "../config.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { FallbackProvider } from "./fallback.ts";
import { GeminiProvider } from "./gemini.ts";
import { GroqProvider } from "./groq.ts";
import { OllamaProvider } from "./ollama.ts";
import { PollinationsProvider } from "./pollinations.ts";
import type { Provider } from "./types.ts";

export type ProviderName = "anthropic" | "groq" | "pollinations" | "gemini" | "ollama";

/**
 * Default provider per juror: three model families from three providers (Anthropic Claude, OpenAI gpt-oss on
 * Groq, Google Gemini). Ollama Qwen stays available as a keyless option with JUROR_3_PROVIDER=ollama.
 */
export const DEFAULT_PROVIDER: Record<JurorId, ProviderName> = {
  1: "anthropic",
  2: "groq",
  3: "gemini",
};

/** Used when the primary is unavailable after its retries. Juror 2 falls back to gpt-oss-20b on Pollinations. */
export const DEFAULT_FALLBACK: Partial<Record<JurorId, ProviderName>> = { 2: "pollinations" };

export function parseProviderName(raw: string): ProviderName {
  if (raw === "anthropic" || raw === "groq" || raw === "pollinations" || raw === "gemini" || raw === "ollama")
    return raw;
  throw new Error(`Unknown provider ${raw}; expected anthropic, groq, pollinations, gemini or ollama`);
}

/** Builds a provider from environment variables. Secrets are read here and never logged. */
export function providerFromEnv(name: ProviderName): Provider {
  switch (name) {
    case "anthropic":
      return new AnthropicProvider({
        apiKeys: [optionalEnv("ANTHROPIC_API_KEY"), optionalEnv("ANTHROPIC_API_KEY_2")].filter(
          (k): k is string => k !== undefined,
        ),
        ...withOptional("model", optionalEnv("ANTHROPIC_MODEL")),
      });
    case "groq":
      return new GroqProvider({
        apiKey: optionalEnv("GROQ_API_KEY") ?? "",
        ...withOptional("model", optionalEnv("GROQ_MODEL")),
      });
    case "pollinations":
      return new PollinationsProvider({ ...withOptional("model", optionalEnv("POLLINATIONS_MODEL")) });
    case "gemini":
      return new GeminiProvider({
        apiKeys: [optionalEnv("GEMINI_API_KEY"), optionalEnv("GEMINI_API_KEY_2")].filter(
          (k): k is string => k !== undefined,
        ),
        ...withOptional("model", optionalEnv("GEMINI_MODEL")),
      });
    case "ollama":
      return new OllamaProvider({
        ...withOptional("baseUrl", optionalEnv("OLLAMA_URL")),
        ...withOptional("model", optionalEnv("OLLAMA_MODEL")),
      });
  }
}

function withOptional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: string };
}

/**
 * The provider a juror runs: PROVIDER, then JUROR_<n>_PROVIDER, then the default for that juror, wrapped with
 * JUROR_<n>_FALLBACK (default per DEFAULT_FALLBACK; "none" disables it) unless withFallback is false.
 */
export function providerForJuror(jurorId: JurorId, withFallback = true): Provider {
  const name = parseProviderName(
    optionalEnv("PROVIDER") ?? optionalEnv(`JUROR_${jurorId}_PROVIDER`) ?? DEFAULT_PROVIDER[jurorId],
  );
  const primary = providerFromEnv(name);
  const fallbackName = optionalEnv(`JUROR_${jurorId}_FALLBACK`) ?? DEFAULT_FALLBACK[jurorId];
  if (!withFallback || fallbackName === undefined || fallbackName === "none" || fallbackName === name)
    return primary;
  return new FallbackProvider(primary, providerFromEnv(parseProviderName(fallbackName)), (reason) =>
    console.warn(
      `juror ${jurorId}: ${primary.modelId} unavailable, using ${fallbackName}: ${reason.slice(0, 200)}`,
    ),
  );
}

const PREFIX_TO_PROVIDER: Record<string, ProviderName> = {
  anthropic: "anthropic",
  groq: "groq",
  pollinations: "pollinations",
  google: "gemini",
  ollama: "ollama",
};
const MODEL_ENV: Record<ProviderName, string> = {
  anthropic: "ANTHROPIC_MODEL",
  groq: "GROQ_MODEL",
  pollinations: "POLLINATIONS_MODEL",
  gemini: "GEMINI_MODEL",
  ollama: "OLLAMA_MODEL",
};

/** Rebuilds the provider that produced a recorded `<provider>/<model>` id, for replays. */
export function providerForModelId(modelId: string): Provider {
  const slash = modelId.indexOf("/");
  const name = PREFIX_TO_PROVIDER[modelId.slice(0, slash)];
  if (slash === -1 || name === undefined)
    throw new Error(`Cannot rebuild a provider for model id ${modelId}`);
  process.env[MODEL_ENV[name]] = modelId.slice(slash + 1);
  return providerFromEnv(name);
}
