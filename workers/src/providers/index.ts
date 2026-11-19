import { type JurorId, optionalEnv } from "../config.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { OllamaProvider } from "./ollama.ts";
import { PollinationsProvider } from "./pollinations.ts";
import type { Provider } from "./types.ts";

export type ProviderName = "anthropic" | "pollinations" | "ollama";

/** Default provider per juror: three model families from three providers. */
export const DEFAULT_PROVIDER: Record<JurorId, ProviderName> = {
  1: "anthropic",
  2: "pollinations",
  3: "ollama",
};

export function parseProviderName(raw: string): ProviderName {
  if (raw === "anthropic" || raw === "pollinations" || raw === "ollama") return raw;
  throw new Error(`Unknown provider ${raw}; expected anthropic, pollinations or ollama`);
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
    case "pollinations":
      return new PollinationsProvider({ ...withOptional("model", optionalEnv("POLLINATIONS_MODEL")) });
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
