import type { FetchLike } from "../src/providers/types.ts";

export interface RecordedCall {
  url: string;
  headers: Headers;
  body: unknown;
}

/** A fetch stub that replays queued responses and records each request. */
export function queuedFetch(responses: Array<() => Response>): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const rawBody = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    calls.push({ url, headers, body: typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody });
    const next = responses.shift();
    if (next === undefined) throw new Error(`unexpected request ${calls.length} to ${url}`);
    return next();
  };
  return { fetch: fetchImpl, calls };
}

export const json =
  (status: number, body: unknown, headers: Record<string, string> = {}): (() => Response) =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

export const VALID_VERDICT = {
  support: "against",
  confidence: 90,
  injection_attempt: false,
  rationale: "Spends far more than the mandate allows.",
  cited_mandate_clauses: ["1"],
};
