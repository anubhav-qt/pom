# Channel integration notes

Everything channel-specific lives behind `ChannelAdapter`
(`src/channels/types.ts`). The sync engine, packing UI and label printer never
know which marketplace an order came from.

> **Verification status.** The Meesho importer is proven by
> `npm run verify:meesho`. The Amazon and Flipkart adapters are written against
> the published API documentation but have **not been run against live
> credentials** — nobody can test those without a real seller account. Expect to
> spend a session shaking out field names on first connection. The sync log in
> Settings records the verbatim error from every attempt, which is what you will
> be reading while doing it.

---

## Amazon — SP-API

**Access:** self-serve. Seller Central › Apps & Services › Develop Apps ›
register a **private** application against your own seller account. Since the
2023 auth change no AWS IAM role or request signing is needed — LWA credentials
alone are sufficient, which is why this adapter is plain `fetch`.

**Endpoint:** India sits on the EU endpoint,
`https://sellingpartnerapi-eu.amazon.com`, marketplace ID `A21TJRUUN4KGV`.

| Function | Endpoint | Status |
|---|---|---|
| Orders | `GET /orders/v0/orders` + `/orderItems` | Documented, stable |
| Labels | `GET /mfn/v0/shipments` | Requires Buy Shipping — see below |
| Inventory | `PATCH /listings/2021-08-01/items/{sellerId}/{sku}` | Verify `productType` |
| Returns | — | Not implemented |

### Labels — this account is Easy Ship

Confirmed against live credentials (2026-08-31): the seller ships **Easy Ship**,
and the SP-API app is **not** authorised for the Merchant Fulfillment role —
`GET /mfn/v0/shipments` returns `403 Unauthorized`. So `fetchLabels` cannot
work here. Everything else the app uses is live and verified: `getOrders`,
`orderItems` (ASIN present), Catalog Items images, and the All-Orders Report.

Label download and pickup scheduling need the **Easy Ship API**
(`/easyShip/2022-03-23/packages`): list handover slots → create a scheduled
package → retrieve the label document. It is a stateful flow with its own job
state and is **not built** — it is the next milestone. Until then labels are
printed from Seller Central.

`fetchLabels` (below) is the Buy Shipping path, kept for any account that does
use Merchant Fulfillment.

### Buy Shipping labels

`fetchLabels` reads the label off a Merchant Fulfillment (Buy Shipping) shipment.
That only exists if the shipment was purchased through Amazon's Buy Shipping
flow.

**If your dad uses Easy Ship** (he does — see above), this is the wrong path.
Easy Ship labels come from the Easy Ship API
(`/easyShip/2022-03-23/packages`), which is a stateful flow: list handover
slots → create a scheduled package → retrieve documents. That needs its own
persisted job state and is a follow-up, not a v1 line item. Until then, Amazon
labels can be printed from Seller Central and the orders packed through the scan
screen as normal.

### Inventory

The Listings Items `PATCH` updates one SKU per call. At a few hundred changed
SKUs a day that stays inside rate limits and avoids the Feeds API's
submit-and-poll round trip. The `productType` field is set to `PRODUCT` as a
generic; if Amazon rejects it, fetch the real product type from the Product Type
Definitions API and store it per listing.

### Returns

Deliberately not implemented. SP-API exposes MFN return data only through the
**asynchronous Reports API**: create a report, poll until it is ready, download
a document, parse TSV. That spans more wall time than one serverless invocation
and needs a persisted job table. Cancellations and RTO still arrive through
order status changes in `fetchOrders`, which covers the day-to-day case.

To add it: a `report_jobs` table, cron step 1 requests
`GET_XML_RETURNS_DATA_BY_RETURN_DATE`, cron step 2 polls and ingests.

---

## Flipkart — Marketplace Seller API v3

**Access:** self-serve. Seller Dashboard › Manage Profile › **Developer Access**
› create a self-access application. The dashboard login itself does not grant API
access; the app credentials are separate.

**Auth:** OAuth2 client credentials —
`GET /oauth-service/oauth/token?grant_type=client_credentials&scope=Seller_Api`
with `Authorization: Basic base64(appId:appSecret)`.

| Function | Endpoint | Status |
|---|---|---|
| Orders | `POST /sellers/v3/shipments/filter` | Documented |
| Labels | `GET /sellers/v3/shipments/labels?shipmentIds=` | Max 50 per call |
| Returns | `GET /sellers/v3/returns` | **Query params need verifying** |
| Inventory | `POST /sellers/skus/{sku}/inventory` | **Body shape needs verifying** |

