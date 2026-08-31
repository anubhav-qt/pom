/**
 * Connect (or reconnect) the real Amazon account, replacing whatever Amazon
 * channel account currently exists — including demo/test data, which this
 * deletes via cascade so it never mixes with real orders in the queue.
 *
 *   npx tsx scripts/connect-amazon.ts "<refreshToken>" "<sellerId>" [label]
 *
 * The token is passed as an argument rather than typed into a file, so
 * nothing durable on disk holds it outside the database.
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const [refreshToken, sellerId, label = "Paribelle — Amazon"] = process.argv.slice(2);

  if (!refreshToken || !sellerId) {
    console.error('Usage: npx tsx scripts/connect-amazon.ts "<refreshToken>" "<sellerId>" [label]');
    process.exit(1);
  }
  if (!refreshToken.startsWith("Atzr|")) {
    console.error("That does not look like a refresh token (expected it to start with Atzr|).");
    process.exit(1);
  }

  const { db } = await import("../src/db");
  const { channelAccounts } = await import("../src/db/schema");
  const { eq } = await import("drizzle-orm");

  const existing = await db
    .select({ id: channelAccounts.id, label: channelAccounts.label })
    .from(channelAccounts)
    .where(eq(channelAccounts.channel, "amazon"));

  for (const acct of existing) {
    // Cascades: orders, order_items, shipments, returns, channel_listings,
    // sync_runs for this account all go with it — so demo data can never end
    // up mixed into the real order queue.
    await db.delete(channelAccounts).where(eq(channelAccounts.id, acct.id));
    console.log(`Removed previous account "${acct.label}" (id ${acct.id}) and its data.`);
  }

  const [created] = await db
    .insert(channelAccounts)
    .values({
      channel: "amazon",
      label,
      credentials: { refreshToken, sellerId },
    })
    .returning({ id: channelAccounts.id });

  console.log(`\nConnected: "${label}" (account id ${created.id}), production mode.`);
  console.log("Run `npm run check:amazon` to verify, then sync from Settings.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
