"use client";

import { create } from "zustand";

/**
 * The two screens the top toggle switches between. Everything else in the app
 * ("/settings", "/pack", ...) is a normal route and never an override.
 */
export type Screen = "dashboard" | "orders";

/** Which screen a real Next route corresponds to, or null for anything else. */
export function screenFromPath(pathname: string): Screen | null {
  if (pathname === "/orders" || pathname.startsWith("/orders/")) return "orders";
  if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) return "dashboard";
  return null;
}

export function screenHref(screen: Screen): string {
  return screen === "orders" ? "/orders" : "/dashboard";
}

/**
 * The Dashboard/Orders toggle switches in place when the target screen is
 * already in its client cache, the same trick the Orders tabs use: move the
 * URL with `history.pushState` and swap the rendered screen, without asking
 * Next to navigate (both routes are `force-dynamic`, so a real navigation
 * always re-runs their queries on the server).
 *
 * `override` is that swapped screen. `null` means "render the actual route",
 * which is also the state after any genuine navigation. It is deliberately
 * not derived from the URL: `pushState` does not move `usePathname()`, so the
 * two are decoupled on purpose and the override is the source of truth for
 * what is on screen.
 */
interface ScreenNavState {
  override: Screen | null;
  setOverride: (screen: Screen | null) => void;
}

export const useScreenNav = create<ScreenNavState>((set) => ({
  override: null,
  setOverride: (override) => set({ override }),
}));
