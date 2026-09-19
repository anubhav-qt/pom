"use client";

import { Spinner } from "@/components/ui";
import { ItemTitle } from "@/components/item-title";
import { useState } from "react";

import { Modal } from "@/components/modal";

import { exportSvg, svgEscape, truncate } from "./sheet-export";
import type { PickRow } from "./queries";

/* -------------------------------------------------------------------------- */
/* Button (sits in the collection toolbar, right-aligned)                     */
/* -------------------------------------------------------------------------- */

export function CollectionSheetButton({ rows }: { rows: PickRow[] }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={rows.length === 0}
        className="btn text-xs"
        title="Collection sheet — a printable list of everything to pull, for the wholesaler run"
      >
        <ClipboardIcon />
        Collection sheet
      </button>
      {open ? <CollectionSheetModal rows={rows} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Modal — on-screen table + JPEG / PDF export                               */
/* -------------------------------------------------------------------------- */

function CollectionSheetModal({ rows, onClose }: { rows: PickRow[]; onClose: () => void }) {
  const [busy, setBusy] = useState<null | "jpeg" | "pdf">(null);
  const [error, setError] = useState<string | null>(null);

  const today = new Date();
  const dateLabel = today.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  const stampLabel = today.toLocaleString("en-IN");

  const totalUnits = rows.reduce((a, r) => a + r.unitsNeeded, 0);
  const totalOrders = new Set(rows.flatMap((r) => r.orderIds)).size;

  async function exportAs(kind: "jpeg" | "pdf") {
    setBusy(kind);
    setError(null);
    try {
      const svg = buildSheetSvg(rows, { dateLabel, stampLabel, totalUnits, totalOrders });
      await exportSvg(svg, kind, `collection-sheet-${today.toISOString().slice(0, 10)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal title={`Collection sheet · ${dateLabel}`} onClose={onClose} width="46rem">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="muted text-sm">
            {rows.length} product{rows.length === 1 ? "" : "s"} · {totalUnits} unit
            {totalUnits === 1 ? "" : "s"} · {totalOrders} order{totalOrders === 1 ? "" : "s"}
          </p>
          <div className="flex gap-2">
            <button className="btn text-xs" disabled={busy !== null} onClick={() => exportAs("jpeg")}>
              {busy === "jpeg" ? <Spinner size="1rem" color="currentColor" /> : "Save JPEG"}
            </button>
            <button
              className="btn btn-primary text-xs"
              disabled={busy !== null}
              onClick={() => exportAs("pdf")}
            >
              {busy === "pdf" ? <Spinner size="1rem" color="currentColor" /> : "Save PDF"}
            </button>
          </div>
        </div>

        {error ? (
          <p className="rounded-lg px-3 py-2 text-sm" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}>
            {error}
          </p>
        ) : null}

        <div className="panel overflow-x-auto">
          <table className="grid-table">
            <thead>
              <tr>
                <th className="w-8">#</th>
                <th>Product</th>
                <th>Bin</th>
                <th className="text-right">Units</th>
                <th className="text-right">Orders</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.key}>
                  <td className="tabular-nums" style={{ color: "var(--muted)" }}>
                    {i + 1}
                  </td>
                  <td>
                    <ItemTitle title={r.title} empty="Unnamed product" />
                    <div className="muted mt-0.5 font-mono text-[11px]">{r.sku}</div>
                  </td>
                  <td className="tabular-nums">{r.binLocation ?? "—"}</td>
                  <td className="text-right text-[15px] font-semibold tabular-nums">{r.unitsNeeded}</td>
                  <td className="text-right tabular-nums" style={{ color: "var(--muted)" }}>
                    {r.orderCount}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3} className="text-right text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--muted)" }}>
                  Total
                </td>
                <td className="text-right text-[15px] font-semibold tabular-nums">{totalUnits}</td>
                <td className="text-right tabular-nums" style={{ color: "var(--muted)" }}>
                  {totalOrders}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Rendering the sheet as a self-contained SVG (rasterised by ./sheet-export)  */
/* -------------------------------------------------------------------------- */

const esc = svgEscape;

function buildSheetSvg(
  rows: PickRow[],
  meta: { dateLabel: string; stampLabel: string; totalUnits: number; totalOrders: number },
) {
  const W = 960;
  const padX = 40;
  const headerH = 96;
  const colHeadH = 40;
  const rowH = 40;
  const footH = 64;
  const H = headerH + colHeadH + rows.length * rowH + rowH /* totals */ + footH;

  const x = { idx: padX, name: padX + 44, bin: W - 300, units: W - 190, orders: W - 80 };

  const body = rows
    .map((r, i) => {
      const y = headerH + colHeadH + i * rowH;
      const zebra =
        i % 2 === 1
          ? `<rect x="0" y="${y}" width="${W}" height="${rowH}" fill="#f4f9fc"/>`
          : "";
      return `
        ${zebra}
        <text x="${x.idx}" y="${y + 26}" font-size="13" fill="#8ba0b0">${i + 1}</text>
        <text x="${x.name}" y="${y + 21}" font-size="14" font-weight="600" fill="#0f2536">${esc(
          truncate(r.title ?? "Unnamed product", 64),
        )}</text>
        <text x="${x.name}" y="${y + 35}" font-size="11" fill="#5c7386" font-family="ui-monospace,Menlo,Consolas,monospace">${esc(
          r.sku,
        )}</text>
        <text x="${x.bin}" y="${y + 26}" font-size="13" fill="#0f2536">${esc(r.binLocation ?? "—")}</text>
        <text x="${x.units}" y="${y + 26}" font-size="15" font-weight="700" fill="#0f2536" text-anchor="end">${r.unitsNeeded}</text>
        <text x="${x.orders}" y="${y + 26}" font-size="13" fill="#5c7386" text-anchor="end">${r.orderCount}</text>
        <line x1="0" y1="${y + rowH}" x2="${W}" y2="${y + rowH}" stroke="#e2edf3" stroke-width="1"/>`;
    })
    .join("");

  const totalsY = headerH + colHeadH + rows.length * rowH;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
    <rect width="${W}" height="${H}" fill="#ffffff"/>
    <text x="${padX}" y="40" font-size="22" font-weight="700" fill="#0f2536">Collection sheet</text>
    <text x="${padX}" y="62" font-size="13" fill="#5c7386">${esc(meta.dateLabel)}</text>
    <text x="${W - padX}" y="40" font-size="13" fill="#5c7386" text-anchor="end">Paribelle</text>
    <text x="${W - padX}" y="62" font-size="12" fill="#8ba0b0" text-anchor="end">${rows.length} products · ${meta.totalUnits} units · ${meta.totalOrders} orders</text>
    <line x1="0" y1="${headerH - 8}" x2="${W}" y2="${headerH - 8}" stroke="#0f2536" stroke-width="1.5"/>

    <rect x="0" y="${headerH - 8}" width="${W}" height="${colHeadH}" fill="#eef6fa"/>
    <text x="${x.name}" y="${headerH + 14}" font-size="10.5" font-weight="700" fill="#8ba0b0" letter-spacing="1">PRODUCT</text>
    <text x="${x.bin}" y="${headerH + 14}" font-size="10.5" font-weight="700" fill="#8ba0b0" letter-spacing="1">BIN</text>
    <text x="${x.units}" y="${headerH + 14}" font-size="10.5" font-weight="700" fill="#8ba0b0" letter-spacing="1" text-anchor="end">UNITS</text>
    <text x="${x.orders}" y="${headerH + 14}" font-size="10.5" font-weight="700" fill="#8ba0b0" letter-spacing="1" text-anchor="end">ORDERS</text>
    <line x1="0" y1="${headerH + colHeadH - 8}" x2="${W}" y2="${headerH + colHeadH - 8}" stroke="#cfe0e8" stroke-width="1"/>

    ${body}

    <rect x="0" y="${totalsY}" width="${W}" height="${rowH}" fill="#eef6fa"/>
    <text x="${x.bin}" y="${totalsY + 26}" font-size="12" font-weight="700" fill="#5c7386" text-anchor="end">TOTAL</text>
    <text x="${x.units}" y="${totalsY + 26}" font-size="15" font-weight="800" fill="#0f2536" text-anchor="end">${meta.totalUnits}</text>
    <text x="${x.orders}" y="${totalsY + 26}" font-size="13" fill="#5c7386" text-anchor="end">${meta.totalOrders}</text>

    <text x="${padX}" y="${H - 24}" font-size="10.5" fill="#8ba0b0">Generated ${esc(meta.stampLabel)} · Paribelle OMS</text>
  </svg>`;
}

function ClipboardIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="8" y="3" width="8" height="4" rx="1" />
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
      <path d="M9 12h6M9 16h4" />
    </svg>
  );
}
