"use client";

import { useMemo, useState } from "react";

import { Empty } from "@/components/ui";
import { colorSwatch } from "@/lib/variant-title";

import {
  getRestockPlan,
  markRestockInStock,
  resetRestockPlan,
  updateRestockItems,
  type PlanCell,
  type PlanProduct,
  type RestockPlan,
} from "./planner-actions";
import { exportSvg, svgEscape, truncate } from "./sheet-export";

/* -------------------------------------------------------------------------- */
/* recompute buy / totals locally so edits feel instant                      */
/* -------------------------------------------------------------------------- */

function buyOf(c: PlanCell): number {
  if (c.excluded) return 0;
  if (c.buyOverride != null) return Math.max(0, c.buyOverride);
  return Math.max(0, c.needed - c.have);
}

function recalc(products: PlanProduct[]): RestockPlan {
  const next = products.map((p) => {
    const cells = p.cells.map((c) => ({ ...c, buy: buyOf(c) }));
    return {
      ...p,
      cells,
      needed: cells.reduce((s, c) => s + c.needed, 0),
      have: cells.reduce((s, c) => s + (c.excluded ? 0 : Math.min(c.have, c.needed)), 0),
      buy: cells.reduce((s, c) => s + c.buy, 0),
      settled: cells.filter((c) => c.excluded || c.buy === 0).length,
    };
  });
  return {
    products: next,
    generatedAt: null,
    totals: {
      products: next.length,
      needed: next.reduce((s, p) => s + p.needed, 0),
      have: next.reduce((s, p) => s + p.have, 0),
      buy: next.reduce((s, p) => s + p.buy, 0),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* main                                                                       */
/* -------------------------------------------------------------------------- */

export function RestockPlanner({ initialPlan }: { initialPlan: RestockPlan }) {
  const [plan, setPlan] = useState<RestockPlan>(initialPlan);
  const [activeKey, setActiveKey] = useState<string>(initialPlan.products[0]?.baseKey ?? "");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<null | "reset" | "jpeg" | "pdf">(null);
  const [error, setError] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(initialPlan.generatedAt);

  const active =
    plan.products.find((p) => p.baseKey === activeKey) ?? plan.products[0] ?? null;

  /** Optimistically transform the matching cells, then persist. */
  function apply(ids: number[], fn: (c: PlanCell) => PlanCell, persist: () => Promise<unknown>) {
    const idset = new Set(ids);
    setPlan((prev) =>
      recalc(prev.products.map((p) => ({ ...p, cells: p.cells.map((c) => (idset.has(c.id) ? fn(c) : c)) }))),
    );
    persist().catch((e) => setError(e instanceof Error ? e.message : "Could not save — try again."));
  }

  function setHave(ids: number[], have: number) {
    apply(ids, (c) => ({ ...c, have, buyOverride: null }), () =>
      updateRestockItems(ids, { have, buyOverride: null }),
    );
  }
  function markInStock(ids: number[]) {
    apply(ids, (c) => ({ ...c, have: c.needed, buyOverride: null, excluded: false }), () =>
      markRestockInStock(ids),
    );
  }
  function setExcluded(ids: number[], excluded: boolean) {
    apply(ids, (c) => ({ ...c, excluded }), () => updateRestockItems(ids, { excluded }));
  }

  async function reset() {
    if (!confirm("Rebuild the planner from the latest synced orders? Every 'have' you have typed will be cleared.")) {
      return;
    }
    setBusy("reset");
    setError(null);
    try {
      const fresh = await resetRestockPlan();
      setPlan(recalc(fresh.products));
      setGeneratedAt(fresh.generatedAt);
      setActiveKey(fresh.products[0]?.baseKey ?? "");
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reset failed.");
    } finally {
      setBusy(null);
    }
  }

  async function refresh() {
    try {
      const fresh = await getRestockPlan();
      setPlan(recalc(fresh.products));
      setGeneratedAt(fresh.generatedAt);
    } catch {
      /* non-fatal */
    }
  }

  async function exportSheet(kind: "jpeg" | "pdf") {
    setBusy(kind);
    setError(null);
    try {
      const svg = buildBuySheetSvg(plan.products);
      await exportSvg(svg, kind, `buy-list-${new Date().toISOString().slice(0, 10)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setBusy(null);
    }
  }

  if (plan.products.length === 0) {
    return (
      <Empty
        title="Nothing to plan"
        hint="The planner fills up from open orders. Sync, or switch to the List view."
      />
    );
  }

  const t = plan.totals;

  return (
    <div className="space-y-4">
      {/* ---------------------------------------------------------- top strip */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex items-end gap-2">
          <Kpi label="products" value={t.products} />
          <Kpi label="need" value={t.needed} />
          <Kpi label="have" value={t.have} />
          <Kpi label="to buy" value={t.buy} tone="buy" />
        </div>

        <div className="ml-auto flex items-center gap-2">
          {generatedAt ? (
            <span className="muted text-[11px]">built {relTime(generatedAt)}</span>
          ) : null}
          <button className="btn text-xs" disabled={busy !== null} onClick={reset}>
            {busy === "reset" ? "Rebuilding…" : "Reset from latest sync"}
          </button>
          <button
            className="btn btn-primary text-xs"
            disabled={busy !== null || t.buy === 0}
            onClick={() => exportSheet("jpeg")}
          >
            {busy === "jpeg" ? "…" : "Buy sheet JPEG"}
          </button>
          <button
            className="btn btn-primary text-xs"
            disabled={busy !== null || t.buy === 0}
            onClick={() => exportSheet("pdf")}
          >
            {busy === "pdf" ? "…" : "PDF"}
          </button>
        </div>
      </div>

      {error ? (
        <p className="rounded-lg px-3 py-2 text-sm" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}

      {/* ---------------------------------------------------------- master / detail */}
      <div className="grid items-start gap-4 lg:grid-cols-[288px_minmax(0,1fr)]">
        {/* rail */}
        <div className="panel overflow-hidden">
          <div
            className="flex items-center justify-between border-b px-3.5 py-2.5"
            style={{ borderColor: "var(--border)" }}
          >
            <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
              Products
            </span>
            <span className="muted text-[11px]">most to buy</span>
          </div>
          <div className="max-h-[calc(100vh-14rem)] overflow-y-auto">
            {plan.products.map((p) => {
              const on = p.baseKey === active?.baseKey;
              const done = p.buy === 0;
              const pct = p.variantCount ? Math.round((p.settled / p.variantCount) * 100) : 100;
              return (
                <button
                  key={p.baseKey}
                  onClick={() => {
                    setActiveKey(p.baseKey);
                    setSelected(new Set());
                  }}
                  className="flex w-full items-center gap-3 border-b px-3.5 py-2.5 text-left transition-colors"
                  style={{
                    borderColor: "var(--border)",
                    background: on ? "var(--accent-soft)" : undefined,
                    boxShadow: on ? "inset 3px 0 0 var(--accent)" : undefined,
                  }}
                >
                  <Thumb src={p.imageUrl} size={44} />
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 text-[12.5px] font-semibold leading-tight">
                      {p.label}
                    </span>
                    <span className="mt-1 flex items-center gap-2">
                      <span
                        className="rounded-full px-1.5 py-px text-[10px] font-extrabold tracking-wide"
                        style={
                          done
                            ? { background: "var(--ok-soft)", color: "var(--ok)" }
                            : { background: "var(--accent-soft)", color: "#0b7fb0" }
                        }
                      >
                        {done ? "DONE" : `BUY ${p.buy}`}
                      </span>
                      <span
                        className="h-1 flex-1 overflow-hidden rounded-full"
                        style={{ background: "var(--panel-2)" }}
                      >
                        <span
                          className="block h-full rounded-full"
                          style={{ width: `${pct}%`, background: done ? "var(--ok)" : "var(--accent)" }}
                        />
                      </span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* detail */}
        {active ? (
          <ProductPanel
            key={active.baseKey}
            product={active}
            selected={selected}
            setSelected={setSelected}
            onHave={setHave}
            onMarkInStock={markInStock}
            onExclude={setExcluded}
          />
        ) : null}
      </div>

      <p className="muted max-w-[820px] text-[11.5px]">
        <b>need</b> = units in today’s open orders for that size + colour · <b>have</b> = what you
        count on the shelf · <b>buy</b> = need − have. Click a cell, a colour, or a size header to
        select in bulk. <b>Reset from latest sync</b> rebuilds the grid and drops every edit. The buy
        sheet exports only the <b>buy</b> quantities for the wholesaler.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* the grid for one product                                                  */
/* -------------------------------------------------------------------------- */

function ProductPanel({
  product,
  selected,
  setSelected,
  onHave,
  onMarkInStock,
  onExclude,
}: {
  product: PlanProduct;
  selected: Set<number>;
  setSelected: (s: Set<number>) => void;
  onHave: (ids: number[], have: number) => void;
  onMarkInStock: (ids: number[]) => void;
  onExclude: (ids: number[], excluded: boolean) => void;
}) {
  const byCell = useMemo(() => {
    const m = new Map<string, PlanCell>();
    for (const c of product.cells) m.set(`${c.color} ${c.size}`, c);
    return m;
  }, [product]);

  const productExcluded = product.cells.length > 0 && product.cells.every((c) => c.excluded);

  function toggle(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }
  function pickMany(ids: number[]) {
    const allOn = ids.length > 0 && ids.every((i) => selected.has(i));
    const next = new Set(selected);
    for (const i of ids) allOn ? next.delete(i) : next.add(i);
    setSelected(next);
  }

  const colIds = (size: string) =>
    product.colors.map((c) => byCell.get(`${c} ${size}`)?.id).filter((n): n is number => n != null);
  const rowIds = (color: string) =>
    product.sizes.map((s) => byCell.get(`${color} ${s}`)?.id).filter((n): n is number => n != null);

  const selIds = [...selected].filter((id) => product.cells.some((c) => c.id === id));

  return (
    <div className="panel max-w-[900px] overflow-hidden">
      {/* header */}
      <div className="flex gap-4 border-b p-5" style={{ borderColor: "var(--border)" }}>
        <Thumb src={product.imageUrl} size={128} />
        <div className="min-w-0 flex-1">
          <div className="text-[17px] font-extrabold leading-tight tracking-tight">{product.label}</div>
          <div className="mt-1.5 text-[11.5px]" style={{ color: "var(--muted-2)" }}>
            {product.skuCount} seller SKU{product.skuCount === 1 ? "" : "s"}
            {product.asin ? (
              <>
                {" · "}
                <span className="font-mono">{product.asin}</span>
              </>
            ) : null}
          </div>
          <div className="mt-3 flex items-end gap-2">
            <Kpi label="need" value={product.needed} />
            <Kpi label="have" value={product.have} />
            <Kpi label="to buy" value={product.buy} tone="buy" />
          </div>
        </div>
        <button
          onClick={() => onExclude(product.cells.map((c) => c.id), !productExcluded)}
          className="h-fit rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium transition-colors"
          style={{
            color: productExcluded ? "var(--accent)" : "var(--muted)",
            background: productExcluded ? "var(--accent-soft)" : "transparent",
          }}
        >
          {productExcluded ? "Re-include product" : "Exclude product"}
        </button>
      </div>

      {/* bulk bar */}
      {selIds.length > 0 ? (
        <div
          className="mx-5 mt-4 flex flex-wrap items-center gap-2 rounded-xl px-3 py-2 text-[12px] text-white"
          style={{ background: "#0f2536" }}
        >
          <b className="tabular-nums">{selIds.length}</b> selected
          <button className="rounded-md bg-white/15 px-2 py-1 text-[11.5px] font-medium" onClick={() => onMarkInStock(selIds)}>
            Mark in stock
          </button>
          <span className="flex items-center gap-1 rounded-md bg-white/15 px-2 py-1 text-[11.5px]">
            Set have
            <input
              type="number"
              min={0}
              defaultValue={0}
              className="w-11 rounded bg-white px-1 py-0.5 text-center text-[11px] text-[color:var(--text)]"
              onKeyDown={(e) => {
                if (e.key === "Enter") onHave(selIds, Math.max(0, Number((e.target as HTMLInputElement).value) || 0));
              }}
            />
          </span>
          <button className="rounded-md bg-white/15 px-2 py-1 text-[11.5px] font-medium" onClick={() => onExclude(selIds, true)}>
            Exclude
          </button>
          <button className="ml-auto text-[11.5px] opacity-70" onClick={() => setSelected(new Set())}>
            Clear ✕
          </button>
        </div>
      ) : null}

      {/* matrix */}
      <div className="overflow-x-auto p-5">
        <table className="border-collapse" style={{ tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: 150 }} />
            {product.sizes.map((s) => (
              <col key={s} style={{ width: 112 }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th
                className="border text-left"
                style={{ borderColor: "var(--border)", background: "var(--panel)" }}
              />
              {product.sizes.map((s) => {
                const ids = colIds(s);
                const on = ids.length > 0 && ids.every((i) => selected.has(i));
                return (
                  <th
                    key={s}
                    className="relative h-9 border text-center text-[11.5px] font-extrabold"
                    style={{ borderColor: "var(--border)", background: "var(--panel-2)" }}
                  >
                    {s || "—"}
                    <button
                      onClick={() => pickMany(ids)}
                      aria-label={`Select size ${s}`}
                      className="absolute right-1.5 top-1.5"
                    >
                      <Box on={on} />
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {product.colors.map((color) => {
              const sw = colorSwatch(color);
              const ids = rowIds(color);
              const rowOn = ids.length > 0 && ids.every((i) => selected.has(i));
              const rowExcluded = ids.length > 0 && product.cells.filter((c) => c.color === color).every((c) => c.excluded);
              return (
                <tr key={color} style={rowExcluded ? { opacity: 0.45 } : undefined}>
                  <td
                    className="border px-2.5 text-[12.5px] font-bold"
                    style={{ borderColor: "var(--border)", background: "var(--panel-2)" }}
                  >
                    <span className="flex items-center gap-2">
                      <button onClick={() => pickMany(ids)} aria-label={`Select colour ${color}`}>
                        <Box on={rowOn} />
                      </button>
                      <Swatch sw={sw} />
                      <span className={rowExcluded ? "line-through" : ""}>{color || "—"}</span>
                    </span>
                  </td>
                  {product.sizes.map((size) => {
                    const cell = byCell.get(`${color} ${size}`) ?? null;
                    if (!cell) {
                      return (
                        <td
                          key={size}
                          className="border text-center text-[15px]"
                          style={{ borderColor: "var(--border)", color: "var(--muted-2)" }}
                        >
                          –
                        </td>
                      );
                    }
                    const isSel = selected.has(cell.id);
                    const covered = !cell.excluded && cell.buy === 0;
                    return (
                      <td key={size} className="border p-0" style={{ borderColor: "var(--border)" }}>
                        <div
                          onClick={() => toggle(cell.id)}
                          className="relative flex h-[74px] cursor-pointer flex-col items-center justify-center gap-1"
                          style={{
                            background: cell.excluded
                              ? "var(--panel-2)"
                              : covered
                                ? "var(--ok-soft)"
                                : "var(--panel)",
                            outline: isSel ? "2px solid var(--accent)" : "none",
                            outlineOffset: "-3px",
                          }}
                        >
                          <span
                            className="text-[18px] font-extrabold tabular-nums leading-none"
                            style={{ color: covered || cell.excluded ? "var(--muted-2)" : "var(--text)" }}
                          >
                            {cell.needed}
                          </span>

                          {cell.excluded ? (
                            <span className="text-[9.5px] font-bold tracking-wide" style={{ color: "var(--muted)" }}>
                              EXCLUDED
                            </span>
                          ) : covered ? (
                            <svg
                              viewBox="0 0 24 24"
                              className="h-3.5 w-3.5"
                              fill="none"
                              stroke="var(--ok)"
                              strokeWidth="3"
                              strokeLinecap="round"
                            >
                              <path d="M20 6 9 17l-5-5" />
                            </svg>
                          ) : (
                            <>
                              <span
                                className="flex items-center gap-1 text-[11px] tabular-nums"
                                style={{ color: "var(--muted)" }}
                                onClick={(e) => e.stopPropagation()}
                              >
                                have
                                <input
                                  type="number"
                                  min={0}
                                  defaultValue={cell.have}
                                  className="w-9 rounded border px-1 text-center text-[11px]"
                                  style={{ borderColor: "var(--border-strong)", background: "var(--panel)" }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                  }}
                                  onBlur={(e) => {
                                    const v = Math.max(0, Number(e.target.value) || 0);
                                    if (v !== cell.have) onHave([cell.id], v);
                                  }}
                                />
                              </span>
                              <span className="text-[9.5px] font-extrabold tracking-wide" style={{ color: "#0b7fb0" }}>
                                BUY {cell.buy}
                              </span>
                            </>
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* small pieces                                                              */
/* -------------------------------------------------------------------------- */

function Kpi({ label, value, tone }: { label: string; value: number; tone?: "buy" }) {
  return (
    <span className="flex flex-col items-center gap-1">
      <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
        {label}
      </span>
      <span
        className="flex h-[34px] min-w-[46px] items-center justify-center rounded-lg border px-2.5 text-[15px] font-extrabold tabular-nums"
        style={{
          borderColor:
            tone === "buy" ? "color-mix(in srgb, var(--accent) 35%, var(--border))" : "var(--border)",
          background: "var(--panel)",
          color: tone === "buy" ? "var(--accent)" : "var(--text)",
          boxShadow: "var(--shadow-xs)",
        }}
      >
        {value}
      </span>
    </span>
  );
}

function Box({ on }: { on: boolean }) {
  return (
    <span
      className="relative inline-block h-3.5 w-3.5 rounded border-[1.5px]"
      style={{
        borderColor: on ? "var(--accent)" : "var(--border-strong)",
        background: on ? "var(--accent)" : "var(--panel)",
      }}
    >
      {on ? (
        <svg viewBox="0 0 24 24" className="absolute inset-0 h-full w-full p-[2px]" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : null}
    </span>
  );
}

function Swatch({ sw }: { sw: ReturnType<typeof colorSwatch> }) {
  if (!sw) {
    return (
      <span
        className="h-3.5 w-3.5 shrink-0 rounded"
        style={{ background: "var(--panel-2)", boxShadow: "inset 0 0 0 1px var(--border)" }}
        aria-hidden
      />
    );
  }
  return (
    <span
      className="h-3.5 w-3.5 shrink-0 rounded"
      style={{
        background: sw.multi
          ? "conic-gradient(from 0deg, #ef4444, #f59e0b, #22c55e, #3b82f6, #a855f7, #ef4444)"
          : sw.css,
        boxShadow: "inset 0 0 0 1px rgba(0,0,0,.15)",
      }}
      aria-hidden
    />
  );
}

function Thumb({ src, size }: { src: string | null; size: number }) {
  const s = { width: size, height: size } as const;
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={src}
        alt=""
        className="shrink-0 rounded-lg border object-cover"
        style={{ ...s, borderColor: "var(--border)", background: "var(--panel-2)" }}
      />
    );
  }
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-lg border"
      style={{ ...s, borderColor: "var(--border)", background: "var(--panel-2)" }}
      aria-hidden
    >
      <svg viewBox="0 0 24 24" style={{ width: size * 0.4, height: size * 0.4 }} fill="none" stroke="var(--muted-2)" strokeWidth="1.4">
        <path d="M4 8l4-4h8l4 4M4 8v11a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V8M4 8h16M9 12h6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function relTime(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/* -------------------------------------------------------------------------- */
/* buy sheet SVG — only the buy quantities, grouped by product              */
/* -------------------------------------------------------------------------- */

function buildBuySheetSvg(products: PlanProduct[]): string {
  const groups = products
    .map((p) => ({
      label: p.label,
      rows: p.cells
        .filter((c) => c.buy > 0)
        .sort((a, b) => a.color.localeCompare(b.color) || a.size.localeCompare(b.size)),
    }))
    .filter((g) => g.rows.length > 0);

  const W = 940;
  const padX = 40;
  const headH = 92;
  const rowH = 30;
  const grpHeadH = 40;
  /** The COLOUR/SIZE/NEED/HAVE/BUY column-label row drawn under each group's title bar. */
  const colHeadH = 26;
  const grpGap = 14;
  const footH = 96;

  let bodyH = 0;
  for (const g of groups)
    bodyH += grpHeadH + colHeadH + g.rows.length * rowH + rowH /* subtotal */ + grpGap;
  const H = headH + bodyH + footH;

  const now = new Date();
  const dateLabel = now.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  const grand = groups.reduce((s, g) => s + g.rows.reduce((x, r) => x + r.buy, 0), 0);

  const col = { color: padX, size: 250, need: W - 260, have: W - 170, buy: W - 70 };

  let y = headH;
  const parts: string[] = [];
  for (const g of groups) {
    parts.push(
      `<rect x="0" y="${y}" width="${W}" height="${grpHeadH}" fill="#eef6fa"/>`,
      `<text x="${padX}" y="${y + 25}" font-size="14" font-weight="800" fill="#0f2536">${svgEscape(truncate(g.label, 78))}</text>`,
    );
    y += grpHeadH;
    parts.push(
      `<text x="${col.color}" y="${y + 20}" font-size="9.5" font-weight="700" letter-spacing="1" fill="#8ba0b0">COLOUR</text>`,
      `<text x="${col.size}" y="${y + 20}" font-size="9.5" font-weight="700" letter-spacing="1" fill="#8ba0b0">SIZE</text>`,
      `<text x="${col.need}" y="${y + 20}" font-size="9.5" font-weight="700" letter-spacing="1" fill="#8ba0b0" text-anchor="end">NEED</text>`,
      `<text x="${col.have}" y="${y + 20}" font-size="9.5" font-weight="700" letter-spacing="1" fill="#8ba0b0" text-anchor="end">HAVE</text>`,
      `<text x="${col.buy}" y="${y + 20}" font-size="9.5" font-weight="700" letter-spacing="1" fill="#8ba0b0" text-anchor="end">BUY</text>`,
      `<line x1="0" y1="${y + colHeadH}" x2="${W}" y2="${y + colHeadH}" stroke="#cfe0e8"/>`,
    );
    y += colHeadH;
    let sub = 0;
    g.rows.forEach((r, i) => {
      sub += r.buy;
      if (i % 2) parts.push(`<rect x="0" y="${y}" width="${W}" height="${rowH}" fill="#f7fbfd"/>`);
      parts.push(
        `<text x="${col.color}" y="${y + 20}" font-size="12.5" fill="#0f2536">${svgEscape(r.color || "—")}</text>`,
        `<text x="${col.size}" y="${y + 20}" font-size="12.5" fill="#0f2536">${svgEscape(r.size || "—")}</text>`,
        `<text x="${col.need}" y="${y + 20}" font-size="12" fill="#5c7386" text-anchor="end">${r.needed}</text>`,
        `<text x="${col.have}" y="${y + 20}" font-size="12" fill="#5c7386" text-anchor="end">${r.have}</text>`,
        `<text x="${col.buy}" y="${y + 20}" font-size="14" font-weight="800" fill="#0f2536" text-anchor="end">${r.buy}</text>`,
        `<line x1="0" y1="${y + rowH}" x2="${W}" y2="${y + rowH}" stroke="#e2edf3"/>`,
      );
      y += rowH;
    });
    parts.push(
      `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#cfe0e8" stroke-width="1.5"/>`,
      `<text x="${col.have}" y="${y + 21}" font-size="11" font-weight="800" fill="#5c7386" text-anchor="end">SUBTOTAL</text>`,
      `<text x="${col.buy}" y="${y + 21}" font-size="14" font-weight="800" fill="#0f2536" text-anchor="end">${sub}</text>`,
    );
    y += rowH + grpGap;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
    <rect width="${W}" height="${H}" fill="#ffffff"/>
    <text x="${padX}" y="42" font-size="22" font-weight="800" fill="#0f2536">Buy list — wholesaler run</text>
    <text x="${padX}" y="64" font-size="13" fill="#5c7386">${svgEscape(dateLabel)}</text>
    <text x="${W - padX}" y="42" font-size="14" font-weight="700" fill="#0f2536" text-anchor="end">Paribelle</text>
    <line x1="0" y1="${headH - 8}" x2="${W}" y2="${headH - 8}" stroke="#0f2536" stroke-width="1.5"/>
    ${parts.join("")}
    <rect x="${padX}" y="${H - footH + 12}" width="${W - padX * 2}" height="46" rx="10" fill="#0f2536"/>
    <text x="${padX + 18}" y="${H - footH + 40}" font-size="11" font-weight="800" letter-spacing="2" fill="#ffffff" opacity="0.8">TOTAL PIECES TO BUY</text>
    <text x="${W - padX - 18}" y="${H - footH + 42}" font-size="22" font-weight="800" fill="#ffffff" text-anchor="end">${grand}</text>
    <text x="${padX}" y="${H - 16}" font-size="10" fill="#8ba0b0">Generated ${svgEscape(now.toLocaleString("en-IN"))} · Paribelle OMS · “have” counted by hand</text>
  </svg>`;
}
