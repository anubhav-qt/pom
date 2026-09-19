"use client";

import { create } from "zustand";

import type { ReturnsView } from "@/app/(app)/returns/view-actions";

import { createViewCache } from "./view-cache";

/** The Returns screen, keyed by whether the RTO list shows completed records. Cleared by a sync or any change made there. */
export const useReturnsCache = createViewCache<ReturnsView>();

export const returnsKey = (resolved: boolean) => (resolved ? "1" : "0");

export type ReturnsTab = "returns" | "rto";
export type ReturnsFilter = "todo" | "overdue" | "done";

interface ReturnsNavState {
  /** Whether the RTO list shows completed records rather than pending ones. */
  resolved: boolean;
  tab: ReturnsTab;
  filter: ReturnsFilter;
  /** What the header search box holds. */
  query: string;
  setResolved: (resolved: boolean) => void;
  setTab: (tab: ReturnsTab) => void;
  setFilter: (filter: ReturnsFilter) => void;
  setQuery: (query: string) => void;
}

/**
 * What the Returns screen is showing, held outside React so it survives the
 * screen unmounting when the toggle switches away and back, and so the header
 * rail and search box can drive it without living inside it.
 */
export const useReturnsNav = create<ReturnsNavState>((set) => ({
  resolved: false,
  tab: "returns",
  filter: "todo",
  query: "",
  setResolved: (resolved) => set({ resolved }),
  setTab: (tab) => set({ tab }),
  setFilter: (filter) => set({ filter }),
  setQuery: (query) => set({ query }),
}));

/** The cached view for whichever RTO list is selected, if any. */
export function peekCurrentReturns(): ReturnsView | null {
  return useReturnsCache.getState().peek(returnsKey(useReturnsNav.getState().resolved));
}
