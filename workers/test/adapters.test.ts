import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../src/providers/anthropic.ts";
import { FallbackProvider } from "../src/providers/fallback.ts";
import { GEMINI_RESPONSE_SCHEMA, GeminiProvider } from "../src/providers/gemini.ts";
import { GroqProvider } from "../src/providers/groq.ts";
import { OllamaProvider } from "../src/providers/ollama.ts";
import { PollinationsProvider, parseRetryAfter } from "../src/providers/pollinations.ts";
import { type Provider, ProviderError } from "../src/providers/types.ts";
import { VERDICT_JSON_SCHEMA } from "../src/schema.ts";
import { json, queuedFetch, VALID_VERDICT } from "./helpers.ts";

const request = { system: "sys", user: "usr" };
const noSleep = { sleep: async () => {} };

function anthropicMessage(text: string, stopReason = "end_turn") {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

const anthropicError = (status: number, type: string) =>
  json(status, { type: "error", error: { type, message: `${type} from test` } });

describe("PollinationsProvider", () => {
  it("posts an OpenAI-style body at temperature 0 and returns the content", async () => {
    const { fetch, calls } = queuedFetch([
      json(200, { model: "gpt-oss-20b", choices: [{ message: { content: JSON.stringify(VALID_VERDICT) } }] }),
    ]);
    const p = new PollinationsProvider({ fetch, backoff: noSleep, minIntervalMs: 0 });
    const r = await p.complete(request);
    expect(p.modelId).toBe("pollinations/openai-fast");
    expect(r).toEqual({ text: JSON.stringify(VALID_VERDICT), servedModel: "gpt-oss-20b" });
    expect(calls[0]?.url).toBe("https://text.pollinations.ai/openai");
    expect(calls[0]?.body).toMatchObject({
      model: "openai-fast",
      temperature: 0,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "usr" },
      ],
    });
  });

  it("backs off on 429 and 5xx, honouring Retry-After", async () => {
    const slept: number[] = [];
    const { fetch, calls } = queuedFetch([
      json(429, { error: "slow down" }, { "retry-after": "7" }),
      json(503, { error: "busy" }),
      json(200, { choices: [{ message: { content: "{}" } }] }),
    ]);
    const p = new PollinationsProvider({
      fetch,
      minIntervalMs: 0,
      backoff: { baseDelayMs: 1000, sleep: async (ms) => void slept.push(ms) },
    });
    await expect(p.complete(request)).resolves.toEqual({ text: "{}" });
    expect(calls).toHaveLength(3);
    expect(slept).toEqual([7000, 2000]);
  });

  it("gives up after the retry budget and does not retry a 400", async () => {
    const failing = queuedFetch([json(500, {}), json(500, {}), json(500, {})]);
    await expect(
      new PollinationsProvider({
        fetch: failing.fetch,
        minIntervalMs: 0,
        backoff: { retries: 2, ...noSleep },
      }).complete(request),
    ).rejects.toMatchObject({ retryable: true, status: 500 });
    expect(failing.calls).toHaveLength(3);

    const bad = queuedFetch([json(400, { error: "bad" })]);
    await expect(
      new PollinationsProvider({ fetch: bad.fetch, minIntervalMs: 0, backoff: noSleep }).complete(request),
    ).rejects.toMatchObject({ retryable: false, status: 400 });
    expect(bad.calls).toHaveLength(1);
  });

  it("retries a network error and an unexpected body shape", async () => {
    let n = 0;
    const p = new PollinationsProvider({
      minIntervalMs: 0,
      backoff: { retries: 2, ...noSleep },
      fetch: async () => {
        n++;
        if (n === 1) throw new TypeError("fetch failed");
        if (n === 2) return new Response(JSON.stringify({ nope: true }), { status: 200 });
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
      },
    });
    await expect(p.complete(request)).resolves.toEqual({ text: "ok" });
    expect(n).toBe(3);
  });

  it("treats 402 FREE_LIMIT as a rate limit and waits the time named in the body", async () => {
    const slept: number[] = [];
    const { fetch } = queuedFetch([
      () =>
        new Response(
          '{"status":402,"error":{"code":"FREE_LIMIT","message":"Retry after 37s, or get a key"}}',
          {
            status: 402,
          },
        ),
      json(200, { choices: [{ message: { content: "{}" } }] }),
    ]);
    const p = new PollinationsProvider({
      fetch,
      minIntervalMs: 0,
      backoff: { baseDelayMs: 1000, sleep: async (ms) => void slept.push(ms) },
    });
    await expect(p.complete(request)).resolves.toEqual({ text: "{}" });
    expect(slept).toEqual([38_000]);
  });

  it("paces consecutive calls by the minimum interval", async () => {
    let clock = 1_000;
    const slept: number[] = [];
    const { fetch } = queuedFetch([
      json(200, { choices: [{ message: { content: "a" } }] }),
      json(200, { choices: [{ message: { content: "b" } }] }),
    ]);
    const p = new PollinationsProvider({
      fetch,
      minIntervalMs: 45_000,
      now: () => clock,
      backoff: {
        sleep: async (ms) => {
          slept.push(ms);
          clock += ms;
        },
      },
    });
    await p.complete(request);
    clock += 5_000;
    await p.complete(request);
    expect(slept).toEqual([40_000]);
  });

  it("parses Retry-After seconds and caps it", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter("100000")).toBe(120_000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});

