"use client";

import { withBasePath } from "@/lib/base-path";
import { create } from "zustand";

import type { DashboardView } from "@/app/(app)/dashboard/view-actions";
import { DEFAULT_RANGE, type Basis, type DashRange } from "@/app/(app)/dashboard/range";

/**
 * Client-side cache for the dashboard, keyed by range.
 *
 * Same shape and reasoning as the orders-view cache: switching range, or
 * toggling away to Orders and back, used to re-run four aggregate queries for
 * data that had not moved. An entry is served instantly and, past `STALE_MS`,
 * refreshed in the background so a dashboard left open does not drift.
 *
 * A finished sync clears it (see `bumpSync` in orders-cache): the dashboard is
 * entirely derived from orders, so a sync makes every number on it stale.
 */

const STALE_MS = 60_000;

interface Entry {
  data: DashboardView;
  fetchedAt: number;
  inFlight?: Promise<DashboardView>;
}

interface DashboardCacheState {
  /** Keyed by range. */
  entries: Partial<Record<string, Entry>>;

  peek: (key: string) => DashboardView | null;
  put: (key: string, data: DashboardView) => void;
  clear: () => void;

  load: (key: string, fetcher: () => Promise<DashboardView>) => Promise<DashboardView>;
}

export const useDashboardCache = create<DashboardCacheState>((set, get) => ({
  entries: {},

  peek: (key) => get().entries[key]?.data ?? null,

  put: (key, data) =>
    set((s) => ({ entries: { ...s.entries, [key]: { data, fetchedAt: Date.now() } } })),

  clear: () => set({ entries: {} }),

  load: async (key, fetcher) => {
    const entry = get().entries[key];
    if (entry?.inFlight) return entry.inFlight;
    if (entry && Date.now() - entry.fetchedAt <= STALE_MS) return entry.data;

    const promise = fetcher().then((data) => {
      set((s) => ({ entries: { ...s.entries, [key]: { data, fetchedAt: Date.now() } } }));
      return data;
    });

    set((s) => ({
      entries: {
        ...s.entries,
        [key]: {
          data: entry?.data ?? (undefined as unknown as DashboardView),
          fetchedAt: entry?.fetchedAt ?? 0,
          inFlight: promise,
        },
      },
    }));

    // Stale-while-revalidate: hand back what we have, let the refresh land.
    if (entry?.data) return entry.data;
    return promise;
  },
}));

/* -------------------------------------------------------------------------- */
/* Navigation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The selected range, held outside React so it survives the workspace
 * unmounting when the toggle switches to Orders and back. Mirrors
 * `useOrdersNav`: `go` moves the URL with `pushState` and updates the store;
 * `adopt` takes the range back from the URL on a `popstate`. `basis` only
 * applies to the Ledger; the Overview always counts by order date.
 */
interface DashboardNavState {
  range: DashRange;
  basis: Basis;
  go: (next: { range?: DashRange; basis?: Basis }, opts?: { replace?: boolean }) => void;
  adopt: (next: { range: DashRange; basis: Basis }) => void;
}

/** `/dashboard`, with only the parameters that differ from the defaults. */
export function dashboardUrl(range: DashRange, basis: Basis, tab?: string): string {
  const q = new URLSearchParams();
  if (range !== DEFAULT_RANGE) q.set("range", range);
  if (basis !== "paid") q.set("basis", basis);
  if (tab && tab !== "overview") q.set("tab", tab);
  const s = q.toString();
  return s ? `/dashboard?${s}` : "/dashboard";
}

export const useDashboardNav = create<DashboardNavState>((set, get) => ({
  range: DEFAULT_RANGE,
  basis: "paid",

  go: (next, opts) => {
    const range = next.range ?? get().range;
    const basis = next.basis ?? get().basis;
    if (typeof window !== "undefined") {
      const tab = new URLSearchParams(window.location.search).get("tab") ?? undefined;
      const url = withBasePath(dashboardUrl(range, basis, tab));
      if (opts?.replace) window.history.replaceState(null, "", url);
      else window.history.pushState(null, "", url);
    }
    set({ range, basis });
  },

  adopt: ({ range, basis }) => set({ range, basis }),
}));

/** The cached view for whatever range is currently selected, if any. */
export function peekCurrentDashboard(): DashboardView | null {
  return useDashboardCache.getState().peek(useDashboardNav.getState().range);
}
