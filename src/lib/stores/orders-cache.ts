"use client";

import { withBasePath } from "@/lib/base-path";
import { create } from "zustand";

import type { OrdersView, OrdersViewParams } from "@/app/(app)/orders/view-actions";
import { useDashboardCache } from "./dashboard-cache";
import { useOrderDetailCache } from "./order-detail-cache";

/**
 * Client-side cache for the Orders tabs.
 *
 * Every tab used to be a server round trip, so alternating between "To ship",
 * "Shipped" and back re-ran the same queries each time: three clicks, three
 * full sets of database work, for data that had not changed. This keeps each
 * tab's payload once it has been fetched and serves it instantly on the way
 * back.
 *
 * The freshness rules matter as much as the caching, because a stale order
 * queue is worse than a slow one:
 *
 * - A sync bumps `syncStamp`, which invalidates everything. Anything the sync
 *   touched is by definition out of date.
 * - Any mutation we make (packing, a scan, a check-in) calls `invalidate()`
 *   for the tabs it could have changed.
 * - Beyond `STALE_MS` an entry is still served immediately but refetched in
 *   the background, so a tab left open does not drift.
 *
 * The cache is deliberately per-session and in memory. Orders change often
 * enough that persisting it across reloads would mean showing yesterday's
 * queue to someone opening the app in the morning.
 */

/** How long an entry is trusted before a background refresh is kicked off. */
const STALE_MS = 60_000;

interface Entry {
  data: OrdersView;
  fetchedAt: number;
  /** Guards against two components requesting the same key at once. */
  inFlight?: Promise<OrdersView>;
}

interface OrdersCacheState {
  entries: Record<string, Entry>;
  /** Bumped by a sync; every entry older than this is discarded. */
  syncStamp: number;

  /** Cached payload if present, regardless of age. */
  peek: (key: string) => OrdersView | null;
  /** True when the entry exists but is old enough to want a background refresh. */
  isStale: (key: string) => boolean;
  put: (key: string, data: OrdersView) => void;
  /** Drop specific keys, or every key whose view matches a prefix. */
  invalidate: (predicate?: (key: string) => boolean) => void;
  /** Called when a sync finishes. Nothing survives it. */
  bumpSync: () => void;

  /**
   * Fetch through the cache. Returns immediately from memory when possible and
   * only touches the server on a miss, deduplicating concurrent callers.
   */
  load: (
    key: string,
    params: OrdersViewParams,
    fetcher: (params: OrdersViewParams) => Promise<OrdersView>,
  ) => Promise<OrdersView>;
}

export const useOrdersCache = create<OrdersCacheState>((set, get) => ({
  entries: {},
  syncStamp: 0,

  peek: (key) => get().entries[key]?.data ?? null,

  isStale: (key) => {
    const entry = get().entries[key];
    if (!entry) return true;
    return Date.now() - entry.fetchedAt > STALE_MS;
  },

  put: (key, data) =>
    set((s) => ({
      entries: { ...s.entries, [key]: { data, fetchedAt: Date.now() } },
    })),

  invalidate: (predicate) =>
    set((s) => {
      if (!predicate) return { entries: {} };
      const next: Record<string, Entry> = {};
      for (const [k, v] of Object.entries(s.entries)) {
        if (!predicate(k)) next[k] = v;
      }
      return { entries: next };
    }),

  bumpSync: () => {
    // A sync rewrites orders wholesale. Everything derived from orders is as
    // stale as the tab payloads are: the per-order detail cache and the
    // dashboard's aggregates included.
    useOrderDetailCache.getState().clear();
    useDashboardCache.getState().clear();
    set((s) => ({ entries: {}, syncStamp: s.syncStamp + 1 }));
  },

  load: async (key, params, fetcher) => {
    const entry = get().entries[key];

    // Someone else is already asking for exactly this, so join them rather than
    // firing a second identical query.
    if (entry?.inFlight) return entry.inFlight;

    if (entry && Date.now() - entry.fetchedAt <= STALE_MS) return entry.data;

    const promise = fetcher(params).then((data) => {
      set((s) => ({ entries: { ...s.entries, [key]: { data, fetchedAt: Date.now() } } }));
      return data;
    });

    set((s) => ({
      entries: {
        ...s.entries,
        [key]: { data: entry?.data ?? (undefined as unknown as OrdersView), fetchedAt: entry?.fetchedAt ?? 0, inFlight: promise },
      },
    }));

    // Stale-while-revalidate: hand back what we have and let the refresh land.
    if (entry?.data) return entry.data;
    return promise;
  },
}));

/**
 * Invalidate the tabs a warehouse action could have changed.
 *
 * Packing or scanning moves an order between the queue's two cards and can
 * change the cancellation list, so the safe set is "anything derived from
 * orders". Kept as one helper so a new call site cannot forget one.
 *
 * An open order's detail is derived from orders too, so its cache is dropped
 * on the same beat.
 */
export function invalidateOrderViews() {
  useOrdersCache.getState().invalidate();
  useOrderDetailCache.getState().clear();
}

/* -------------------------------------------------------------------------- */
/* Navigation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A stable key for one view. Must capture every input that changes the result
 * and nothing that doesn't.
 */
export function ordersViewKey(params: OrdersViewParams): string {
  return [
    params.view ?? "list",
    params.status ?? "",
    params.channel ?? "",
    params.q?.trim() ?? "",
    params.resolved ?? "",
    params.tab ?? "unshipped",
  ].join("|");
}

export function paramsToQuery(params: OrdersViewParams): string {
  const p = new URLSearchParams();
  if (params.view) p.set("view", params.view);
  if (params.status) p.set("status", params.status);
  if (params.channel) p.set("channel", params.channel);
  if (params.q?.trim()) p.set("q", params.q.trim());
  if (params.resolved) p.set("resolved", params.resolved);
  if (params.tab && params.tab !== "unshipped") p.set("tab", params.tab);
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

export function queryToParams(search: string): OrdersViewParams {
  const p = new URLSearchParams(search);
  return {
    view: p.get("view") ?? undefined,
    status: p.get("status") ?? undefined,
    channel: p.get("channel") ?? undefined,
    q: p.get("q") ?? undefined,
    resolved: p.get("resolved") ?? undefined,
    tab: (p.get("tab") as "unshipped" | "packed" | "shipped24h" | null) ?? undefined,
  };
}

interface OrdersNavState {
  params: OrdersViewParams;
  /**
   * Switch tab without a server round trip. The URL is kept in step with
   * `history.pushState` so links stay shareable and back/forward still work,
   * but Next is never asked to re-render the route, which is the whole point.
   */
  go: (params: OrdersViewParams, opts?: { replace?: boolean }) => void;
  /** Adopt params from the URL, e.g. on first paint or a popstate. */
  adopt: (params: OrdersViewParams) => void;
}

export const useOrdersNav = create<OrdersNavState>((set) => ({
  params: {},

  go: (params, opts) => {
    if (typeof window !== "undefined") {
      const url = withBasePath(`/orders${paramsToQuery(params)}`);
      if (opts?.replace) window.history.replaceState(null, "", url);
      else window.history.pushState(null, "", url);
    }
    set({ params });
  },

  adopt: (params) => set({ params }),
}));