describe("OllamaProvider", () => {
  it("calls /api/chat with the verdict schema, temperature 0 and a fixed seed", async () => {
    const { fetch, calls } = queuedFetch([
      json(200, { model: "qwen2.5:3b-instruct", message: { role: "assistant", content: "{}" } }),
    ]);
    const p = new OllamaProvider({ fetch, baseUrl: "http://ollama.test:11434/", backoff: noSleep });
    expect(p.modelId).toBe("ollama/qwen2.5:3b-instruct");
    await expect(p.complete(request)).resolves.toEqual({ text: "{}", servedModel: "qwen2.5:3b-instruct" });
    expect(calls[0]?.url).toBe("http://ollama.test:11434/api/chat");
    expect(calls[0]?.body).toMatchObject({
      model: "qwen2.5:3b-instruct",
      stream: false,
      think: false,
      format: VERDICT_JSON_SCHEMA,
      options: { temperature: 0, seed: 0 },
    });
  });

  it("surfaces a missing model as a non-retryable error", async () => {
    const { fetch } = queuedFetch([json(404, { error: "model not found" })]);
    await expect(new OllamaProvider({ fetch, backoff: noSleep }).complete(request)).rejects.toMatchObject({
      retryable: false,
      status: 404,
    });
  });
});

describe("AnthropicProvider", () => {
  it("sends Haiku 5.5 with thinking disabled, low effort, the schema and no temperature", async () => {
    const { fetch, calls } = queuedFetch([json(200, anthropicMessage(JSON.stringify(VALID_VERDICT)))]);
    const p = new AnthropicProvider({ apiKeys: ["key-one"], fetch, maxRetries: 0 });
    expect(p.modelId).toBe("anthropic/claude-haiku-5-5");
    expect(p.temperature).toBeNull();
    const r = await p.complete(request);
    expect(r.text).toBe(JSON.stringify(VALID_VERDICT));
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer key-one");
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "claude-haiku-5-5",
      system: "sys",
      messages: [{ role: "user", content: "usr" }],
      thinking: { type: "disabled" },
      output_config: { effort: "low", format: { type: "json_schema" } },
    });
    expect(body).not.toHaveProperty("temperature");
  });

  it("falls back to the second key on 401", async () => {
    const { fetch, calls } = queuedFetch([
      anthropicError(401, "authentication_error"),
      json(200, anthropicMessage("{}")),
    ]);
    const p = new AnthropicProvider({ apiKeys: ["bad", "good"], fetch, maxRetries: 0 });
    await expect(p.complete(request)).resolves.toMatchObject({ text: "{}" });
    expect(calls.map((c) => c.headers.get("authorization"))).toEqual(["Bearer bad", "Bearer good"]);
  });

  it("falls back to the second key on 429", async () => {
    const { fetch, calls } = queuedFetch([
      anthropicError(429, "rate_limit_error"),
      json(200, anthropicMessage("{}")),
    ]);
    const p = new AnthropicProvider({ apiKeys: ["limited", "spare"], fetch, maxRetries: 0 });
    await expect(p.complete(request)).resolves.toMatchObject({ text: "{}" });
    expect(calls.map((c) => c.headers.get("authorization"))).toEqual(["Bearer limited", "Bearer spare"]);
  });

  it("does not fall back on a 400 and reports it as non-retryable", async () => {
    const { fetch, calls } = queuedFetch([anthropicError(400, "invalid_request_error")]);
    const p = new AnthropicProvider({ apiKeys: ["a", "b"], fetch, maxRetries: 0 });
    const err = await p.complete(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ retryable: false, status: 400 });
    expect(calls).toHaveLength(1);
  });

  it("marks exhausted keys on 429 as retryable", async () => {
    const { fetch } = queuedFetch([
      anthropicError(429, "rate_limit_error"),
      anthropicError(429, "rate_limit_error"),
    ]);
    const p = new AnthropicProvider({ apiKeys: ["a", "b"], fetch, maxRetries: 0 });
    await expect(p.complete(request)).rejects.toMatchObject({ retryable: true, status: 429 });
  });

  it("turns a refusal into empty text so the juror treats it as invalid output", async () => {
    const { fetch } = queuedFetch([json(200, anthropicMessage("", "refusal"))]);
    const p = new AnthropicProvider({ apiKeys: ["k"], fetch, maxRetries: 0 });
    await expect(p.complete(request)).resolves.toMatchObject({ text: "" });
  });

  it("refuses to start without a key", () => {
    expect(() => new AnthropicProvider({ apiKeys: ["", " "] })).toThrow(/No Anthropic API key/);
  });
});

