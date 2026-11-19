import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CircuitBreaker, classifyFailure } from "../src/providers/breaker.ts";
import { ProviderChain } from "../src/providers/chain.ts";
import { GroqProvider } from "../src/providers/groq.ts";
import {
  chainSpecsForJuror,
  DEFAULT_CHAIN,
  parseLinkSpec,
  providerForJuror,
} from "../src/providers/index.ts";
import { PollinationsProvider } from "../src/providers/pollinations.ts";
import { type CompletionRequest, type Provider, ProviderError, withBackoff } from "../src/providers/types.ts";
import { json, queuedFetch, VALID_VERDICT } from "./helpers.ts";

const request = { system: "sys", user: "usr" };

const GROQ_TPD = new ProviderError(
  "Groq returned HTTP 429: Rate limit reached for model `openai/gpt-oss-120b` on tokens per day (TPD): Limit 200000",
  true,
  429,
);
const GEMINI_DAILY = new ProviderError(
  'Gemini returned HTTP 429: {"error":{"message":"You exceeded your current quota","status":"RESOURCE_EXHAUSTED","details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}}',
  true,
  429,
);
const GEMINI_MINUTE = new ProviderError(
  'Gemini returned HTTP 429: {"error":{"message":"You exceeded your current quota","details":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}]}}',
  true,
  429,
);
const OVERLOADED = new ProviderError("Gemini returned HTTP 503: high demand", true, 503);

class Clock {
  t = 1_000_000;
  now = (): number => this.t;
}

/** A provider that answers from a script and records each request (with its deadline). */
class Scripted implements Provider {
  readonly temperature = 0;
  readonly requests: CompletionRequest[] = [];
  constructor(
    readonly modelId: string,
    private readonly script: Array<string | Error | ((r: CompletionRequest) => Promise<string>)>,
  ) {}
  async complete(r: CompletionRequest) {
    this.requests.push(r);
    const next = this.script.shift();
    if (next === undefined) throw new Error(`${this.modelId}: script exhausted`);
    if (next instanceof Error) throw next;
    return { text: typeof next === "string" ? next : await next(r), servedModel: this.modelId };
  }
}

describe("classifyFailure", () => {
  it("separates daily caps and rejected keys from transient overload and bad requests", () => {
    expect(classifyFailure(GROQ_TPD)).toBe("quota");
    expect(classifyFailure(GEMINI_DAILY)).toBe("quota");
    expect(classifyFailure(GEMINI_MINUTE)).toBe("transient");
    expect(classifyFailure(OVERLOADED)).toBe("transient");
    expect(
      classifyFailure(new ProviderError("Groq returned HTTP 429: tokens per minute (TPM)", true, 429)),
    ).toBe("transient");
    expect(classifyFailure(new ProviderError("Anthropic API 401: invalid x-api-key", false, 401))).toBe(
      "quota",
    );
    expect(
      classifyFailure(new ProviderError("Anthropic API 400: Your credit balance is too low", false, 400)),
    ).toBe("quota");
    expect(classifyFailure(new ProviderError("Pollinations returned HTTP 402: FREE_LIMIT", true, 402))).toBe(
      "transient",
    );
    expect(classifyFailure(new ProviderError("Groq request failed: socket hang up", true))).toBe("transient");
    expect(classifyFailure(new ProviderError("Groq returned HTTP 400: bad json", false, 400))).toBe(
      "request",
    );
  });
});

describe("CircuitBreaker", () => {
  it("opens after N consecutive transient failures, half-opens after the cool-down, reopens on a failed trial", () => {
    const clock = new Clock();
    const b = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 60_000, now: clock.now });
    b.onFailure(OVERLOADED);
    expect(b.canCall()).toBe(true);
    b.onFailure(OVERLOADED);
    expect(b.canCall()).toBe(false);
    expect(b.remainingMs()).toBe(60_000);
    clock.t += 60_000;
    expect(b.canCall()).toBe(true);
    b.onFailure(OVERLOADED); // the half-open trial fails: open again at once
    expect(b.canCall()).toBe(false);
    clock.t += 60_000;
    b.onSuccess();
    b.onFailure(OVERLOADED);
    expect(b.canCall()).toBe(true);
  });

  it("opens at once for the long cool-down on a daily cap", () => {
    const clock = new Clock();
    const b = new CircuitBreaker({ cooldownMs: 60_000, quotaCooldownMs: 3_600_000, now: clock.now });
    b.onFailure(GROQ_TPD);
    expect(b.canCall()).toBe(false);
    expect(b.remainingMs()).toBe(3_600_000);
    expect(b.reason).toMatch(/tokens per day/);
  });

  it("resets the count on success and ignores bad-request failures", () => {
    const b = new CircuitBreaker({ failureThreshold: 2 });
    b.onFailure(OVERLOADED);
    b.onSuccess();
    b.onFailure(OVERLOADED);
    expect(b.canCall()).toBe(true);
    b.onFailure(new ProviderError("bad", false, 400));
    expect(b.canCall()).toBe(true);
  });
});

