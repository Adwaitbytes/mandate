import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { rationaleCache } from "@/db/schema";
import { rationaleBaseUrl } from "@/lib/config";
import { rationaleUrl } from "@/lib/rationale";

const MAX_BYTES = 256 * 1024;

/**
 * Serves a juror's rationale document byte for byte, from the database cache or the public store. The path is
 * built from two validated integers, never from a URL the visitor sends. The browser hashes whatever comes back
 * and compares it with the rationaleHash on chain, so this route can make pages faster but cannot make a
 * document pass that does not match.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const caseParam = request.nextUrl.searchParams.get("case") ?? "";
  const jurorParam = request.nextUrl.searchParams.get("juror") ?? "";
  if (!/^\d{1,30}$/.test(caseParam) || !/^\d{1,2}$/.test(jurorParam)) {
    return NextResponse.json({ error: "case and juror must be numbers" }, { status: 400 });
  }
  const url = rationaleUrl(rationaleBaseUrl, BigInt(caseParam), Number(jurorParam));
  if (url === null) return NextResponse.json({ error: "no rationale store is configured" }, { status: 404 });

  const db = getDb();
  if (db) {
    try {
      const [hit] = await db.select().from(rationaleCache).where(eq(rationaleCache.url, url));
      if (hit) return bytes(Buffer.from(hit.body, "base64"), "cache");
    } catch (err) {
      console.error("rationale cache read failed", err instanceof Error ? err.message : err);
    }
  }

  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  } catch {
    return NextResponse.json({ error: "the rationale store did not answer" }, { status: 502 });
  }
  if (response.status === 404) return NextResponse.json({ error: "not published yet" }, { status: 404 });
  if (!response.ok) return NextResponse.json({ error: `store answered ${response.status}` }, { status: 502 });
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > MAX_BYTES) return NextResponse.json({ error: "document too large" }, { status: 502 });

  if (db) {
    try {
      await db
        .insert(rationaleCache)
        .values({ url, body: body.toString("base64") })
        .onConflictDoNothing();
    } catch (err) {
      console.error("rationale cache write failed", err instanceof Error ? err.message : err);
    }
  }
  return bytes(body, "store");
}

function bytes(body: Buffer, source: "cache" | "store"): NextResponse {
  return new NextResponse(new Uint8Array(body), {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
      "x-mandate-source": source,
    },
  });
}