describe("GeminiProvider", () => {
  const ok = (text: string, version = "gemini-3.8-flash") =>
    json(200, {
      modelVersion: version,
      candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }],
    });
  const highDemand = json(503, {
    error: { code: 503, message: "This model is currently experiencing high demand." },
  });

  it("posts JSON mode with the response schema at temperature 0 and records modelVersion", async () => {
    const { fetch, calls } = queuedFetch([ok(JSON.stringify(VALID_VERDICT))]);
    const p = new GeminiProvider({ apiKeys: ["g1"], fetch, backoff: noSleep });
    expect(p.modelId).toBe("google/gemini-flash-latest");
    await expect(p.complete(request)).resolves.toEqual({
      text: JSON.stringify(VALID_VERDICT),
      servedModel: "gemini-3.8-flash",
    });
    expect(calls[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent",
    );
    expect(calls[0]?.headers.get("x-goog-api-key")).toBe("g1");
    expect(calls[0]?.url).not.toContain("g1");
    expect(calls[0]?.body).toMatchObject({
      systemInstruction: { parts: [{ text: "sys" }] },
      contents: [{ role: "user", parts: [{ text: "usr" }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: GEMINI_RESPONSE_SCHEMA,
      },
    });
  });

  it("falls back to the second key on 503 high demand and on 429", async () => {
    const a = queuedFetch([highDemand, ok("{}")]);
    await expect(
      new GeminiProvider({ apiKeys: ["g1", "g2"], fetch: a.fetch, backoff: noSleep }).complete(request),
    ).resolves.toMatchObject({ text: "{}" });
    expect(a.calls.map((c) => c.headers.get("x-goog-api-key"))).toEqual(["g1", "g2"]);

    const b = queuedFetch([json(429, { error: { code: 429 } }), ok("{}")]);
    await new GeminiProvider({ apiKeys: ["g1", "g2"], fetch: b.fetch, backoff: noSleep }).complete(request);
    expect(b.calls.map((c) => c.headers.get("x-goog-api-key"))).toEqual(["g1", "g2"]);
  });

  it("backs off and walks the keys again when both are overloaded", async () => {
    const slept: number[] = [];
    const { fetch, calls } = queuedFetch([highDemand, highDemand, highDemand, ok("{}")]);
    const p = new GeminiProvider({
      apiKeys: ["g1", "g2"],
      fetch,
      backoff: { baseDelayMs: 1000, sleep: async (ms) => void slept.push(ms) },
    });
    await expect(p.complete(request)).resolves.toMatchObject({ text: "{}" });
    expect(calls.map((c) => c.headers.get("x-goog-api-key"))).toEqual(["g1", "g2", "g1", "g2"]);
    expect(slept).toEqual([1000]);
  });

  it("does not retry or fall back on a 400", async () => {
    const { fetch, calls } = queuedFetch([json(400, { error: { code: 400, message: "bad schema" } })]);
    await expect(
      new GeminiProvider({ apiKeys: ["g1", "g2"], fetch, backoff: noSleep }).complete(request),
    ).rejects.toMatchObject({ retryable: false, status: 400 });
    expect(calls).toHaveLength(1);
  });

  it("returns empty text for a safety-blocked candidate and skips thought parts", async () => {
    const blocked = queuedFetch([json(200, { candidates: [{ finishReason: "SAFETY" }], modelVersion: "v" })]);
    await expect(
      new GeminiProvider({ apiKeys: ["g"], fetch: blocked.fetch, backoff: noSleep }).complete(request),
    ).resolves.toEqual({ text: "", servedModel: "v" });
    const thoughts = queuedFetch([
      json(200, {
        candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text: "{}" }] } }],
      }),
    ]);
    await expect(
      new GeminiProvider({ apiKeys: ["g"], fetch: thoughts.fetch, backoff: noSleep }).complete(request),
    ).resolves.toEqual({ text: "{}" });
  });

  it("refuses to start without a key", () => {
    expect(() => new GeminiProvider({ apiKeys: [] })).toThrow(/No Gemini API key/);
  });
});

