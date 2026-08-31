import { StatusBars, TopSkuBars } from "@/app/(app)/dashboard/charts";
import { ChannelTag, StatusBadge } from "@/components/ui";
import type { Channel, OrderStatus } from "@/db/schema";
import { dayLabel, money } from "@/lib/utils";

import type { AssistantCard } from "@/lib/assistant/agent";

const STATUS_COLORS: Record<string, string> = {
  fulfilled: "var(--ok)",
  in_progress: "var(--accent)",
  returned: "var(--danger)",
  cancelled: "var(--muted-2)",
};

const RANGE_LABEL: Record<string, string> = {
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all: "All time",
};

function CardShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="surface-2 p-3.5" style={{ borderColor: "var(--border)" }}>
      <h4 className="mb-2.5 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--muted)" }}>
        {title}
      </h4>
      {children}
    </div>
  );
}

/**
 * Every card here renders numbers the *tool* computed — the chat bubble text
 * above it is the model's gloss, never the source of the figures. That split
 * is what keeps this trustworthy: a hallucinated sentence is embarrassing, a
 * hallucinated revenue number is a real business risk.
 */
export function AssistantCardView({ card }: { card: AssistantCard }) {
  switch (card.type) {
    case "stats": {
      const c = card as unknown as {
        range: string;
        revenueFormatted: string;
        orders: number;
        avgOrderValue: number;
        cancellationRate: number;
        codRate: number;
        currentlyLate: number;
      };
      return (
        <CardShell title={RANGE_LABEL[c.range] ?? c.range}>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Metric label="Revenue" value={c.revenueFormatted} />
            <Metric label="Orders" value={String(c.orders)} />
            <Metric label="Avg order value" value={money(c.avgOrderValue)} />
            <Metric label="Cancellation rate" value={`${c.cancellationRate}%`} />
            <Metric label="COD rate" value={`${c.codRate}%`} />
            <Metric
              label="Past deadline now"
              value={String(c.currentlyLate)}
              tone={c.currentlyLate > 0 ? "danger" : undefined}
            />
          </div>
        </CardShell>
      );
    }

    case "status_breakdown": {
      const c = card as unknown as { range: string; buckets: { key: string; label: string; count: number }[] };
      return (
        <CardShell title={RANGE_LABEL[c.range] ?? c.range}>
          <StatusBars buckets={c.buckets as never} colors={STATUS_COLORS} />
        </CardShell>
      );
    }

    case "sku_list": {
      const c = card as unknown as {
        range: string;
        items: { sku: string; title: string | null; quantity: number; revenue: number }[];
      };
      return (
        <CardShell title={`Best sellers · ${RANGE_LABEL[c.range] ?? c.range}`}>
          <TopSkuBars items={c.items} format="money" />
        </CardShell>
      );
    }

    case "trend_summary": {
      const c = card as unknown as {
        range: string;
        totalRevenue: number;
        totalOrders: number;
        bestDay: { day: string; revenue: number; orders: number } | null;
      };
      return (
        <CardShell title={RANGE_LABEL[c.range] ?? c.range}>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Metric label="Total revenue" value={money(c.totalRevenue)} />
            <Metric label="Total orders" value={String(c.totalOrders)} />
            {c.bestDay ? (
              <Metric label="Best day" value={`${dayLabel(new Date(c.bestDay.day))} · ${money(c.bestDay.revenue)}`} />
            ) : null}
          </div>
        </CardShell>
      );
    }

    case "order_list": {
      const c = card as unknown as {
        query: string;
        items: {
          id: number;
          channel: string;
          externalOrderId: string;
          status: string;
          totalAmountFormatted: string | null;
          orderedAt: string;
          location: string | null;
        }[];
      };
      return (
        <CardShell title={`"${c.query}" — ${c.items.length} order${c.items.length === 1 ? "" : "s"}`}>
          {c.items.length === 0 ? (
            <p className="muted text-sm">No matching orders.</p>
          ) : (
            <div className="space-y-2">
              {c.items.map((o) => (
                <div key={o.id} className="flex items-center gap-2 text-xs">
                  <ChannelTag channel={o.channel as Channel} />
                  <span className="font-mono">{o.externalOrderId}</span>
                  <span className="muted flex-1 truncate">{o.location ?? ""}</span>
                  <span className="tabular-nums">{o.totalAmountFormatted ?? "—"}</span>
                  <StatusBadge status={o.status as OrderStatus} />
                </div>
              ))}
            </div>
          )}
        </CardShell>
      );
    }

    case "table": {
      const c = card as unknown as { sql: string; rowCount: number; columns: string[]; rows: Record<string, unknown>[] };
      return (
        <CardShell title={`Query result — ${c.rowCount} row${c.rowCount === 1 ? "" : "s"}`}>
          {c.rows.length === 0 ? (
            <p className="muted text-sm">No rows.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    {c.columns.map((col) => (
                      <th key={col} className="muted whitespace-nowrap px-2 py-1 font-medium">
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {c.rows.map((row, ri) => (
                    <tr key={ri} style={{ borderBottom: "1px solid var(--border)" }}>
                      {c.columns.map((col) => (
                        <td key={col} className="whitespace-nowrap px-2 py-1 tabular-nums">
                          {row[col] === null || row[col] === undefined ? "—" : String(row[col])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardShell>
      );
    }

    default:
      return null;
  }
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
  return (
    <div>
      <div className="muted text-[10px] uppercase tracking-wide">{label}</div>
      <div
        className="text-[15px] font-semibold tabular-nums"
        style={{ color: tone === "danger" ? "var(--danger)" : "var(--text)" }}
      >
        {value}
      </div>
    </div>
  );
}
