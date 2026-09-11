"use client";

import { create } from "zustand";

import { ordersViewKey, useOrdersCache, useOrdersNav } from "./orders-cache";
import { useDashboardCache, useDashboardNav } from "./dashboard-cache";

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

/**
 * What should actually be on screen: the override, but only when the screen
 * it points at is something the in-place swap can actually render.
 *
 * `AppHeader` (which tabs are lit) and `ScreenSwitcher` (what body renders)
 * used to each answer this question themselves, and could disagree — the
 * override says "orders" so the header lights the Orders tab, but the swap's
 * own cache lookup comes up empty (a stale pushState entry from a popstate,
 * a cache a sync just cleared, ...) so the body quietly falls back to
 * `children`, whatever route was last actually rendered. One function, used
 * by both, means they can no longer land on different answers.
 */
export function resolveScreen(pathname: string, override: Screen | null): Screen | null {
  const route = screenFromPath(pathname);
  if (override === null || override === route) return route;

  const cached =
    override === "orders"
      ? useOrdersCache.getState().peek(ordersViewKey(useOrdersNav.getState().params)) !== null
      : useDashboardCache.getState().peek(useDashboardNav.getState().range) !== null;

  return cached ? override : route;
}
