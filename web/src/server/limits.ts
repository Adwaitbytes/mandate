import "server-only";
import { and, eq, lt, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { rateLimitWindows } from "@/db/schema";
import { retryAfterMs, SlidingWindowLimiter, slidingEstimate } from "@/lib/rate-limit";

const HOUR = 3_600_000;

export type LimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number; scope: "visitor" | "site" };

interface Rule {
  bucket: string;
  key: string;
  limit: number;
  scope: "visitor" | "site";
}

const memory = new Map<string, SlidingWindowLimiter>();
function memoryLimiter(rule: Rule): SlidingWindowLimiter {
  const id = `${rule.bucket}:${rule.limit}`;
  let l = memory.get(id);
  if (!l) {
    l = new SlidingWindowLimiter(rule.limit, HOUR);
    memory.set(id, l);
  }
  return l;
}

async function takeDurable(
  rule: Rule,
  now: number,
): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
  const db = getDb();
  if (!db) throw new Error("no database");
  const start = Math.floor(now / HOUR) * HOUR;
  const windowStart = new Date(start);
  const previousStart = new Date(start - HOUR);
  const [row] = await db
    .insert(rateLimitWindows)
    .values({ bucket: rule.bucket, key: rule.key, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimitWindows.bucket, rateLimitWindows.key, rateLimitWindows.windowStart],
      set: { count: sql`${rateLimitWindows.count} + 1` },
    })
    .returning({ count: rateLimitWindows.count });
  const [prev] = await db
    .select({ count: rateLimitWindows.count })
    .from(rateLimitWindows)
    .where(
      and(
        eq(rateLimitWindows.bucket, rule.bucket),
        eq(rateLimitWindows.key, rule.key),
        eq(rateLimitWindows.windowStart, previousStart),
      ),
    );
  const current = row?.count ?? 1;
  const previous = prev?.count ?? 0;
  const elapsed = now - start;
  if (slidingEstimate(previous, current, elapsed, HOUR) <= rule.limit) return { ok: true };
  // Refused hits do not count against the visitor.
  await giveBack(rule, now);
  return { ok: false, retryAfterMs: retryAfterMs(previous, current - 1, rule.limit, elapsed, HOUR) };
}

async function giveBack(rule: Rule, now: number): Promise<void> {
  const db = getDb();
  if (!db) return;
  const windowStart = new Date(Math.floor(now / HOUR) * HOUR);
  await db
    .update(rateLimitWindows)
    .set({ count: sql`greatest(${rateLimitWindows.count} - 1, 0)` })
    .where(
      and(
        eq(rateLimitWindows.bucket, rule.bucket),
        eq(rateLimitWindows.key, rule.key),
        eq(rateLimitWindows.windowStart, windowStart),
      ),
    );
}

async function take(rule: Rule, now: number): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
  if (getDb()) {
    try {
      return await takeDurable(rule, now);
    } catch (err) {
      // The database being down must not open the relayer to unlimited use: fall back to this instance's memory.
      console.error(
        "rate limit: database unavailable, using memory",
        err instanceof Error ? err.message : err,
      );
    }
  }
  const r = memoryLimiter(rule).take(rule.key, now);
  return r.allowed ? { ok: true } : { ok: false, retryAfterMs: r.retryAfterMs };
}

async function refund(rule: Rule, now: number): Promise<void> {
  if (getDb()) {
    try {
      await giveBack(rule, now);
      return;
    } catch (err) {
      console.error("rate limit: refund failed", err instanceof Error ? err.message : err);
    }
  }
  memoryLimiter(rule).refund(rule.key);
}

function intFromEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export function proposeRules(ipKey: string): Rule[] {
  return [
    {
      bucket: "propose-ip",
      key: ipKey,
      limit: intFromEnv("PROPOSE_LIMIT_PER_IP_PER_HOUR", 3),
      scope: "visitor",
    },
    {
      bucket: "propose-global",
      key: "all",
      limit: intFromEnv("PROPOSE_LIMIT_GLOBAL_PER_HOUR", 20),
      scope: "site",
    },
  ];
}

/** Takes one slot from every rule, or none: a refusal by a later rule gives back the earlier ones. */
export async function takeAll(rules: Rule[], now = Date.now()): Promise<LimitResult> {
  const taken: Rule[] = [];
  for (const rule of rules) {
    const r = await take(rule, now);
    if (!r.ok) {
      await Promise.all(taken.map((t) => refund(t, now)));
      return { allowed: false, retryAfterMs: r.retryAfterMs, scope: rule.scope };
    }
    taken.push(rule);
  }
  return { allowed: true };
}

export async function refundAll(rules: Rule[], now = Date.now()): Promise<void> {
  await Promise.all(rules.map((r) => refund(r, now)));
}

/** Old windows are useless after two hours; trimmed opportunistically. */
export async function pruneWindows(now = Date.now()): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db.delete(rateLimitWindows).where(lt(rateLimitWindows.windowStart, new Date(now - 2 * HOUR)));
}
