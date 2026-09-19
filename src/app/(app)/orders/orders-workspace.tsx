"use client";

import { useEffect, useRef, useState } from "react";

import { STATUS_LABELS, Stat } from "@/components/ui";
import {
  invalidateOrderViews,
  ordersViewKey,
  queryToParams,
  useOrdersCache,
  useOrdersNav,
} from "@/lib/stores/orders-cache";

import { CancellationsPanel } from "./cancellations-panel";
import { CollectionSheetButton } from "./collection-sheet";
import { MobileOrdersCrumb } from "./mobile-orders-crumb";
import { MobileOrdersNav } from "./mobile-orders-nav";
import { OrderTable } from "./order-table";
import { OrdersToolbar } from "./orders-toolbar";
import { AllOrdersTiles, PickList } from "./pick-list";
import { RailTabs } from "./rail-tabs";
import { RestockPlanner } from "./restock-planner";
import { ScanBarcodeButton } from "./scan/scan-button";
import { getOrdersView, type OrdersView, type OrdersViewParams } from "./view-actions";

/**
 * The Orders screen, rendered from the client cache.
 *
 * The server still renders the first view, so a cold open paints real data with
 * no spinner and the URL is shareable. After that, switching tabs is a cache
 * lookup rather than a navigation: `useOrdersNav` moves the URL with
 * `history.pushState`, this component re-reads from `useOrdersCache`, and the
 * database is only touched when a tab has not been seen yet or has gone stale.
 *
 * Freshness is handled in the store, not here. See the note there. The one
 * thing this owns is putting the server's first payload into the cache so the
 * initial tab counts as already fetched.
 */