describe("GroqProvider", () => {
  it("posts gpt-oss-120b at temperature 0 in JSON mode with a bearer key", async () => {
    const { fetch, calls } = queuedFetch([
      json(200, { model: "openai/gpt-oss-120b", choices: [{ message: { content: "{}" } }] }),
    ]);
    const p = new GroqProvider({ apiKey: "gk", fetch, backoff: noSleep });
    expect(p.modelId).toBe("groq/openai/gpt-oss-120b");
    await expect(p.complete(request)).resolves.toEqual({ text: "{}", servedModel: "openai/gpt-oss-120b" });
    expect(calls[0]?.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer gk");
    expect(calls[0]?.body).toMatchObject({
      model: "openai/gpt-oss-120b",
      temperature: 0,
      response_format: { type: "json_object" },
    });
  });

  it("waits out a 429 Retry-After", async () => {
    const slept: number[] = [];
    const { fetch } = queuedFetch([
      json(429, { error: { message: "tokens per minute" } }, { "retry-after": "12" }),
      json(200, { choices: [{ message: { content: "{}" } }] }),
    ]);
    const p = new GroqProvider({
      apiKey: "gk",
      fetch,
      backoff: { baseDelayMs: 1000, sleep: async (ms) => void slept.push(ms) },
    });
    await p.complete(request);
    expect(slept).toEqual([12_000]);
  });
});

describe("FallbackProvider", () => {
  const stub = (modelId: string, outcome: string | Error): Provider => ({
    modelId,
    temperature: 0,
    complete: async () => {
      if (outcome instanceof Error) throw outcome;
      return { text: outcome };
    },
  });

  it("reports the primary when it answers", async () => {
    const p = new FallbackProvider(stub("groq/a", "x"), stub("pollinations/b", "y"));
    await expect(p.complete(request)).resolves.toMatchObject({ text: "x", modelId: "groq/a" });
  });

  it("uses the fallback after a retryable failure and reports the model that answered", async () => {
    const reasons: string[] = [];
    const p = new FallbackProvider(
      stub("groq/a", new ProviderError("429", true, 429)),
      stub("pollinations/b", "y"),
      (r) => void reasons.push(r),
    );
    await expect(p.complete(request)).resolves.toMatchObject({ text: "y", modelId: "pollinations/b" });
    expect(reasons).toEqual(["429"]);
  });

  it("does not hide a non-retryable failure", async () => {
    const p = new FallbackProvider(
      stub("groq/a", new ProviderError("bad", false, 400)),
      stub("pollinations/b", "y"),
    );
    await expect(p.complete(request)).rejects.toMatchObject({ status: 400 });
  });
});

describe("providerForJuror", () => {
  it("wraps juror 2 with the Pollinations fallback and juror 3 with Qwen on Groq", async () => {
    const { providerForJuror } = await import("../src/providers/index.ts");
    process.env.GROQ_API_KEY = "test-groq";
    process.env.GEMINI_API_KEY = "test-gemini";
    const j2 = providerForJuror(2);
    const j3 = providerForJuror(3);
    expect(j2).toBeInstanceOf(FallbackProvider);
    expect((j2 as FallbackProvider).fallback.modelId).toBe("pollinations/openai-fast");
    expect(j3.modelId).toBe("google/gemini-flash-latest");
    expect((j3 as FallbackProvider).fallback.modelId).toBe("groq/qwen/qwen3.8-27b");
    expect(providerForJuror(3, false).modelId).toBe("google/gemini-flash-latest");
    delete process.env.GROQ_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });
});
