/**
 * Build the product catalogue from Amazon and map every order line to it.
 *
 *   npm run link:catalogue
 *
 * Reads the seller's live listings report, unions it with every SKU that
 * appears in order history (so delisted-but-sold SKUs keep their mapping),
 * creates one product per SKU, links it through `channel_listings`, seeds an
 * inventory row, and back-fills `order_items.product_id` for the rows that were
 * written before any of this existed.
 *
 * Safe to re-run: hand-edited product fields (cost price, weight, bin location)
 * and any stock count already recorded are left alone.
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const { db } = await import("../src/db");
  const { channelAccounts } = await import("../src/db/schema");
  const { eq } = await import("drizzle-orm");
  const { linkCatalogue } = await import("../src/lib/catalogue");

  const accounts = await db
    .select()
    .from(channelAccounts)
    .where(eq(channelAccounts.channel, "amazon"));

  const account =
    accounts.find((a) =>
      String((a.credentials as Record<string, string>)?.refreshToken ?? "").startsWith("Atzr|"),
    ) ?? accounts[0];

  if (!account) {
    console.error("No Amazon channel account found. Add one under Settings first.");
    process.exit(1);
  }

  console.log(`\nLinking catalogue for "${account.label}".\n`);

  const res = await linkCatalogue(account, {
    onProgress: (step) => console.log(`  ${step}`),
  });

  console.log(
    [
      "",
      `  listings from Amazon   ${res.listingsFetched}`,
      `  sold but not listed    ${res.soldOnlySkus}`,
      `  products created       ${res.productsCreated}`,
      `  products updated       ${res.productsUpdated}`,
      `  channel listings       ${res.listingsLinked}`,
      `  inventory rows created ${res.inventoryRowsCreated}`,
      `  product images set     ${res.productImagesSet}`,
      `  order items linked     ${res.orderItemsLinked}`,
      `  still unmapped         ${res.stillUnmapped}`,
      "",
    ].join("\n"),
  );

  if (res.stillUnmapped > 0) {
    console.log(
      "  Some order lines still have no product. That means a SKU appears on an\n" +
        "  order but in neither the listings report nor order history for this\n" +
        "  account — worth looking at before trusting reserved stock.\n",
    );
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("\nCatalogue link failed:\n", err);
  process.exit(1);
});