describe("ProviderChain", () => {
  it("returns the first link's answer and names it", async () => {
    const a = new Scripted("groq/openai/gpt-oss-120b", ["x"]);
    const b = new Scripted("pollinations/openai-fast", ["y"]);
    const chain = new ProviderChain([
      { label: a.modelId, provider: a },
      { label: b.modelId, provider: b },
    ]);
    await expect(chain.complete(request)).resolves.toMatchObject({
      text: "x",
      modelId: "groq/openai/gpt-oss-120b",
      passedOver: [],
    });
    expect(b.requests).toHaveLength(0);
  });

  it("falls back in order on any provider failure and records why each link was passed over", async () => {
    const a = new Scripted("google/gemini-flash-latest", [GEMINI_DAILY]);
    const a2 = new Scripted("google/gemini-flash-latest", [
      new ProviderError("Anthropic API 401", false, 401),
    ]);
    const c = new Scripted("groq/qwen/qwen3.8-27b", ["q"]);
    const logs: string[] = [];
    const chain = new ProviderChain(
      [
        { label: "google/gemini-flash-latest#1", provider: a },
        { label: "google/gemini-flash-latest#2", provider: a2 },
        { label: "groq/qwen/qwen3.8-27b", provider: c },
      ],
      { log: (m) => void logs.push(m) },
    );
    const r = await chain.complete(request);
    expect(r).toMatchObject({ text: "q", modelId: "groq/qwen/qwen3.8-27b", temperature: 0 });
    expect(r.passedOver).toHaveLength(2);
    expect(r.passedOver?.[0]).toMatch(/^google\/gemini-flash-latest#1: quota failure/);
    expect(r.passedOver?.[1]).toMatch(/^google\/gemini-flash-latest#2: quota failure/);
    expect(logs.at(-1)).toMatch(/answered by groq\/qwen\/qwen3.8-27b after/);
  });

  it("skips a link whose circuit is open without calling it, then tries it again after the cool-down", async () => {
    const clock = new Clock();
    const groq = new Scripted("groq/openai/gpt-oss-120b", [GROQ_TPD, "back"]);
    const poll = new Scripted("pollinations/openai-fast", ["p1", "p2"]);
    const chain = new ProviderChain(
      [
        { label: groq.modelId, provider: groq },
        { label: poll.modelId, provider: poll },
      ],
      { now: clock.now, breaker: { quotaCooldownMs: 3_600_000 } },
    );
    expect((await chain.complete(request)).text).toBe("p1");
    const second = await chain.complete(request);
    expect(second.text).toBe("p2");
    expect(second.passedOver?.[0]).toMatch(/circuit open 3600 s more/);
    expect(groq.requests).toHaveLength(1);
    clock.t += 3_600_000;
    expect((await chain.complete(request)).text).toBe("back");
    expect(groq.requests).toHaveLength(2);
  });

  it("gives each link a deadline within the link budget and the completion budget", async () => {
    const clock = new Clock();
    const a = new Scripted("a/a", [
      async () => {
        clock.t += 75_000; // spends its whole budget, then fails
        throw OVERLOADED;
      },
    ]);
    const b = new Scripted("b/b", ["ok"]);
    const chain = new ProviderChain(
      [
        { label: "a/a", provider: a },
        { label: "b/b", provider: b },
      ],
      { now: clock.now, linkBudgetMs: 75_000, totalBudgetMs: 100_000 },
    );
    await chain.complete(request);
    expect(a.requests[0]?.deadline).toBe(1_000_000 + 75_000);
    // 25 s of the completion budget remain for the second link.
    expect(b.requests[0]?.deadline).toBe(1_000_000 + 100_000);
  });

  it("stops a link that ignores its deadline and moves on", async () => {
    const hang = new Scripted("hang/h", [() => new Promise<string>(() => {})]);
    const b = new Scripted("b/b", ["ok"]);
    const chain = new ProviderChain(
      [
        { label: "hang/h", provider: hang },
        { label: "b/b", provider: b },
      ],
      { linkBudgetMs: 20 },
    );
    const started = Date.now();
    const r = await chain.complete(request);
    expect(r.text).toBe("ok");
    expect(r.passedOver?.[0]).toMatch(/no answer within its time budget/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("throws a retryable error when no link answers, so the case is retried on the next pass", async () => {
    const chain = new ProviderChain([
      { label: "a/a", provider: new Scripted("a/a", [OVERLOADED]) },
      { label: "b/b", provider: new Scripted("b/b", [GROQ_TPD]) },
    ]);
    const err = await chain.complete(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
    expect((err as ProviderError).message).toMatch(/No provider answered: a\/a: transient .* \| b\/b: quota/);
  });

  it("does not swallow programming errors", async () => {
    const chain = new ProviderChain([
      { label: "a/a", provider: new Scripted("a/a", [new TypeError("bug")]) },
      { label: "b/b", provider: new Scripted("b/b", ["ok"]) },
    ]);
    await expect(chain.complete(request)).rejects.toThrow("bug");
  });
});

describe("deadline-aware retries", () => {
  it("withBackoff does not start a retry whose wait ends past the deadline", async () => {
    const slept: number[] = [];
    let calls = 0;
    const attempt = async () => {
      calls++;
      throw OVERLOADED;
    };
    let t = 0;
    const now = () => t;
    await expect(
      withBackoff(
        attempt,
        {
          retries: 5,
          baseDelayMs: 10_000,
          maxDelayMs: 60_000,
          sleep: async (ms) => {
            slept.push(ms);
            t += ms;
          },
          now,
        },
        undefined,
        25_000,
      ),
    ).rejects.toBe(OVERLOADED);
    // 10 s fits before the 25 s deadline; 20 s does not, so the error is thrown instead of sleeping.
    expect(slept).toEqual([10_000]);
    expect(calls).toBe(2);
  });

  it("Pollinations refuses to wait for a free-tier slot that opens after the deadline", async () => {
    const { fetch, calls } = queuedFetch([json(200, { choices: [{ message: { content: "{}" } }] })]);
    let t = 0;
    const p = new PollinationsProvider({
      fetch,
      minIntervalMs: 46_000,
      now: () => t,
      backoff: { sleep: async () => {} },
    });
    await p.complete(request);
    t = 1_000;
    await expect(p.complete({ ...request, deadline: 30_000 })).rejects.toMatchObject({ retryable: true });
    expect(calls).toHaveLength(1);
  });
});

describe("juror chains", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    for (const k of Object.keys(process.env))
      if (
        /^(PROVIDER|JUROR_\d_(PROVIDER|FALLBACK|CHAIN)|(ANTHROPIC|GEMINI|GROQ)_API_KEY(_2)?|.*_MODEL)$/.test(
          k,
        )
      )
        delete process.env[k];
    process.env.ANTHROPIC_API_KEY = "a1";
    process.env.ANTHROPIC_API_KEY_2 = "a2";
    process.env.GEMINI_API_KEY = "g1";
    process.env.GEMINI_API_KEY_2 = "g2";
    process.env.GROQ_API_KEY = "gq";
  });
  afterEach(() => {
    process.env = { ...saved };
  });
  const quiet = { log: () => {} };

  it("builds the documented chains, one link per key, never a local model", () => {
    expect(providerForJuror(1, quiet).labels).toEqual([
      "anthropic/claude-haiku-5-5#1",
      "anthropic/claude-haiku-5-5#2",
    ]);
    expect(providerForJuror(2, quiet).labels).toEqual([
      "groq/openai/gpt-oss-120b",
      "pollinations/openai-fast",
      "groq/openai/gpt-oss-20b",
    ]);
    expect(providerForJuror(3, quiet).labels).toEqual([
      "google/gemini-flash-latest#1",
      "google/gemini-flash-latest#2",
      "groq/qwen/qwen3.8-27b",
    ]);
    for (const chain of Object.values(DEFAULT_CHAIN))
      expect(chain.some((s) => s.startsWith("ollama"))).toBe(false);
  });

  it("keeps the families apart across jurors", () => {
    const family = (label: string) =>
      label.startsWith("anthropic/")
        ? "claude"
        : label.includes("gpt-oss") || label.includes("openai-fast")
          ? "gpt-oss"
          : label.includes("gemini")
            ? "gemini"
            : label.includes("qwen")
              ? "qwen"
              : label;
    const f1 = new Set(providerForJuror(1, quiet).labels.map(family));
    const f2 = new Set(providerForJuror(2, quiet).labels.map(family));
    const f3 = new Set(providerForJuror(3, quiet).labels.map(family));
    expect([...f1]).toEqual(["claude"]);
    expect([...f2]).toEqual(["gpt-oss"]);
    expect([...f3]).toEqual(["gemini", "qwen"]);
  });

  it("leaves out a link whose key is missing and says so", () => {
    delete process.env.GEMINI_API_KEY_2;
    delete process.env.GEMINI_API_KEY;
    const logs: string[] = [];
    const chain = providerForJuror(3, { log: (m) => void logs.push(m) });
    expect(chain.labels).toEqual(["groq/qwen/qwen3.8-27b"]);
    expect(logs[0]).toMatch(/left out of the chain: gemini: No Gemini API key/);
  });

  it("honours JUROR_<n>_CHAIN, PROVIDER and JUROR_<n>_FALLBACK=none", () => {
    process.env.JUROR_3_CHAIN = "gemini#2,groq:qwen/qwen3.8-27b";
    expect(providerForJuror(3, quiet).labels).toEqual([
      "google/gemini-flash-latest#2",
      "groq/qwen/qwen3.8-27b",
    ]);
    process.env.PROVIDER = "pollinations";
    expect(chainSpecsForJuror(2)).toEqual(["pollinations", "pollinations", "groq:openai/gpt-oss-20b"]);
    expect(providerForJuror(2, quiet).labels).toEqual([
      "pollinations/openai-fast",
      "groq/openai/gpt-oss-20b",
    ]);
    process.env.JUROR_2_FALLBACK = "none";
    expect(providerForJuror(2, quiet).labels).toEqual(["pollinations/openai-fast"]);
    expect(providerForJuror(1, { ...quiet, withFallback: false }).labels).toEqual([
      "pollinations/openai-fast",
    ]);
  });

  it("parses link specs and rejects a key slot on a single-key provider", () => {
    expect(parseLinkSpec("groq:qwen/qwen3.8-27b")).toEqual({ provider: "groq", model: "qwen/qwen3.8-27b" });
    expect(parseLinkSpec("gemini#2")).toEqual({ provider: "gemini", keySlot: 2 });
    expect(() => parseLinkSpec("groq#2")).toThrow(/only anthropic and gemini/);
    expect(() => parseLinkSpec("openrouter")).toThrow(/Unknown provider/);
  });
});

describe("juror 2 fallback order over mocked HTTP", () => {
  it("Groq's daily cap opens its breaker; the next case goes straight to Pollinations without a Groq call", async () => {
    const verdict = JSON.stringify(VALID_VERDICT);
    const groqFetch = queuedFetch([
      json(429, {
        error: {
          message: "Rate limit reached for model `openai/gpt-oss-120b` on tokens per day (TPD): Limit 200000",
        },
      }),
    ]);
    const pollFetch = queuedFetch([
      json(200, { model: "gpt-oss-20b", choices: [{ message: { content: verdict } }] }),
      json(200, { model: "gpt-oss-20b", choices: [{ message: { content: verdict } }] }),
    ]);
    const groq = new GroqProvider({
      apiKey: "gk",
      fetch: groqFetch.fetch,
      backoff: { sleep: async () => {} },
    });
    const poll = new PollinationsProvider({
      fetch: pollFetch.fetch,
      minIntervalMs: 0,
      backoff: { sleep: async () => {} },
    });
    const chain = new ProviderChain([
      { label: groq.modelId, provider: groq },
      { label: poll.modelId, provider: poll },
    ]);
    const first = await chain.complete(request);
    expect(first).toMatchObject({ modelId: "pollinations/openai-fast", servedModel: "gpt-oss-20b" });
    // A 429 is retryable by status, but a daily cap is not retried (the 2026-11-19 stall): one request, then the
    // breaker opens and the next case never calls Groq.
    expect(groqFetch.calls).toHaveLength(1);
    const second = await chain.complete(request);
    expect(second.modelId).toBe("pollinations/openai-fast");
    expect(groqFetch.calls).toHaveLength(1);
    expect(second.passedOver?.[0]).toMatch(/^groq\/openai\/gpt-oss-120b: circuit open/);
  });
});
