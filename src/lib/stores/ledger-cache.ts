"use client";

import { create } from "zustand";

import type { LedgerData } from "@/app/(app)/dashboard/ledger-actions";
import type { Basis } from "@/app/(app)/dashboard/range";

import { createViewCache } from "./view-cache";

/** The Finance ledger, keyed by date range and basis. Cleared by a sync (see `bumpSync`). */
export const useLedgerCache = createViewCache<LedgerData>();

export const ledgerKey = (from: string, to: string, basis: Basis) => `${from}|${to}|${basis}`;

/** India time, so a default range matches the wall calendar. */
function isoDay(d: Date): string {
  return new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * What the ledger is showing, held outside React so leaving Finance for another
 * screen and coming back finds the same dates and the same view.
 */
interface LedgerNavState {
  from: string;
  to: string;
  view: "products" | "orders";
  set: (next: Partial<Pick<LedgerNavState, "from" | "to" | "view">>) => void;
}

export const useLedgerNav = create<LedgerNavState>((set) => ({
  from: isoDay(new Date(Date.now() - 29 * 86_400_000)),
  to: isoDay(new Date()),
  view: "products",
  set: (next) => set(next),
}));
