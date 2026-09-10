"use client";

import { create } from "zustand";

import type { OrderDetail } from "@/app/(app)/orders/actions";

/**
 * Client-side cache for the order detail popup, keyed by order id.
 *
 * The modal is remounted every time it opens, so without this it refetched
 * `getOrderDetail` on every open and flashed its skeleton each time, even for
 * an order looked at seconds earlier.
 *
 * Unlike the orders-view cache next door, there is no staleness timer. A
 * detail is trusted until something explicitly invalidates it:
 *
 * - Any warehouse mutation clears the cache, through `invalidateOrderViews()`
 *   in orders-cache.ts. That helper is deliberately coarse ("anything derived
 *   from orders"), and a detail is derived from orders.
 * - A finished sync clears it, through `bumpSync()`. A sync rewrites orders
 *   wholesale, so nothing cached survives it.
 *
 * Between those events the data does not change under us: there is one
 * operator, and every write goes through an action that invalidates. So
 * "cached until invalidated" is correct here, not just convenient.
 */

interface Entry {
  data: OrderDetail;
  /** Dedupes two opens of the same order before the first fetch lands. */
  inFlight?: Promise<OrderDetail | null>;
}

interface OrderDetailCacheState {
  entries: Record<number, Entry>;

  /** Cached detail if present. */
  peek: (orderId: number) => OrderDetail | null;
  /** Drop everything. Called by the orders-view invalidation paths. */
  clear: () => void;

  /**
   * Fetch through the cache. Returns the cached detail immediately when there
   * is one, joins an in-flight request for the same order, and otherwise
   * fetches. A `null` result (order not found) is not cached: it is an error
   * state, and the next open should try again.
   */
  load: (
    orderId: number,
    fetcher: (orderId: number) => Promise<OrderDetail | null>,
  ) => Promise<OrderDetail | null>;
}

export const useOrderDetailCache = create<OrderDetailCacheState>((set, get) => ({
  entries: {},

  peek: (orderId) => get().entries[orderId]?.data ?? null,

  clear: () => set({ entries: {} }),

  load: async (orderId, fetcher) => {
    const entry = get().entries[orderId];
    if (entry?.inFlight) return entry.inFlight;
    if (entry) return entry.data;

    const promise = fetcher(orderId).then((data) => {
      set((s) => {
        if (!data) {
          // Not found: drop the in-flight marker, cache nothing.
          const next = { ...s.entries };
          delete next[orderId];
          return { entries: next };
        }
        return { entries: { ...s.entries, [orderId]: { data } } };
      });
      return data;
    });

    // No entry yet (both early returns above missed), so this is a bare
    // in-flight marker. `peek` still returns null until the promise lands.
    set((s) => ({
      entries: {
        ...s.entries,
        [orderId]: { data: undefined as unknown as OrderDetail, inFlight: promise },
      },
    }));

    return promise;
  },
}));
