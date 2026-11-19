import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../src/providers/anthropic.ts";
import { OllamaProvider } from "../src/providers/ollama.ts";
import { PollinationsProvider, parseRetryAfter } from "../src/providers/pollinations.ts";
import { ProviderError } from "../src/providers/types.ts";
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
    const p = new PollinationsProvider({ fetch, backoff: noSleep });
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
      backoff: { baseDelayMs: 1000, sleep: async (ms) => void slept.push(ms) },
    });
    await expect(p.complete(request)).resolves.toEqual({ text: "{}" });
    expect(calls).toHaveLength(3);
    expect(slept).toEqual([7000, 2000]);
  });

  it("gives up after the retry budget and does not retry a 400", async () => {
    const failing = queuedFetch([json(500, {}), json(500, {}), json(500, {})]);
    await expect(
      new PollinationsProvider({ fetch: failing.fetch, backoff: { retries: 2, ...noSleep } }).complete(
        request,
      ),
    ).rejects.toMatchObject({ retryable: true, status: 500 });
    expect(failing.calls).toHaveLength(3);

    const bad = queuedFetch([json(400, { error: "bad" })]);
    await expect(
      new PollinationsProvider({ fetch: bad.fetch, backoff: noSleep }).complete(request),
    ).rejects.toMatchObject({ retryable: false, status: 400 });
    expect(bad.calls).toHaveLength(1);
  });

  it("retries a network error and an unexpected body shape", async () => {
    let n = 0;
    const p = new PollinationsProvider({
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
