"use client";

import { create } from "zustand";

/**
 * A keyed, stale-while-revalidate cache for one screen's data — the same
 * behaviour as the Orders and Finance overview caches, made generic so the
 * ledger and the Returns desk get it too.
 *
 * An entry is served instantly; past `STALE_MS` the next `load` hands back what
 * it has and refreshes in the background. A finished sync, or any change made
 * on the screen, clears it.
 */

const STALE_MS = 60_000;

interface Entry<T> {
  data: T;
  fetchedAt: number;
  inFlight?: Promise<T>;
}

export interface ViewCache<T> {
  entries: Partial<Record<string, Entry<T>>>;
  peek: (key: string) => T | null;
  put: (key: string, data: T) => void;
  clear: () => void;
  load: (key: string, fetcher: () => Promise<T>) => Promise<T>;
}

export function createViewCache<T>() {
  return create<ViewCache<T>>((set, get) => ({
    entries: {},

    peek: (key) => get().entries[key]?.data ?? null,

    put: (key, data) => set((s) => ({ entries: { ...s.entries, [key]: { data, fetchedAt: Date.now() } } })),

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
            data: entry?.data ?? (undefined as unknown as T),
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
}
