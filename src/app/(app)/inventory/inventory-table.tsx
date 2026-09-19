"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Empty, Spinner } from "@/components/ui";
import { cn, compareByTail } from "@/lib/utils";

import { adoptUnmappedSku, setBuffer, setStock, syncStockToChannels } from "./actions";

export interface StockRow {
  productId: number;
  sku: string;
  name: string;
  binLocation: string | null;
  onHand: number;
  reserved: number;
  buffer: number;
  sellable: number;
  listingCount: number;
}

export function InventoryTable({ rows }: { rows: StockRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const visible = filter
    ? rows.filter(
        (r) =>
          r.sku.toLowerCase().includes(filter.toLowerCase()) ||
          r.name.toLowerCase().includes(filter.toLowerCase()),
      ).sort((a, b) => compareByTail(a.sku, b.sku))
    : rows;

  function pushAll() {
    startTransition(async () => {
      const res = await syncStockToChannels();
      setMessage(
        res.ok
          ? `Pushed ${res.pushed} listings to the live channels.`
          : `Pushed ${res.pushed}, ${res.failed} failed. ${res.errors.join("; ")}`,
      );
      router.refresh();
    });
  }

  function saveStock(productId: number, value: string) {
    const count = Number(value);
    if (!Number.isFinite(count) || count < 0) return;
    startTransition(async () => {
      await setStock(productId, count);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">Inventory</h1>
        <input
          className="input w-auto flex-1 min-w-[12rem]"
          placeholder="Filter by SKU or name…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="btn btn-primary" onClick={pushAll} disabled={pending}>
          {pending ? <Spinner size="1rem" color="currentColor" /> : "Push stock to channels"}
        </button>
      </div>

      <p className="muted text-xs">
        Sellable = on hand − committed to unshipped orders − buffer. That is the number published
        to Amazon and Flipkart. Meesho has no API, so its stock stays manual.
      </p>

      {message ? (
        <p className="rounded-md bg-blue-500/10 px-3 py-2 text-sm text-blue-600">{message}</p>
      ) : null}

      <div className="panel overflow-x-auto">
        {visible.length === 0 ? (
          <Empty
            title="No products yet"
            hint="Map a SKU from an incoming order, or add products in Settings."
          />
        ) : (
          <table className="grid-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Product</th>
                <th>Bin</th>
                <th className="text-right">On hand</th>
                <th className="text-right">Committed</th>
                <th className="text-right">Buffer</th>
                <th className="text-right">Sellable</th>
                <th className="text-right">Listings</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.productId}>
                  <td className="font-mono text-xs">{row.sku}</td>
                  <td className="max-w-xs truncate text-xs">{row.name}</td>
                  <td className="text-xs">{row.binLocation ?? "—"}</td>

                  <td className="text-right">
                    <input
                      type="number"
                      min={0}
                      defaultValue={row.onHand}
                      className="input w-20 text-right tabular-nums"
                      onBlur={(e) => {
                        if (Number(e.target.value) !== row.onHand) {
                          saveStock(row.productId, e.target.value);
                        }
                      }}
                    />
                  </td>

                  <td className="text-right tabular-nums">{row.reserved}</td>

                  <td className="text-right">
                    <input
                      type="number"
                      min={0}
                      defaultValue={row.buffer}
                      className="input w-16 text-right tabular-nums"
                      onBlur={(e) => {
                        const value = Number(e.target.value);
                        if (value !== row.buffer) {
                          startTransition(async () => {
                            await setBuffer(row.productId, value);
                            router.refresh();
                          });
                        }
                      }}
                    />
                  </td>

                  <td
                    className={cn(
                      "text-right font-semibold tabular-nums",
                      row.sellable === 0 && "text-rose-500",
                      row.sellable > 0 && row.sellable <= 3 && "text-amber-500",
                    )}
                  >
                    {row.sellable}
                  </td>

                  <td className="text-right tabular-nums">
                    {row.listingCount === 0 ? (
                      <span className="text-rose-500" title="Not listed on any channel">
                        0
                      </span>
                    ) : (
                      row.listingCount
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export interface UnmappedRow {
  externalSku: string;
  title: string | null;
  channel: string;
  channelAccountId: number;
  orderCount: number;
}

/**
 * Unmapped SKUs are the single biggest source of silent breakage — they cannot
 * be stock-controlled or picked by bin, so they sit at the top of the inventory
 * screen until someone deals with them.
 */
export function UnmappedSkus({ rows }: { rows: UnmappedRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="panel border-amber-500/40 p-4">
      <h2 className="text-sm font-semibold text-amber-600">
        {rows.length} unmapped SKU{rows.length === 1 ? "" : "s"} on live orders
      </h2>
      <p className="muted mt-1 text-xs">
        These are selling but have no product behind them, so they are not counted in stock.
      </p>

      <ul className="mt-3 space-y-2">
        {rows.map((row) => (
          <li key={row.externalSku} className="rounded-md p-2" style={{ background: "var(--bg)" }}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{row.externalSku}</span>
              <span className="muted flex-1 truncate text-xs">{row.title ?? "—"}</span>
              <span className="muted text-xs tabular-nums">{row.orderCount} orders</span>
              <button
                className="btn text-xs"
                onClick={() => setOpen(open === row.externalSku ? null : row.externalSku)}
              >
                {open === row.externalSku ? "Cancel" : "Map"}
              </button>
            </div>

            {open === row.externalSku ? (
              <form
                className="mt-2 grid gap-2 sm:grid-cols-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  startTransition(async () => {
                    await adoptUnmappedSku({
                      externalSku: row.externalSku,
                      channelAccountId: row.channelAccountId,
                      name: String(fd.get("name") ?? ""),
                      ourSku: String(fd.get("ourSku") ?? ""),
                      binLocation: String(fd.get("bin") ?? ""),
                      openingStock: Number(fd.get("stock") ?? 0),
                    });
                    setOpen(null);
                    router.refresh();
                  });
                }}
              >
                <input
                  name="name"
                  className="input"
                  placeholder="Product name"
                  defaultValue={row.title ?? ""}
                  required
                />
                <input
                  name="ourSku"
                  className="input"
                  placeholder="Our SKU (blank = same)"
                  defaultValue={row.externalSku}
                />
                <input name="bin" className="input" placeholder="Bin (e.g. A-12)" />
                <div className="flex gap-2">
                  <input
                    name="stock"
                    type="number"
                    min={0}
                    className="input"
                    placeholder="Stock"
                    defaultValue={0}
                  />
                  <button className="btn btn-primary" disabled={pending}>
                    Save
                  </button>
                </div>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