export function OrdersWorkspace({
  initialParams,
  initialData,
}: {
  initialParams: OrdersViewParams;
  initialData: OrdersView;
}) {
  const params = useOrdersNav((s) => s.params);
  const adopt = useOrdersNav((s) => s.adopt);
  const go = useOrdersNav((s) => s.go);

  const [data, setData] = useState<OrdersView>(initialData);
  const [loading, setLoading] = useState(false);

  // Seed synchronously on first render: an effect would let the first tab
  // switch race the seed and refetch a view we were handed for free.
  const seeded = useRef(false);
  if (!seeded.current) {
    seeded.current = true;
    useOrdersCache.getState().put(ordersViewKey(initialParams), initialData);
    if (Object.keys(params).length === 0) useOrdersNav.setState({ params: initialParams });
  }

  // Back / forward have to put the store back in step: the URL changed without
  // us, so nothing else would notice.
  useEffect(() => {
    const onPop = () => adopt(queryToParams(window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [adopt]);

  const key = ordersViewKey(params);

  useEffect(() => {
    let cancelled = false;
    const cache = useOrdersCache.getState();

    const cached = cache.peek(key);
    if (cached) setData(cached);
    else setLoading(true);

    cache
      .load(key, params, getOrdersView)
      .then((fresh) => {
        if (!cancelled) {
          setData(fresh);
          setLoading(false);
        }
        // A stale entry is served instantly while a refetch runs in the
        // background; pick that refetch up too, otherwise the screen keeps
        // showing the old queue (e.g. orders already shipped elsewhere).
        const inFlight = useOrdersCache.getState().entries[key]?.inFlight;
        inFlight
          ?.then((latest) => {
            if (!cancelled) setData(latest);
          })
          .catch(() => {});
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // `key` is the whole identity of a view; `params` only ever changes with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  /** Re-read the current tab from the server after we changed something. */
  function refresh() {
    invalidateOrderViews();
    setLoading(true);
    useOrdersCache
      .getState()
      .load(key, params, getOrdersView)
      .then((fresh) => {
        setData(fresh);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }

  const busy = loading ? "opacity-60 transition-opacity" : "transition-opacity";

  if (data.kind === "planner") {
    return (
      <div className={`space-y-5 ${busy}`}>
        <MobileOrdersCrumb />
        <OrdersToolbar activeView="planner" activeChannel={data.channel} query={data.query} />
        <RestockPlanner initialPlan={data.plan} />
        <MobileOrdersNav activeView="planner" activeChannel={data.channel} query={data.query} scanStation="outbound" onScanDone={refresh} />
      </div>
    );
  }

  if (data.kind === "collection") {
    const isToShipUnshipped = data.category === "toShip";
    const isAllRoot = data.category === "all" && !data.drillStatus;

    const sub =
      isToShipUnshipped
        ? {
            activeId: "unshipped",
            activeLabel: "Unshipped",
            // Collection has no defined meaning for Packed / Shipped (24h) yet —
            // shown, not hidden, but disabled rather than pretending they work.
            options: [
              { id: "unshipped", label: "Unshipped" },
              { id: "packed", label: "Packed", disabled: true },
              { id: "shipped24h", label: "Shipped (24h)", disabled: true },
            ],
            onSelect: () => {},
          }
        : data.category === "cancellations"
          ? {
              activeId: data.resolved ? "completed" : "pending",
              activeLabel: data.resolved ? "Completed" : "Pending",
              options: [
                { id: "pending", label: "Pending", count: data.cancellationCounts?.pending },
                { id: "completed", label: "Completed", count: data.cancellationCounts?.completed },
              ],
              onSelect: (id: string) => go({ ...params, resolved: id === "completed" ? "1" : undefined }),
            }
          : undefined;

    return (
      <div className={`space-y-5 pb-20 ${busy} sm:pb-0`}>
        <MobileOrdersCrumb
          sub={sub}
          staticSubLabel={data.drillStatus ? STATUS_LABELS[data.drillStatus] : undefined}
        />
        <OrdersToolbar
          activeView="collection"
          activeChannel={data.channel}
          query={data.query}
          showSwitcher={data.category === "toShip"}
          rightSlot={
            <div className="flex items-center gap-2">
              <CollectionSheetButton rows={data.rows} />
              <ScanBarcodeButton station="outbound" onDone={refresh} />
            </div>
          }
        />
        {isAllRoot ? (
          <AllOrdersTiles tiles={data.tiles ?? []} />
        ) : (
          <PickList rows={data.rows} category={data.category} />
        )}
        <MobileOrdersNav activeView="collection" activeChannel={data.channel} query={data.query} scanStation="outbound" onScanDone={refresh} />
      </div>
    );
  }

  if (data.kind === "cancellations") {
    const setResolved = (resolved: boolean) => go({ ...params, resolved: resolved ? "1" : undefined });

    return (
      <div className={`space-y-5 pb-20 ${busy} sm:pb-0`}>
        <MobileOrdersCrumb
          sub={{
            activeId: data.resolved ? "completed" : "pending",
            activeLabel: data.resolved ? "Completed" : "Pending",
            options: [
              { id: "pending", label: "Pending", count: data.counts.pending },
              { id: "completed", label: "Completed", count: data.counts.completed },
            ],
            onSelect: (id) => setResolved(id === "completed"),
          }}
        />
        <CancellationsPanel
          records={data.records}
          counts={data.counts}
          resolved={data.resolved}
          onResolvedChange={setResolved}
          rightSlot={<ScanBarcodeButton station="inbound" onDone={refresh} />}
        />
        <MobileOrdersNav activeView={null} query="" scanStation="inbound" onScanDone={refresh} />
      </div>
    );
  }

  return (
    <div className={`space-y-5 pb-20 ${busy} sm:pb-0`}>
      <MobileOrdersCrumb
        sub={
          data.isQueueView && data.counts
            ? {
                activeId: data.activeTab,
                activeLabel: { unshipped: "Unshipped", packed: "Packed", shipped24h: "Shipped (24h)" }[
                  data.activeTab
                ],
                options: [
                  { id: "unshipped", label: "Unshipped", count: data.counts.unshipped },
                  { id: "packed", label: "Packed", count: data.counts.packed },
                  { id: "shipped24h", label: "Shipped (24h)", count: data.counts.shipped24h },
                ],
                onSelect: (id) => go({ ...params, tab: id === "unshipped" ? undefined : (id as "packed" | "shipped24h") }),
              }
            : undefined
        }
      />

      {/* Styled and positioned to read as a direct continuation of the
          header's own category rail — first thing in the page, no gap.
          Desktop only; mobile gets the crumb above instead. */}
      {data.isQueueView && data.counts ? (
        <RailTabs
          tabs={[
            { id: "unshipped" as const, label: "Unshipped", count: data.counts.unshipped },
            { id: "packed" as const, label: "Packed", count: data.counts.packed },
            { id: "shipped24h" as const, label: "Shipped (24h)", count: data.counts.shipped24h },
          ]}
          active={data.activeTab}
          onSelect={(tab) => go({ ...params, tab: tab === "unshipped" ? undefined : tab })}
        />
      ) : null}

      {data.isQueueView && data.counts && data.activeTab === "unshipped" && data.counts.late > 0 ? (
        <div
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium"
          style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--danger)" }} />
          <span>{data.counts.late} past dispatch deadline</span>
        </div>
      ) : null}

      <OrdersToolbar
        activeView="list"
        activeChannel={data.channel}
        query={data.query}
        showSwitcher={data.isQueueView}
        rightSlot={data.isQueueView ? <ScanBarcodeButton station="outbound" onDone={refresh} /> : undefined}
      />

      <OrderTable rows={data.rows} activeTab={data.activeTab} onChanged={refresh} />

      <MobileOrdersNav activeView="list" activeChannel={data.channel} query={data.query} scanStation="outbound" onScanDone={refresh} />
    </div>
  );
}