### Shipments, not orders

Flipkart's unit of work is the *shipment*. One order can fan out into several
shipments picked and labelled independently, so this adapter treats each
shipment as one canonical order keyed by `shipmentId`. That is what actually
gets packed and handed to a courier, and it keeps the packing screen honest.

Consequence: the ID shown in the queue for a Flipkart row is a shipment ID, not
the order ID a customer would quote. If that becomes a support problem, add the
parent order ID as a second searchable column.

### Labels

Flipkart returns one merged PDF for up to 50 shipments. The adapter returns that
merged blob under the first order ID of the chunk rather than splitting it — the
print service merges across channels anyway. Note this means Flipkart label pages
land as a block rather than interleaved in exact queue order. If the packing
bench needs strict 1:1 ordering, split the returned PDF the same way
`splitMeeshoLabels` does.

### Needs verifying on first connection

- The `/sellers/v3/returns` query parameters (`source`, `createdAfter`) and the
  response envelope key (`returnItems`).
- The inventory update body. Flipkart has moved this endpoint between versions;
  confirm against the live docs for your account and check `locationId`.

---

## Meesho — file import

**There is no self-serve supplier API.** Meesho's Supplier Hub API exists, but
credentials (`Client-id`, `Secret-key`, `supplier_identifier`) are issued during
partner onboarding to integration platforms, not to individual suppliers. Do not
plan around getting them.

So: `MeeshoAdapter` reports `supportsLiveSync: false`, and everything real
happens in two functions used by `/api/import/meesho`.

### `parseMeeshoOrderSheet(buffer)`

Reads the supplier-panel XLSX/CSV export.

Columns are matched by **normalised alias**, not exact string, because Meesho
renames headers regularly and the same concept appears differently across export
types. The alias table is at the top of `src/channels/meesho.ts` — including
Meesho's actual misspelling, `"Supplier Discounted Price (Incl GST and
Commision)"`.

Any header that matches nothing is returned in `unmappedColumns` and shown after
import. **This is the early-warning system**: if Meesho renames a column, you
see it on screen the same day rather than discovering it as quietly missing data
three weeks later.

One row is one sub-order, and a sub-order is what gets packed, so each row
becomes its own order.

Status mapping order matters — `"Ready to Ship"` contains `"ship"`, so the
ready-to-pack test must run before the shipped test. Getting that wrong marks
everything waiting to be packed as already gone. There is a regression test for
it.

### `splitMeeshoLabels(buffer, knownSubOrderIds)`

Splits the combined label PDF into one PDF per sub-order.

Matching works by extracting each page's text with `pdfjs-dist` and searching it
for a sub-order ID **we already know about** — not by guessing Meesho's ID
format, and not by trusting page order. Consequences:

- The label PDF and the order sheet do not need to cover the same set, or be
  downloaded together.
- A format change cannot silently mis-assign a label to the wrong parcel.
- IDs are tried longest-first, so a parent order ID that is a prefix of its
  sub-order IDs cannot win over the more specific match.
- Pages matching nothing (manifest summaries, tax invoices) are reported in
  `unmatchedPages` rather than dropped silently.

Meesho label bytes are the **only** ones stored in the database
(`shipments.label_pdf`), because they came from a file and can never be
re-fetched. Amazon and Flipkart labels are pulled on demand at print time so the
database does not grow by hundreds of MB a month.

### Swapping in a real API later

Implement `fetchOrders`, `fetchReturns`, `fetchLabels` and `pushInventory` on
`MeeshoAdapter`, flip the three `supports*` flags to `true`, and delete the
import form from Settings. Nothing else in the codebase changes — that is the
whole reason the file importer was built behind the adapter interface instead of
as a one-off script.

---

## Adding a fourth channel (Myntra, Ajio, Shopify…)

1. Write `src/channels/<name>.ts` implementing `ChannelAdapter`.
2. Add it to the enum in `src/db/schema.ts` and generate a migration.
3. Register it in `adapterFor()` and add a colour to `CHANNEL_META`
   (`src/channels/index.ts`).
4. Add its credential fields to `CREDENTIAL_FIELDS` in
   `src/app/(app)/settings/settings-client.tsx`.

The sync engine, queue, packing screen, label printer and inventory push all
pick it up with no further changes.
