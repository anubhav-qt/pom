/**
 * Read-only probe of the SP-API Notifications API (push instead of polling).
 *
 * Notifications "destination" ops are GRANTLESS — they need a client_credentials
 * token scoped `sellingpartnerapi::notifications`, not the seller refresh token.
 * Subscription ops use the normal seller token.
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

const LWA = "https://api.amazon.com/auth/o2/token";
const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
const r = (s: string) => `\x1b[31m${s}\x1b[0m`;
const y = (s: string) => `\x1b[33m${s}\x1b[0m`;

async function main() {
  const clientId = process.env.AMAZON_LWA_CLIENT_ID!;
  const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET!;
  const endpoint = process.env.AMAZON_SPAPI_ENDPOINT ?? "https://sellingpartnerapi-eu.amazon.com";
  const marketplaceId = process.env.AMAZON_MARKETPLACE_ID ?? "A21TJRUUN4KGV";

  const { db } = await import("../src/db");
  const { channelAccounts } = await import("../src/db/schema");
  const { eq } = await import("drizzle-orm");
  const accounts = await db.select().from(channelAccounts).where(eq(channelAccounts.channel, "amazon"));
  const acct = accounts.find((a) => String((a.credentials as any)?.refreshToken ?? "").startsWith("Atzr|")) ?? accounts[0];
  const refreshToken = (acct?.credentials as any)?.refreshToken as string;

  const mint = async (params: Record<string, string>) => {
    const res = await fetch(LWA, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
    });
    return { ok: res.ok, status: res.status, json: await res.json().catch(() => ({})) as any, text: "" };
  };

  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(new URL(path, endpoint), {
      method,
      headers: { "x-amz-access-token": token, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = {}; try { json = text ? JSON.parse(text) : {}; } catch {}
    return { status: res.status, ok: res.ok, json, text };
  };
  const verdict = (s: number) =>
    s === 403 ? r(`${s} — NOT authorised`) :
    s === 401 ? r(`${s} — token problem`) :
    s >= 200 && s < 300 ? g(`${s} — OK`) :
    s === 400 || s === 404 || s === 422 ? y(`${s} — role granted, rejected on input`) : y(`${s}`);
  const err = (j: any) => (j?.errors?.[0] ? `${j.errors[0].code}: ${j.errors[0].message ?? ""}` : "");

  console.log(`account: ${acct.label}\n`);

  // 1. grantless client_credentials token
  const cc = await mint({ grant_type: "client_credentials", scope: "sellingpartnerapi::notifications" });
  console.log(`1. client_credentials token (scope sellingpartnerapi::notifications): ${cc.ok ? g("minted") : r(cc.status + " " + JSON.stringify(cc.json))}`);
  if (cc.ok) {
    const dest = await call(cc.json.access_token, "GET", "/notifications/v1/destinations");
    console.log(`   GET /notifications/v1/destinations  -> ${verdict(dest.status)}  ${err(dest.json)}`);
    if (dest.ok) console.log(`   ${dest.text.slice(0, 300)}`);
  }

  // 2. seller token — subscription lookups for the useful notification types
  const st = await mint({ grant_type: "refresh_token", refresh_token: refreshToken });
  if (!st.ok) throw new Error("seller token mint failed");
  const token = st.json.access_token;
  console.log(`\n2. subscription lookups (seller token):`);
  for (const nt of ["ORDER_CHANGE", "ORDER_STATUS_CHANGE", "FBA_OUTBOUND_SHIPMENT_STATUS", "EASYSHIP_DOCUMENTS", "ANY_OFFER_CHANGED"]) {
    const s = await call(token, "GET", `/notifications/v1/subscriptions/${nt}`);
    console.log(`   ${nt.padEnd(30)} ${verdict(s.status)}  ${err(s.json)}`);
  }

  console.log("");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
