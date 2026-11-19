import { index, integer, pgSchema, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/** Everything Mandate stores lives in its own schema. The chain is the source of truth; this is counters and cache. */
export const mandate = pgSchema("mandate");

/**
 * Fixed one-hour windows, incremented atomically. The limiter weighs the previous window by how much of it still
 * overlaps the last hour, which approximates a sliding window with two rows per key.
 */
export const rateLimitWindows = mandate.table(
  "rate_limit_windows",
  {
    bucket: text("bucket").notNull(),
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true, mode: "date" }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.bucket, t.key, t.windowStart] }),
    index("rate_limit_windows_start").on(t.windowStart),
  ],
);

/**
 * Rationale documents as fetched from the jurors' public store, byte for byte (base64). The browser hashes what
 * it receives and compares it with the rationaleHash on chain, so a stale or altered row shows as a mismatch
 * rather than passing as verified.
 */
export const rationaleCache = mandate.table("rationale_cache", {
  url: text("url").primaryKey(),
  body: text("body").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});
