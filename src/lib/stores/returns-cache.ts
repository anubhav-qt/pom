"use client";

import { create } from "zustand";

import type { ReturnsView } from "@/app/(app)/returns/view-actions";

import { createViewCache } from "./view-cache";

/** The Returns screen, keyed by whether the RTO list shows completed records. Cleared by a sync or any change made there. */
export const useReturnsCache = createViewCache<ReturnsView>();

export const returnsKey = (resolved: boolean) => (resolved ? "1" : "0");

/** Held outside React so it survives the screen unmounting when the toggle switches away and back. */
export const useReturnsNav = create<{ resolved: boolean; setResolved: (resolved: boolean) => void }>((set) => ({
  resolved: false,
  setResolved: (resolved) => set({ resolved }),
}));

/** The cached view for whichever RTO list is selected, if any. */
export function peekCurrentReturns(): ReturnsView | null {
  return useReturnsCache.getState().peek(returnsKey(useReturnsNav.getState().resolved));
}
