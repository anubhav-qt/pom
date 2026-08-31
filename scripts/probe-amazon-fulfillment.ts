/**
 * Read-only probe: what fulfilment surface does THIS SP-API app actually have?
 *
 *   npm run probe:amazon
 *
 * Checks, without ever creating/buying/mutating anything:
 *  - Easy Ship API      (label + pickup-slot flow for Easy Ship sellers)
 *  - Merchant Fulfilment / Buy Shipping (self-ship label purchase)
 *  - Shipping API v2     (unified Buy Shipping)
 *  - Notifications API   (push instead of polling — destinations + ORDER_CHANGE)
 *  - Feeds API           (bulk pushes)
 *
 * For each: 200/400/404 => the app HAS the role (endpoint reachable);
 * 403 => the app is NOT authorised for that role.
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";

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
  const acct =
    accounts.find((a) => String((a.credentials as Record<string, string>)?.refreshToken ?? "").startsWith("Atzr|")) ??
    accounts[0];
  const refreshToken = (acct?.credentials as Record<string, string>)?.refreshToken;
  if (!refreshToken) throw new Error("no saved Amazon account with a refresh token");
  console.log(`account: ${acct.label}\nendpoint: ${endpoint}  marketplace: ${marketplaceId}\n`);

  const tok = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  if (!tok.ok) throw new Error(`LWA ${tok.status}: ${await tok.text()}`);
  const accessToken = (await tok.json()).access_token as string;

  const api = async (method: string, path: string, query: Record<string, string> = {}, body?: unknown) => {
    const url = new URL(path, endpoint);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: { "x-amz-access-token": accessToken, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = {};
    try { json = text ? JSON.parse(text) : {}; } catch { /* non-json */ }
    return { status: res.status, ok: res.ok, json, text };
  };

  const verdict = (status: number) => {
    if (status === 403) return r("403 — NOT authorised for this role");
    if (status === 401) return r("401 — auth/token problem");
    if (status >= 200 && status < 300) return g(`${status} — reachable, role granted`);
    if (status === 400 || status === 404 || status === 422) return y(`${status} — role granted (call rejected on input, not auth)`);
    return y(`${status}`);
  };
  const firstErr = (j: any) => j?.errors?.[0]?.code ? `${j.errors[0].code}: ${j.errors[0].message ?? ""}` : "";

  // Grab one real recent order id + show its Easy Ship fields.
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const ord = await api("GET", "/orders/v0/orders", { MarketplaceIds: marketplaceId, LastUpdatedAfter: since, MaxResultsPerPage: "20" });
  const orders = (ord.json?.payload?.Orders ?? []) as any[];
  const sample = orders.find((o) => o.EasyShipShipmentStatus) ?? orders[0];
  const orderId: string | undefined = sample?.AmazonOrderId;
  console.log(`sample order: ${orderId ?? "(none in last 30d)"}`);
  if (sample) {
    console.log(`  OrderStatus=${sample.OrderStatus}  EasyShipShipmentStatus=${sample.EasyShipShipmentStatus ?? "-"}  FulfillmentChannel=${sample.FulfillmentChannel}  ShipmentServiceLevelCategory=${sample.ShipmentServiceLevelCategory ?? "-"}`);
  }
  console.log("");

  const rows: [string, Awaited<ReturnType<typeof api>>][] = [];

  rows.push(["Easy Ship — getScheduledPackage (GET /easyShip/2022-03-23/package)",
    await api("GET", "/easyShip/2022-03-23/package", orderId ? { amazonOrderId: orderId, marketplaceId } : { marketplaceId })]);

  rows.push(["Easy Ship — listHandoverSlots (POST /easyShip/2022-03-23/timeSlot)",
    await api("POST", "/easyShip/2022-03-23/timeSlot", {}, orderId
      ? { amazonOrderId: orderId, marketplaceId, packageDimensions: { length: 20, width: 20, height: 5, unit: "Cm" }, packageWeight: { value: 500, unit: "g" } }
      : { marketplaceId })]);

  rows.push(["Merchant Fulfilment — getShipments (GET /mfn/v0/shipments)",
    await api("GET", "/mfn/v0/shipments", orderId ? { amazonOrderId: orderId } : {})]);

  rows.push(["Shipping v2 — getRates (POST /shipping/v2/shipments/rates)",
    await api("POST", "/shipping/v2/shipments/rates", {}, {})]);

  rows.push(["Notifications — getDestinations (GET /notifications/v1/destinations)",
    await api("GET", "/notifications/v1/destinations")]);

  rows.push(["Notifications — getSubscription ORDER_CHANGE (GET /notifications/v1/subscriptions/ORDER_CHANGE)",
    await api("GET", "/notifications/v1/subscriptions/ORDER_CHANGE")]);

  rows.push(["Feeds — getFeeds (GET /feeds/2021-06-30/feeds)",
    await api("GET", "/feeds/2021-06-30/feeds", { feedTypes: "POST_ORDER_FULFILLMENT_DATA", marketplaceIds: marketplaceId })]);

  console.log("── results ─────────────────────────────────────────────");
  for (const [label, res] of rows) {
    console.log(`\n${label}`);
    console.log(`  ${verdict(res.status)}`);
    const e = firstErr(res.json);
    if (e) console.log(`  ${e}`);
    else if (res.text && res.status < 300) console.log(`  ${res.text.slice(0, 200)}`);
  }
  console.log("");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
