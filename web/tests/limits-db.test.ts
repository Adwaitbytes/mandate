import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { rateLimitWindows } from "@/db/schema";
import { takeAll } from "@/server/limits";

// Runs against the real database when DATABASE_URL is set (the schema must be migrated); skipped otherwise.
const db = process.env.DATABASE_URL ? getDb() : null;
const bucket = `test-${randomUUID()}`;

describe.skipIf(db === null)("durable rate limit in Postgres", () => {
  afterAll(async () => {
    await db?.delete(rateLimitWindows).where(eq(rateLimitWindows.bucket, bucket));
    await db?.delete(rateLimitWindows).where(eq(rateLimitWindows.bucket, `${bucket}-site`));
  });

  it("allows the limit, refuses the next, and does not count refusals", async () => {
    const now = Date.UTC(2026, 10, 19, 12, 30);
    const rules = [{ bucket, key: "visitor", limit: 2, scope: "visitor" as const }];
    expect((await takeAll(rules, now)).allowed).toBe(true);
    expect((await takeAll(rules, now + 1)).allowed).toBe(true);
    const refused = await takeAll(rules, now + 2);
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.scope).toBe("visitor");
    const [row] = await (db as NonNullable<typeof db>)
      .select()
      .from(rateLimitWindows)
      .where(and(eq(rateLimitWindows.bucket, bucket), eq(rateLimitWindows.key, "visitor")));
    expect(row?.count).toBe(2);
  });

  it("gives back the visitor slot when the site-wide rule refuses", async () => {
    const now = Date.UTC(2026, 10, 19, 15, 10);
    const visitor = { bucket, key: "v2", limit: 5, scope: "visitor" as const };
    const site = { bucket: `${bucket}-site`, key: "all", limit: 1, scope: "site" as const };
    expect((await takeAll([visitor, site], now)).allowed).toBe(true);
    const r = await takeAll([visitor, site], now + 1);
    expect(r.allowed).toBe(false);
    const [row] = await (db as NonNullable<typeof db>)
      .select()
      .from(rateLimitWindows)
      .where(and(eq(rateLimitWindows.bucket, bucket), eq(rateLimitWindows.key, "v2")));
    expect(row?.count).toBe(1);
  });
});
