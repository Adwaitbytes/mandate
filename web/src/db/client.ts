import "server-only";
import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";

export type Db = NeonHttpDatabase<typeof schema>;

let db: Db | null | undefined;

/** The database, or null when DATABASE_URL is not set. Callers fall back to memory or to the chain. */
export function getDb(): Db | null {
  if (db !== undefined) return db;
  const url = process.env.DATABASE_URL;
  db = url ? drizzle(neon(url), { schema }) : null;
  return db;
}
