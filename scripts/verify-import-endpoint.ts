/**
 * Drive the Meesho import HTTP endpoint against a running dev server, exactly
 * as the browser form does — multipart upload, real session cookie.
 *
 *   npm run dev            # in one terminal
 *   npx tsx scripts/verify-import-endpoint.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { config } from "dotenv";

config({ path: ".env.local" });

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

async function main() {
  /* ---------------------------------------------------------------- login -- */

  const loginRes = await fetch(`${BASE}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "dad@paribelle.test", password: "password123" }),
  });

  // Next.js server actions are not plain form posts, so drive the session the
  // same way a browser would: hit the action endpoint and keep the cookie.
  let cookie = loginRes.headers.getSetCookie?.().join("; ") ?? "";

  if (!cookie.includes("oms_session")) {
    console.log("Form login did not return a session cookie (expected — server actions).");
    console.log("Minting one directly instead so the endpoint can still be exercised.");

    const { SignJWT } = await import("jose");
    const { db } = await import("../src/db");
    const { users } = await import("../src/db/schema");
    const { eq } = await import("drizzle-orm");

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, "dad@paribelle.test"))
      .limit(1);

    if (!user) throw new Error("Run `npm run seed:demo` first.");

    const token = await new SignJWT({ uid: user.id, role: user.role })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));

    cookie = `oms_session=${token}`;
  }

  /* --------------------------------------------------------------- upload -- */

  const sheet = readFileSync(join(process.cwd(), "tmp", "meesho-orders.xlsx"));
  const labels = readFileSync(join(process.cwd(), "tmp", "meesho-labels.pdf"));

  const form = new FormData();
  form.set("accountId", process.env.MEESHO_ACCOUNT_ID ?? "3");
  form.set("sheet", new Blob([sheet]), "meesho-orders.xlsx");
  form.set("labels", new Blob([labels]), "meesho-labels.pdf");

  const res = await fetch(`${BASE}/api/import/meesho`, {
    method: "POST",
    headers: { cookie },
    body: form,
  });

  const json = await res.json();
  console.log(`\nHTTP ${res.status}`);
  console.log(JSON.stringify(json, null, 2));

  if (!res.ok) process.exit(1);

  const { orders, labels: labelSummary } = json.summary;
  const problems: string[] = [];

  if (orders.parsed !== 6) problems.push(`expected 6 rows parsed, got ${orders.parsed}`);
  if (!orders.unmappedSkus?.includes("pb-stl-pch")) {
    problems.push("the unlisted SKU pb-stl-pch should have been reported as unmapped");
  }
  if (labelSummary.attached !== 6) {
    problems.push(`expected 6 labels attached, got ${labelSummary.attached}`);
  }
  if (!labelSummary.unmatchedPages?.includes(7)) {
    problems.push("the trailing summary page should have been reported as unmatched");
  }

  if (problems.length) {
    console.error("\n✗ problems:\n - " + problems.join("\n - "));
    process.exit(1);
  }

  console.log("\n✓ import endpoint behaved correctly end to end");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
