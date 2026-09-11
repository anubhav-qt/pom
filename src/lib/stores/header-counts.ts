"use client";

import { create } from "zustand";

import type { HeaderCounts } from "@/components/app-header";

/**
 * The header's per-category counts (toShip / shipped / cancelledRto), mirrored
 * into a store so the mobile category dropdown — which lives in the page body,
 * not the header — can show the same numbers without a second query. `AppHeader`
 * is the only writer; it already receives these as a server-rendered prop.
 */
interface HeaderCountsState {
  counts: HeaderCounts | null;
  set: (counts: HeaderCounts) => void;
}

export const useHeaderCounts = create<HeaderCountsState>((set) => ({
  counts: null,
  set: (counts) => set({ counts }),
}));
