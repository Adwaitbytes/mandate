import { BaseError, fallback, http, type Transport } from "viem";

export interface RpcTransportOptions {
  /** Per-request timeout on one endpoint. */
  timeoutMs?: number;
}

/**
 * HTTP transport over one or more endpoints in failover order. Each endpoint gets a short timeout and no retries
 * of its own, so a stalled public RPC costs one timeout before the next endpoint answers; the fallback then
 * retries the whole list once. Reverts are not failed over (viem throws them at once), so `AlreadyPosted` still
 * surfaces from the first endpoint.
 */
export function rpcTransport(urls: readonly string[], options: RpcTransportOptions = {}): Transport {
  const timeout = options.timeoutMs ?? 8_000;
  const [first, ...rest] = urls;
  if (first === undefined) throw new Error("rpcTransport needs at least one URL");
  if (rest.length === 0) return http(first, { timeout, retryCount: 2, retryDelay: 500 });
  return fallback(
    urls.map((url) => http(url, { timeout, retryCount: 0 })),
    { retryCount: 1, retryDelay: 500 },
  );
}

const TRANSIENT_MESSAGE =
  /time(d)? ?out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|ENETUNREACH|socket hang up|other side closed|fetch failed|UND_ERR|network|rate limit|too many requests|header not found|limit exceeded|temporarily unavailable|service unavailable|bad gateway|gateway timeout/i;
const TRANSIENT_NAMES = new Set([
  "TimeoutError",
  "AbortError",
  "SocketClosedError",
  "WebSocketRequestError",
  "LimitExceededRpcError",
  "InternalRpcError",
  "ResourceUnavailableRpcError",
  "WaitForTransactionReceiptTimeoutError",
]);

/**
 * True for errors a later retry can cure: timeouts, dropped sockets, DNS hiccups, HTTP 408/429/5xx, and RPC
 * "limit exceeded" or internal errors. Walks the whole `cause` chain, since viem wraps transport errors in call
 * errors (`ContractFunctionExecutionError` around `HttpRequestError` around `TimeoutError`).
 */
export function isTransientRpcError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e !== undefined && e !== null && depth < 12; depth++) {
    if (typeof e !== "object") return false;
    const name = (e as { name?: unknown }).name;
    if (typeof name === "string" && TRANSIENT_NAMES.has(name)) return true;
    const status = (e as { status?: unknown }).status;
    if (typeof status === "number" && (status === 408 || status === 429 || status >= 500)) return true;
    const code = (e as { code?: unknown }).code;
    if (code === -32005 || code === -32603 || code === -32002 || code === 429) return true;
    if (typeof code === "string" && TRANSIENT_MESSAGE.test(code)) return true;
    const message = e instanceof BaseError ? e.shortMessage : (e as { message?: unknown }).message;
    if (typeof message === "string" && TRANSIENT_MESSAGE.test(message)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** One line for a log: viem's short message (its full message carries the request body and version banner). */
export function describeError(err: unknown): string {
  if (err instanceof BaseError) return `${err.name}: ${err.shortMessage}`;
  if (err instanceof Error) return `${err.name}: ${err.message.split("\n")[0] ?? ""}`;
  return String(err);
}
