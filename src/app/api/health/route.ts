import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db";

export const dynamic = "force-dynamic";

/**
 * Up and able to reach the database. Docker's health check on the ThinkPad calls
 * this; it needs no login and says nothing beyond the release it's running.
 */
export async function GET() {
  try {
    await Promise.race([
      db.execute(sql`select 1`),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 3000)),
    ]);
  } catch (e) {
    return NextResponse.json({ ok: false, error: `database: ${(e as Error).message}` }, { status: 503 });
  }
  return NextResponse.json({ ok: true, release: process.env.RELEASE || "dev" });
}
