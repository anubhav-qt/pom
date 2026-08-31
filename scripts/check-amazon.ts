/**
 * Amazon SP-API connectivity check.
 *
 *   npm run check:amazon -- <refreshToken> [--sandbox] [--seller A10KPI1W0W9ZRC]
 *
 * Or, once an account is saved in the app:
 *
 *   npm run check:amazon
 *
 * Walks the chain one step at a time — env vars, LWA token exchange, an actual
 * API call — and stops at the first thing that breaks, printing Amazon's own
 * error rather than a wrapped one. Most SP-API problems are a wrong client
 * secret, an unauthorised app, or the wrong endpoint region, and each of those
 * fails at a different step here.
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";

const SANDBOX = {
  marketplaceId: "ATVPDKIKX0DER",
  createdAfter: "TEST_CASE_200",
  orderId: "TEST_CASE_200",
};

function ok(msg: string) {
  console.log(`  [32m✓[0m ${msg}`);
}
function bad(msg: string) {
  console.log(`  [31m✗[0m ${msg}`);
}
function info(msg: string) {
  console.log(`    ${msg}`);
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(`--${name}`);
  const value = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };

  let refreshToken = args.find((a) => !a.startsWith("--") && a.startsWith("Atzr"));
  let sellerId = value("seller");
  let sandbox = flag("sandbox");

  /* --------------------------------------------------- 1. configuration -- */

  console.log("\n1. Configuration");

  const clientId = process.env.AMAZON_LWA_CLIENT_ID;
  const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET;

  if (!clientId) return bad("AMAZON_LWA_CLIENT_ID is not set in .env.local");
  if (!clientSecret) return bad("AMAZON_LWA_CLIENT_SECRET is not set in .env.local");

  ok(`client ID present (${clientId.slice(0, 24)}…)`);
  if (!clientId.startsWith("amzn1.application-oa2-client.")) {
    bad("that does not look like an LWA client ID — expected it to start with amzn1.application-oa2-client.");
  }
  ok(`client secret present (${clientSecret.length} chars)`);

  // Fall back to a saved account if no token was passed on the command line.
  if (!refreshToken) {
    try {
      const { db } = await import("../src/db");
      const { channelAccounts } = await import("../src/db/schema");
      const { eq } = await import("drizzle-orm");

      const accounts = await db
        .select()
        .from(channelAccounts)
        .where(eq(channelAccounts.channel, "amazon"));

      // Prefer a real-looking token — demo seed data would otherwise win just
      // by having a lower id, and send you chasing a failure that is not yours.
      const account =
        accounts.find((a) =>
          String((a.credentials as Record<string, string>)?.refreshToken ?? "").startsWith("Atzr|"),
        ) ?? accounts[0];

      const creds = account?.credentials as Record<string, string> | undefined;
      if (creds?.refreshToken) {
        refreshToken = creds.refreshToken;
        sellerId ??= creds.sellerId;
        sandbox ||= creds.sandbox === "true";
        ok(`using the saved account "${account.label}"`);
      }
    } catch {
      info("(no database reachable — pass the refresh token as an argument instead)");
    }
  }

  if (!refreshToken) {
    bad("no refresh token");
    info("Pass it directly:  npm run check:amazon -- Atzr|IwEBI... --sandbox");
    info("Get it from Seller Central › Develop Apps › Edit App ▾ › Authorize › Authorize app");
    process.exitCode = 1;
    return;
  }
  ok(`refresh token present (${refreshToken.slice(0, 12)}…)`);
  if (!refreshToken.startsWith("Atzr|")) {
    bad("that does not look like a refresh token — expected it to start with Atzr|");
  }

  const production =
    process.env.AMAZON_SPAPI_ENDPOINT ?? "https://sellingpartnerapi-eu.amazon.com";
  const endpoint = sandbox ? production.replace("https://", "https://sandbox.") : production;
  const marketplaceId = sandbox
    ? SANDBOX.marketplaceId
    : (process.env.AMAZON_MARKETPLACE_ID ?? "A21TJRUUN4KGV");

  ok(`mode: ${sandbox ? "SANDBOX (mock data)" : "PRODUCTION (real data)"}`);
  info(`endpoint     ${endpoint}`);
  info(`marketplace  ${marketplaceId}`);
  info(`seller id    ${sellerId ?? "(not provided — only needed for inventory writes)"}`);

  /* ------------------------------------------------------- 2. LWA token -- */

  console.log("\n2. Login with Amazon token exchange");

  const tokenRes = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  const tokenBody = await tokenRes.text();

  if (!tokenRes.ok) {
    bad(`LWA returned ${tokenRes.status}`);
    info(tokenBody);
    console.log("\n  What this usually means:");
    info("invalid_client       → client ID or secret is wrong");
    info("invalid_grant        → refresh token is wrong, revoked, or from a different app");
    info("unauthorized_client  → the app is not authorised for this seller account");
    process.exitCode = 1;
    return;
  }

  const { access_token: accessToken, expires_in } = JSON.parse(tokenBody) as {
    access_token: string;
    expires_in: number;
  };
  ok(`access token minted, valid ${expires_in}s`);

  /* -------------------------------------------------------- 3. getOrders -- */

  console.log("\n3. Orders API call");

  const url = new URL("/orders/v0/orders", endpoint);
  url.searchParams.set("MarketplaceIds", marketplaceId);
  if (sandbox) {
    url.searchParams.set("CreatedAfter", SANDBOX.createdAfter);
  } else {
    url.searchParams.set(
      "LastUpdatedAfter",
      new Date(Date.now() - 7 * 86_400_000).toISOString(),
    );
    url.searchParams.set("MaxResultsPerPage", "10");
  }

  info(`GET ${url.pathname}?${url.searchParams.toString()}`);

  const res = await fetch(url, {
    headers: { "x-amz-access-token": accessToken, "content-type": "application/json" },
  });
  const body = await res.text();

  if (!res.ok) {
    bad(`SP-API returned ${res.status}`);
    info(body);
    console.log("\n  What this usually means:");
    info("403 Unauthorized     → app lacks the required role, or wrong endpoint region");
    info("403 with sandbox     → check the account is really a sandbox app");
    info("404                  → wrong endpoint host for your marketplace");
    info("400 InvalidInput     → in sandbox, parameters must match the mock exactly");
    process.exitCode = 1;
    return;
  }

  const parsed = JSON.parse(body) as {
    payload?: { Orders?: unknown[]; NextToken?: string };
  };
  const orders = parsed.payload?.Orders ?? [];

  ok(`call succeeded — ${orders.length} order(s) returned`);

  if (orders.length > 0) {
    const first = orders[0] as Record<string, unknown>;
    console.log("\n  First order, as Amazon returned it:");
    console.log(
      JSON.stringify(first, null, 2)
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n"),
    );

    // The fields most likely to be missing are the PII ones, and knowing that
    // now is better than discovering it when the queue renders blank columns.
    const address = first.ShippingAddress as Record<string, unknown> | undefined;
    console.log("\n  Field availability:");
    for (const [label, present] of [
      ["order id", !!first.AmazonOrderId],
      ["status", !!first.OrderStatus],
      ["purchase date", !!first.PurchaseDate],
      ["order total", !!first.OrderTotal],
      ["buyer name (PII)", !!address?.Name],
      ["street address (PII)", !!(address?.AddressLine1)],
      ["city / state / postcode", !!(address?.City ?? address?.PostalCode)],
    ] as [string, boolean][]) {
      (present ? ok : bad)(label);
    }

    if (!address?.Name) {
      info("");
      info("Missing PII is expected without the Direct-to-Consumer Shipping role.");
      info("It does not block order, revenue or SKU analytics.");
    }
  }

  console.log(
    `\n[32mAll checks passed.[0m${
      sandbox ? " Remember: sandbox data is fictional." : ""
    }\n`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("\nUnexpected failure:\n", err);
  process.exit(1);
});
