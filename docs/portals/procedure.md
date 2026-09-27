# Seller portals: fetching Flipkart and Meesho data

Finance (Overview and Ledger) and the in-app assistant count every
marketplace Paribelle sells on. Amazon's orders and money come in by
themselves (its API, every 10 minutes). Flipkart and Meesho give us no API we
can use, so their orders, returns and payments are read off their seller
portals. This is the procedure for that.

It is written for **Claude Code with its built-in browser**: the owner logs
in, Claude reads the portals in the browser and writes what it read into the
database, then reports back. The first run reads everything the portals have.
Every run then writes down, at the end of this file, exactly what to read next
time and from which date, so the next run is quick.

**For now the writes are SQL written by hand each run.** After the first real
run, a script that saves what was read (`npm run portal -- save`) gets built
from the real data, and this file is updated to use it (see
[After the first run](#after-the-first-run-the-save-script)).

Hand it this file and say "run the seller portal procedure" (the prompt is
[at the end](#prompt-to-paste)).

## Ground rules

- **The owner logs in.** Claude never types a password, an OTP or a captcha,
  and never saves a login. If a portal logs out mid-run, stop and ask the
  owner to log in again.
- **Read-only on the portals.** Claude only opens order, return and payment
  pages, sets filters and date ranges, pages through lists and opens an
  order to read it. It never accepts, cancels or ships an order, never
  changes a listing, price or stock, never raises a ticket, never downloads
  a file, and never accepts terms or a pop-up that changes the account. If
  the only way on is a button like that, stop and ask.
- **Only what Finance needs.** Order and item ids, dates, statuses, SKUs,
  quantities, prices, city/state/pincode, return details, and every rupee of
  each payment. No buyer names, phone numbers or street addresses: they are
  never written down, not even in `tmp/`.
- **Writes go through the owner's yes.** Each run's SQL is one file, one
  transaction. Before running it, show the owner what it will write (rows
  per table, the date range, payment totals); run it only after they say go.
  If auto mode refuses to run it against the live database, give the owner
  the command to run themselves.

## Before the run

1. **See what's already in the database.** Save this as
   `tmp/portals/<today>/status.sql` and run it (read-only):

   ```sql
   SELECT ca.id, ca.channel, ca.label,
     (SELECT count(*) FROM orders o WHERE o.channel_account_id = ca.id) AS orders,
     (SELECT max(ordered_at) FROM orders o WHERE o.channel_account_id = ca.id) AS last_order,
     (SELECT count(*) FROM returns r WHERE r.channel_account_id = ca.id) AS returns,
     (SELECT max(requested_at) FROM returns r WHERE r.channel_account_id = ca.id) AS last_return,
     (SELECT count(*) FROM finance_transactions t WHERE t.channel_account_id = ca.id) AS money_lines,
     (SELECT max(posted_at) FROM finance_transactions t WHERE t.channel_account_id = ca.id AND t.type <> 'Transfer') AS last_money,
     (SELECT max(posted_at) FROM finance_transactions t WHERE t.channel_account_id = ca.id AND t.type = 'Transfer') AS last_payout
   FROM channel_accounts ca WHERE ca.channel IN ('flipkart', 'meesho');
   ```

   Running a SQL file (PowerShell, from `E:\oms`; the same line works in Git
   Bash):

   ```powershell
   node --env-file=.env.local -e "const pg=require('pg'),fs=require('fs');const c=new pg.Client({connectionString:process.env.DATABASE_URL});c.connect().then(()=>c.query(fs.readFileSync(process.argv[1],'utf8'))).then(r=>{for(const x of [].concat(r))if(x.rows&&x.rows.length)console.table(x.rows)}).catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>c.end())" tmp/portals/2026-09-28/status.sql
   ```

   The database is the one in `.env.local`: the cloud copy, which the
   ThinkPad's sync copies home within a minute.

2. **Read the [Fetch plan](#fetch-plan)** below: for each page to read, where
   it is, how to read it, and the date to start from ("Next run from": the
   last date read minus 7 days, since writing a row twice just updates it).
   If it says "not read yet", this is the first run: follow
   [The first run](#the-first-run-read-everything).

## Logging in

1. Open the built-in browser on the two portals, one tab each:
   - Flipkart Seller Hub: https://seller.flipkart.com/
   - Meesho Supplier Panel: https://supplier.meesho.com/
2. If either shows its login page, ask the owner to log in there (they type
   in the browser pane) and wait until they say they're in. A login usually
   lasts between runs, so often there is nothing to do.
3. Check it: the portal's dashboard shows the Paribelle seller account.

## Reading the portals

Work through the Fetch plan one marketplace at a time: orders, then returns,
then payments.

How to read a page, best first:

1. **The data the page loads.** Portals fill their tables from their own
   JSON requests. After opening a list and setting its filters, look at the
   page's network requests for the one that returned the rows, and read its
   response: every field, exact numbers, often more rows per page than the
   table shows. Paging then means asking the page for the next page and
   reading that response. Note the request's path in the plan, so the next
   run goes straight to it.
2. **The page's text**, when the rows are in the page itself: read it page
   by page.
3. **Screenshots** to find the way (menus, filters, which tab is which) and
   for anything only drawn, never as the way to read long lists of numbers.

Write what you read to `tmp/portals/<today>/<marketplace>-<what>.json` as
you go (one array per page type, only the fields above), so nothing has to be
held in the conversation and the rows can be checked before they are written.

**Payments matter most.** Orders tell Finance what was sold; payments tell it
what the marketplace actually paid and took (commission, fixed and platform
fees, shipping, TCS/TDS, refunds, ads, claims). Read both the payments already
made and the upcoming or outstanding ones: without a payment line, a recent
order counts its cost of goods but no sale yet. Read the payout totals too
(what reached the bank, per payout): they are the check at the end.

## Writing it: the rules

Everything goes in as one SQL file, `tmp/portals/<today>/<marketplace>.sql`,
wrapped in `BEGIN; … COMMIT;`, every insert an upsert so the file can be run
again safely. `<acct>` below is the marketplace's `channel_accounts.id`.

### The account (first run only)

```sql
INSERT INTO channel_accounts (channel, label, credentials, active)
SELECT 'meesho', 'Paribelle — Meesho (Supplier Panel)', '{}'::jsonb, true
WHERE NOT EXISTS (SELECT 1 FROM channel_accounts WHERE channel = 'meesho');
```

(`'flipkart'`, `'Paribelle — Flipkart (Seller Hub)'` for Flipkart.) Run it on
its own first, read back the id, and write it in the plan. The cron sync
leaves these accounts alone: it only syncs the channels in
`ENABLED_CHANNELS` (src/config/features.ts), and the Orders, Returns and
Settings screens only show those too.

### Orders

One row per order: Flipkart's Order ID (`OD…`, with one or more order items),
Meesho's Sub Order No (each sub order is packed, paid and returned on its own,
so it is the order here).

- `status`, from the portal's words: `new` (approved, pending, packing),
  `ready_to_pack` (ready to dispatch / ready to ship), `packed`, `shipped`
  (dispatched, in transit, out for delivery), `delivered` (and Meesho's
  door-step exchange), `cancelled`, `rto` (courier return, returned to
  origin), `returned` (customer return). A Flipkart order with several items:
  `cancelled` only if every item is; `rto` or `returned` if any live item is;
  otherwise its least advanced item.
- `ordered_at` and `dispatch_by` are India time: write them as
  `'2026-09-27 14:05:00+05:30'`.
- `total_amount`: what the customer paid for the live items. `is_cod`: true
  for cash on delivery (Meesho never, it pays the supplier directly).
- `raw`: a small JSON of what was read and where (the page, the ids), never
  buyer details.

```sql
INSERT INTO orders (channel_account_id, channel, external_order_id, status, ordered_at,
  ship_city, ship_state, ship_pincode, total_amount, is_cod, dispatch_by, raw)
VALUES (<acct>, 'meesho', '123456789_1', 'delivered', '2026-09-01 11:20:00+05:30',
  'Jaipur', 'Rajasthan', '302001', 649.00, false, NULL, '{"read_from": "…"}')
ON CONFLICT (channel_account_id, external_order_id) DO UPDATE SET
  status = excluded.status, ordered_at = excluded.ordered_at,
  ship_city = COALESCE(excluded.ship_city, orders.ship_city),
  ship_state = COALESCE(excluded.ship_state, orders.ship_state),
  ship_pincode = COALESCE(excluded.ship_pincode, orders.ship_pincode),
  total_amount = COALESCE(excluded.total_amount, orders.total_amount),
  is_cod = excluded.is_cod, dispatch_by = COALESCE(excluded.dispatch_by, orders.dispatch_by),
  raw = excluded.raw, updated_at = now();
```

**SKUs** link an item to our product (its cost price is what profit is
worked out from). Before the items, link every SKU of the batch that matches
a product's SKU, or the SKU the same product has on Amazon:

```sql
INSERT INTO channel_listings (product_id, channel_account_id, external_sku, active)
SELECT DISTINCT ON (v.sku) COALESCE(p.id, al.product_id), <acct>, v.sku, true
FROM (VALUES ('KRT-101-M'), ('KRT-101-L')) AS v(sku)
LEFT JOIN products p ON lower(trim(p.sku)) = lower(trim(v.sku))
LEFT JOIN channel_listings al ON lower(trim(al.external_sku)) = lower(trim(v.sku))
  AND al.channel_account_id IN (SELECT id FROM channel_accounts WHERE channel = 'amazon')
WHERE COALESCE(p.id, al.product_id) IS NOT NULL
ON CONFLICT (channel_account_id, external_sku) DO NOTHING;
```

Tell the owner the SKUs that matched nothing: until they are linked to a
product with a cost price, Finance can't work out those orders' profit.

**Items**: replace the batch's items (Flipkart's order item id or Meesho's
sub order no goes in `external_item_id`, the FSN or Meesho product id in
`external_asin`). `unit_price` is one unit's price **without** GST, the way
Amazon's items are stored (a ₹999 kurta at 5% is 951.43):

```sql
DELETE FROM order_items WHERE order_id IN (
  SELECT id FROM orders WHERE channel_account_id = <acct> AND external_order_id IN ('123456789_1'));
INSERT INTO order_items (order_id, product_id, external_item_id, external_sku, external_asin,
  title, quantity, unit_price, cancelled)
SELECT o.id, l.product_id, v.item_id, v.sku, v.fsn, v.title, v.qty, v.price, v.cancelled
FROM (VALUES ('123456789_1', '123456789_1', 'KRT-101-M', NULL, 'Kurta set · M', 1, 618.10, false))
  AS v(order_id, item_id, sku, fsn, title, qty, price, cancelled)
JOIN orders o ON o.channel_account_id = <acct> AND o.external_order_id = v.order_id
LEFT JOIN channel_listings l ON l.channel_account_id = <acct> AND l.external_sku = v.sku;
```

### Returns

`kind`: `rto` for a courier return / returned to origin, `return` for a
customer return, `exchange` for an exchange. `external_return_id`: Flipkart's
Return ID; Meesho has none, so `'ms-' || sub order no || '-' || kind`.
As Amazon's: `refund_amount` is the sale given back, with GST (> 0, none for
an exchange); `label_cost` is the return shipping the marketplace charged,
with GST (> 0); `reason` is the portal's reason and sub-reason joined with
" / "; `status` is the portal's own word where it has one.

```sql
INSERT INTO returns (order_id, channel_account_id, channel, external_return_id, kind,
  reason, awb, status, requested_at, expected_at, refund_amount, resolution, raw)
SELECT o.id, <acct>, 'meesho', v.rid, v.kind::return_kind, v.reason, v.awb, v.status,
  v.requested_at::timestamptz, NULL, v.refund, v.resolution, v.raw::jsonb
FROM (VALUES ('ms-123456789_1-rto', '123456789_1', 'rto', 'Customer not available', 'AWB123',
  'Delivered to supplier', '2026-09-10 00:00:00+05:30', NULL::numeric, NULL, '{}'))
  AS v(rid, order_id, kind, reason, awb, status, requested_at, refund, resolution, raw)
LEFT JOIN orders o ON o.channel_account_id = <acct> AND o.external_order_id = v.order_id
ON CONFLICT (channel_account_id, external_return_id) DO UPDATE SET
  order_id = excluded.order_id, reason = excluded.reason, awb = excluded.awb,
  status = excluded.status, requested_at = excluded.requested_at,
  refund_amount = excluded.refund_amount, resolution = excluded.resolution, raw = excluded.raw;
```

### Payments: money lines

Finance adds these to Amazon's, so they must be typed and signed exactly the
way Amazon's are (src/lib/profit.ts reads them):

| type | what | signs |
|---|---|---|
| `Shipment` | a sale settled | `total` > 0; `principal` = sale value **without** GST (> 0); `tax` = the GST (> 0); `promo` = seller-funded offers (≤ 0); `fees` = commission, fixed, closing, collection, platform and warehousing fees with their GST (≤ 0); `postage` = forward shipping (≤ 0); `tcs_tds` = TCS + TDS withheld (≤ 0) |
| `Refund` | a return or RTO reversing a sale | `total` < 0; `principal` < 0; `tax` < 0; `fees` may be > 0 (commission given back); `postage` = return shipping (≤ 0); `tcs_tds` ≥ 0 |
| `ProductAdsPayment` | ads spend | `total` < 0, no order |
| `ServiceFee` | account fees with no order (storage, recall) | `total` < 0 |
| `Adjustment` | claims, compensation, recovery, protection fund | either sign; `description` says which (never starting `SERRAC`, that is Amazon's SAFE-T) |
| `Transfer` | a payout to the bank | `total` > 0 = what reached the bank; see below |

- **`total` is the portal's own figure** for that line: what it says the
  seller gets (Flipkart's bank settlement value; Meesho's amount for the sub
  order on that payment day, `netAmount` in the day's list). Meesho's "final
  settlement amount" on an order's page is the sub order's whole life, over
  several payment days (sale, RTO, claim), so it is never a line's total; the
  order's timeline (`shipmentStatusList`: type, payment date, amount) says
  which events a day's amount is made of. The parts are carved out of it;
  whatever doesn't fit stays as the remainder, which Finance shows as
  "Other". Check each line's parts add up to its total; if many don't, a sign
  has been read the wrong way round.
- **Meesho's parts:** a sale is `principal` = sale without GST, `tax` = its
  GST, `postage` = the shipping the buyer paid less Meesho's shipping charge
  (both with GST), `tcs_tds` = TCS + TDS; there is no commission. An RTO or
  return reverses the sale's parts in proportion (a partial return, half),
  plus the return shipping fee in `postage`. An RTO or return later called
  off is its own `Refund` line (`:return-cancelled`, positive). A claim is an
  `Adjustment`.
- **GST**: `principal` = sale including GST ÷ (1 + rate), `tax` = the rest.
  The portal's GST rate for the product, else 5%.
- **A row with both a sale and a return** (an RTO settled in one go) becomes
  two lines, `Shipment` and `Refund`, whose totals add up to the row.
- **`status`**: `RELEASED` once paid (a payment date on or before today),
  `DEFERRED` while upcoming. Never `DEFERRED_RELEASED`.
- **`transaction_id`**: `fk:` or `ms:`, then the order item id (Flipkart) or
  sub order no (Meesho), then `:sale`, `:return` or `:<adjustment kind>`,
  e.g. `ms:123456789_1:sale`. An upcoming line and the same line once paid
  share the id, so a later run just updates it to `RELEASED`. Only when one
  item has two lines of the same kind (paid in two parts) add the payout's
  reference: `fk:<item>:sale:<neft id>`. Non-order lines: `fk:ads:<campaign or
  date>`, `ms:ads:<date>:<campaign>`, and so on.
- **`group_id`**: the payout a paid line belongs to, `fk:payout:<NEFT id>`
  or, where there's no reference, `ms:payout:<payment date YYYY-MM-DD>`.
  Upcoming lines have none.
- `posted_at`: the payment date, else the dispatch date, else the order
  date (India time). `external_order_id`: the order's id exactly as in
  `orders`, so Finance can join the money to the order.

```sql
INSERT INTO finance_transactions (transaction_id, channel_account_id, type, status,
  description, posted_at, external_order_id, group_id, total, principal, tax, promo,
  tcs_tds, fees, postage, refund_commission)
VALUES ('ms:123456789_1:sale', <acct>, 'Shipment', 'RELEASED', 'Meesho sale',
  '2026-09-15 00:00:00+05:30', '123456789_1', 'ms:payout:2026-09-15',
  512.40, 618.10, 30.90, 0, -6.18, -95.42, -35.00, 0)
ON CONFLICT (transaction_id) DO UPDATE SET
  type = excluded.type, status = excluded.status, description = excluded.description,
  posted_at = excluded.posted_at, external_order_id = excluded.external_order_id,
  group_id = excluded.group_id, total = excluded.total, principal = excluded.principal,
  tax = excluded.tax, promo = excluded.promo, tcs_tds = excluded.tcs_tds, fees = excluded.fees,
  postage = excluded.postage, refund_commission = excluded.refund_commission;
```

**Payouts** last, worked out from everything in the database rather than from
this run alone (a run may hold only part of an earlier payout):

```sql
INSERT INTO finance_transactions (transaction_id, channel_account_id, type, status,
  description, posted_at, group_id, total)
SELECT replace(group_id, ':payout:', ':transfer:'), <acct>, 'Transfer', 'RELEASED',
  'Meesho payout ' || split_part(group_id, ':payout:', 2), max(posted_at), group_id, sum(total)
FROM finance_transactions
WHERE channel_account_id = <acct> AND type <> 'Transfer' AND status = 'RELEASED' AND group_id IS NOT NULL
GROUP BY group_id
ON CONFLICT (transaction_id) DO UPDATE SET total = excluded.total, posted_at = excluded.posted_at;
```

Then compare each payout's `total` with what the portal says reached the bank
for it. They must agree to the rupee (give or take rounding); if one
doesn't, a line is missing or misread. Find it before committing.

## Checking the reports

Open Finance (localhost or the live site). Once a second marketplace has
data, the rail has a marketplace switch at its right end: All marketplaces,
Amazon, Flipkart, Meesho. For each marketplace written to:

- **Overview**, a finished month: orders placed, returns and RTOs, the net
  ("Meesho net") and "Money with Meesho". Compare the orders with the
  portal's own count for the month, and the money with its payments page.
- **Ledger › Orders**, the same month: open two or three orders and compare
  them with the portal's order page.

Then tell the owner the headline numbers per marketplace, the SKUs that are
not linked to a product, and anything that looked off.

## After the run: update this file

This is what makes the next run quick. Before finishing:

1. **Fetch plan:** for every page read, set "Read through" to the last full
   day read and "Next run from" to 7 days before it. Write down exactly how to
   read it: the menu path and URL, the filters, and the JSON request the page
   loads its rows from (path and paging), or that the page text had to be
   used. Add what you learned to the notes: how far back a filter goes, page
   sizes, fields that were missing, how the portal words its statuses.
2. **Run log:** add a row.
3. **Clean up:** delete the `tmp/portals/<date>/` folders of earlier runs;
   keep this run's until the owner has looked at Finance. Nothing in `tmp/`
   is committed (git ignores it).
4. This file is committed like any change; the owner tests on localhost and
   pushes.

## The first run (read everything)

There is no plan yet, so the first run builds it while reading everything
from the first order to today.

1. On each portal, find where each of these lives and how its rows can be
   read, and write it into the plan as you go:
   - **Flipkart Seller Hub:** orders (every status, including cancelled and
     returned), returns (customer and courier), payments (settled, per
     payout, with each order item's breakdown; and upcoming/outstanding),
     ads spend if Paribelle runs Flipkart ads.
   - **Meesho Supplier Panel:** orders (every status tab), returns and RTO,
     payments (per payment date, with each sub order's breakdown; the ads
     deductions; compensation, claims and recovery), and upcoming payments.
2. Find the oldest order, then read from there to today.
3. Write the account first, then orders, returns and payments as above, one
   marketplace at a time, each after the owner's go.
4. Fill in every row of the plan and the log.

## After the first run: the save script

Once one real run has been written by hand, build `scripts/portal-save.ts`
(`npm run portal -- save <json files> [--dry-run]`): it takes the JSON files
exactly as this run wrote them to `tmp/portals/<date>/`, and does what the
SQL above does (account, SKU links, orders and items, returns, money lines,
payouts), printing the same summary and payout check. Test it by saving the
first run's files again with `--dry-run` and then for real: nothing should
change, since everything is an upsert. Then replace
[Writing it: the rules](#writing-it-the-rules) with how to use it (keep the
rules for money lines, the script follows them), and log it below.

## Known limits

- Flipkart and Meesho orders show only in Finance and the assistant, not on
  the Orders screen: they are shipped from their own portals.
- Orders delivered but not yet paid for have no payment line until the
  portal lists them, so read upcoming payments where the portal has them.
- Amazon is not part of this procedure; it syncs by itself.

## Fetch plan

Updated at the end of every run. Dates are India time. "Next run from" is
where the next run starts each page.

### How the first run read both portals

Every list was read from the JSON request the page itself uses, called from
the portal's own tab (the browser tool's JavaScript, `credentials:
'include'`), with the page's own request headers: wrap `window.fetch` (and
`XMLHttpRequest` on Meesho) to record the headers and bodies of the page's
requests, click a tab so the page makes one, then send the same request with
the variables changed. A full page reload loses the wrapper; clicking within
the page keeps it.

Long jobs run in the background inside the page (an async function that
stores its progress on `window`), checked every 40 seconds: one tool call
may take 45 seconds at most. A tab can be reloaded when the Browser pane
reopens, which loses everything in it, so save to `tmp/portals/<date>/` as
soon as a job ends. To save: have the call return the JSON as text; a result
over the tool's size limit is written to a `tool-results` file, which Python
reads (`json.JSONDecoder().raw_decode`) into `tmp/`. Send it in parts of
250,000 characters.

### Flipkart Seller Hub

Account id: `SELECT id FROM channel_accounts WHERE channel = 'flipkart'`
(created by the first run). The seller id is the one in the page's own requests.

Flipkart requests need the headers the page's own GraphQL calls send, plus
`operation` and `operation-name` set to the operation (else
`EBADCSRFTOKEN`). The bodies are the page's own, captured the same way.

| What | Where and how to read it | Read through | Next run from |
|---|---|---|---|
| Orders (every status) | Orders page, each status tab: `POST /orchestrator/graphql?` operation `GetShipmentListByOrderId`, `variables.input.status` = the tab, `paginationInput {pageNum, pageSize: 100}` | 2026-09-27 | 2026-09-20 |
| Returns (customer and courier) | Returns (`#dashboard/return_orders`): `GET /napi/returns/fetchReturnsV2?nextPage=<n>&page_size=50&return_status=<completed, approved, in_transit>&return_substatus=<delivered, undelivered or default>&sellerType=FLIPKART&sellerId=<seller id>`, for completed also `&shipment_expectations[]=EXPECT` and `=DONT_EXPECT`; header `fk-csrf-token` from the page; page on `result.hasMore` | 2026-09-27 | 2026-09-20 |
| Payments: every order item with a payment | Payments › Order-wise settlements: `POST /napi/graphql` `TransactionPage_getTransactionsTableData {startDate, endDate, size: 50, token}`, page on `is_next` / `token` | 2026-09-27 | 2026-09-20 |
| Payments: each item's settlements (paid and upcoming) | per order item id: `POST /orchestrator/graphql?` `GetSSMOrderItemHistory {input.param: <order item id>}`: `settledSettlements` and `upcomingSettlement`, each with NEFT id, date, price, refund, fees, GST, TCS, TDS (and its rate), protection fund | 2026-09-27 | 2026-09-20 |
| Payouts | Payments › Previous payments: `PaymentsPreviousPaymentsOrchestratorFetchPreviousPayment {fromDate, toDate, pageSize: '200', token: '0'}` | 2026-09-27 | 2026-09-20 |
| Ads and fines | `TransactionPage_getTransactionsTableData {tabName: 'serviceItem', subTabName: <each sub tab from TransactionPage_getTransactionsSubTabs>, startDate, endDate}`, **31 days at most per call**, so month by month | 2026-09-27 | 2026-09-20 |
| Protection fund | `TransactionPage_getTransactionsTableData {tabName: 'spf', subTabName: 'order_spf', …}`, month by month | 2026-09-27 | 2026-09-20 |
| Upcoming, as a check | Payments › Account summary: "Total Outstanding" | 2026-09-27 | every run |

Notes:
- **Payments before April 2026 are not in these lists**, only in the
  financial-year report, which is a download (not allowed). 40 orders
  (42 items) from 21 Feb to 19 Mar 2026 have no payment lines and were left
  out (`--with-unpaid-history` in the first run's generator writes them
  anyway, as unsettled). If the owner downloads that report, read it.
- Flipkart withholds TDS at **5%** here (the rate for a PAN that isn't linked
  or active), not 0.1%.
- A courier return (RTO) settles to ₹0 with no fees; a customer return costs
  ₹150–250 (reverse shipping and the fixed fee, with GST).
- A price correction comes as a negative price on a reversal, not as a
  refund: the sale value is price + refund.
- Only 2 of the 32 SKUs match a product; the rest need linking by the owner.

### Meesho Supplier Panel

Account id: `SELECT id FROM channel_accounts WHERE channel = 'meesho'`
(created by the first run). The supplier id and identifier are the ones in the
page's own requests.

Meesho requests are `POST`s with the headers the page's own `/api/`
requests send (`client-type`, `client-package-version`, `identifier`,
`browser-id`, JSON content type).

| What | Where and how to read it | Read through | Next run from |
|---|---|---|---|
| Payouts (what reached the bank) | Payments › Previous payments: `/api/payouts/payments/previous-payments {identifier, supplier_id, limit: 60}` (60 at most, newest first; no paging found) | 2026-09-18 | 2026-09-11 |
| Payment days before those 60 | `/api/payouts/payments/all-ui-data {supplier_id, supplier_identifier, get_count: true, get_aggregated_data: true, date, payment_request: {offset: 0, limit: 1, status: 'paid'}}` for **every** date: a day with a count or an `aggregated_data` total was a payment day | 2026-04-23 (all days since 2025-10-01; the first payment day is 2026-02-17) | not needed again |
| Payments per day, per sub order | `all-ui-data` as above with `limit: 20` (**20 at most**), `offset` += 20: `payoutUIList` (sub order, status, `netAmount`, claim, return shipping charge, penalty, recovery) and `aggregated_data.totalNetOrderAmt` (the day's order total) | 2026-09-18 | 2026-09-11 |
| Each sub order's breakdown and timeline | `/api/payouts/payments/order-info {supplier_id, identifier, date, status: 'SUCCESS' or 'PENDING', sub_order_num}`: `payout.revenueDetails`, `marketplaceFeeDeductions`, `paymentDetails` (TCS, TDS), `shipmentStatusList` (each event's type, date, payment date, amount), `orderDetails` (SKU, qty, name) | 2026-09-18 | with each day read |
| Ads deductions | `/api/payouts/payments/supplier-platform-recovery {supplier_id, supplier_identifier, date, ads_cost: {offset, limit: 20, status}, program_cost, loan_settlement_cost}`; page while `ads_cost_count` is more than read; `ads_cost_total_amount` is the day's deduction | 2026-09-18 | 2026-09-11 |
| Compensation, referral | `/api/payouts/payments/supplier-platform-compensation {…, program_benefits, referral_earnings}` (none so far) | 2026-09-18 | 2026-09-11 |
| Upcoming payments | `/api/payouts/payments/upcoming-payments {identifier, supplier_id, limit: 30}`, then each upcoming date through `all-ui-data` with `status: 'upcoming'` and `order-info` with `status: 'PENDING'` | 2026-10-05 | every run: all |
| Cancelled orders | Orders › Cancelled: `/api/fulfillment/orders {enable_hold: true, supplier_details: {id, identifier, name}, cursor, limit: 50, status: 5, type: 'cancelled', identifier}`, page on `cursor` | 2026-09-27 | every run: all |
| Returns and RTO (reason, AWB, status) | Returns › Return Tracking: `/api/fulfillment/returnRto/fetchReturnClaims {screenType: 'returns', size: 50, cursor, filter_cursor, filters: {shipment_status: <completed_delivered, completed_lost, reverse_disposed, intransit>, created_date: {value: 'custom_date_range', start_date, end_date}}, supplier_details, identifier}`; page by passing back **both** `cursor` and `filter_cursor` | see notes | 2026-09-20 |

Notes:
- **Rate limits.** `order-info` and `all-ui-data` take about 2 calls a
  second (wait 300 ms between calls, retry after a few seconds). The
  returns list is much stricter: one page, then "You've made too many
  requests" for a while; read it a page every 20 seconds and wait a minute
  after a refusal. **A refused call answers `{error: …}` with no exception:
  check for it, or a scan silently skips days** (the first run's first scan
  missed 13 payment days that way).
- The Orders page lists only orders still in progress (pending, ready,
  shipped); everything since shipping is read from payments.
- A day's list line can be wrong where the day's total is right: once a
  partial return (2 sold, 1 returned) was listed as only its return fee.
  Check each day's lines against `totalNetOrderAmt`; where the timeline's
  amounts make the day add up, use them.
- An order's timeline once showed half its sale (₹481.34 for ₹962.67 paid):
  size a kept order from its breakdown.
- The upcoming list lags a day or two behind a fresh return; the order's
  timeline (`Pending` events) has the new amount and date.
- The returns list only goes back 180 days ("Orders in last 180 days").
- None of the 18 Meesho SKUs match a product yet; the owner links them.

## Run log

| Date | Run by | Marketplace | What was read, and the range | Written (orders / returns / money lines / payouts) | Notes |
|---|---|---|---|---|---|
| 2026-09-27 | Claude Code (first run) | Flipkart | Everything: orders, returns, order-wise settlements and payouts, ads, fines, protection fund; payments 2026-04-01 to 2026-09-27 plus upcoming | 178 / 63 / 293 / 32 | 40 Feb–Mar orders without payments left out (FY report only); 30 of 32 SKUs unlinked; TDS at 5%. Written with the hand-made `flipkart.sql` (generator kept in `tmp/portals/2026-09-27/`) |
| 2026-09-27 | Claude Code (first run) | Meesho | Everything: 95 payment days 2026-02-17 to 2026-09-18 and 3 upcoming to 2026-10-05, each sub order's breakdown and timeline, ads, cancelled orders | 986 / 407 / 1,439 / 95 | Return reasons not read yet (Returns list rate limit): read them next run; 18 SKUs unlinked. Written with `meesho.sql` (generator kept in `tmp/portals/2026-09-27/`) |

## Prompt to paste

> Read docs/portals/procedure.md and run it. I'll log in to Flipkart Seller
> Hub and the Meesho Supplier Panel in your browser when you ask.
