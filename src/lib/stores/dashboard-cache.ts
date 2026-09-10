"use client";

import { create } from "zustand";

import type { DashboardView } from "@/app/(app)/dashboard/view-actions";
import type { RangePreset } from "@/app/(app)/dashboard/range";
import { withBasePath } from "@/lib/base-path";

/**
 * Client-side cache for the dashboard, keyed by range preset.
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
  entries: Partial<Record<RangePreset, Entry>>;

  peek: (range: RangePreset) => DashboardView | null;
  put: (range: RangePreset, data: DashboardView) => void;
  clear: () => void;

  load: (
    range: RangePreset,
    fetcher: (range: string) => Promise<DashboardView>,
  ) => Promise<DashboardView>;
}

export const useDashboardCache = create<DashboardCacheState>((set, get) => ({
  entries: {},

  peek: (range) => get().entries[range]?.data ?? null,

  put: (range, data) =>
    set((s) => ({ entries: { ...s.entries, [range]: { data, fetchedAt: Date.now() } } })),

  clear: () => set({ entries: {} }),

  load: async (range, fetcher) => {
    const entry = get().entries[range];
    if (entry?.inFlight) return entry.inFlight;
    if (entry && Date.now() - entry.fetchedAt <= STALE_MS) return entry.data;

    const promise = fetcher(range).then((data) => {
      set((s) => ({ entries: { ...s.entries, [range]: { data, fetchedAt: Date.now() } } }));
      return data;
    });

    set((s) => ({
      entries: {
        ...s.entries,
        [range]: {
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
 * `adopt` takes the range back from the URL on a `popstate`.
 */
interface DashboardNavState {
  range: RangePreset;
  go: (range: RangePreset, opts?: { replace?: boolean }) => void;
  adopt: (range: RangePreset) => void;
}

export const useDashboardNav = create<DashboardNavState>((set) => ({
  range: "30d",

  go: (range, opts) => {
    if (typeof window !== "undefined") {
      const url = withBasePath(range === "30d" ? "/dashboard" : `/dashboard?range=${range}`);
      if (opts?.replace) window.history.replaceState(null, "", url);
      else window.history.pushState(null, "", url);
    }
    set({ range });
  },

  adopt: (range) => set({ range }),
}));
