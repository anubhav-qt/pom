"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

import { PageLoader } from "@/components/ui";
import { stripBasePath } from "@/lib/base-path";
import { ordersViewKey, useOrdersCache, useOrdersNav } from "@/lib/stores/orders-cache";
import { peekCurrentDashboard } from "@/lib/stores/dashboard-cache";
import { peekCurrentReturns } from "@/lib/stores/returns-cache";
import { resolveScreen, screenFromPath, useScreenNav } from "@/lib/stores/screen-nav";

// Only pulled when an override actually activates, so /settings and friends do
// not carry the orders workspace in their first load.
const OrdersWorkspace = dynamic(
  () => import("@/app/(app)/orders/orders-workspace").then((m) => m.OrdersWorkspace),
  { ssr: false, loading: () => <PageLoader /> },
);
const PdfPrinter = dynamic(
  () => import("@/app/(app)/pdf-printer/pdf-printer").then((m) => m.PdfPrinter),
  { ssr: false, loading: () => <PageLoader /> },
);
const ReturnsDesk = dynamic(
  () => import("@/app/(app)/returns/returns-table").then((m) => m.ReturnsDesk),
  { ssr: false, loading: () => <PageLoader /> },
);
const DashboardWorkspace = dynamic(
  () => import("@/app/(app)/dashboard/dashboard-workspace").then((m) => m.DashboardWorkspace),
  { ssr: false, loading: () => <PageLoader /> },
);

/**
 * Renders the real route, or a cached screen the top toggle swapped in.
 *
 * The toggle sets `override` and moves the URL with `pushState` when the
 * target screen is already cached (see `AppSwitch`). `pushState` does not
 * re-run Next, so `children` is still whatever the server last rendered; this
 * component decides what to actually show.
 *
 * Two things keep the override honest:
 *  - Any genuine navigation gives this component a new `children` (Next
 *    re-renders the route and hands down a fresh element), so that is the
 *    signal to drop the override. Without this, a `<Link>` to /settings would
 *    render under a stale "show dashboard" override.
 *
 *    This deliberately does NOT key off `usePathname()`: Next's own router
 *    patches `history.pushState`/`replaceState` to mirror *any* history
 *    mutation into its internal state, including the plain `pushState` calls
 *    `AppSwitch` makes for an in-place swap. That means `usePathname()` now
 *    changes even though nothing was actually re-rendered — keying the
 *    cleanup off it would clear the override the instant it was set, and the
 *    body would fall back to stale `children` while the header (reading the
 *    same, now-null override) still looked right. `children`'s identity is
 *    unaffected by that mirroring, so it stays a reliable "did Next actually
 *    navigate" signal.
 *  - `popstate` recomputes the override from the path the browser landed on.
 */
export function ScreenSwitcher({ children }: { children: React.ReactNode }) {
  const routePath = usePathname();
  const override = useScreenNav((s) => s.override);

  // Kept in a ref so the popstate listener, attached once, always compares
  // against the current real route.
  const routePathRef = useRef(routePath);
  routePathRef.current = routePath;

  useEffect(() => {
    useScreenNav.getState().setOverride(null);
  }, [children]);

  useEffect(() => {
    const onPop = () => {
      const popped = stripBasePath(window.location.pathname);
      const poppedScreen = screenFromPath(popped);
      // Back on the path the server actually rendered: no override needed.
      // Landed on the other screen of the pair: override to it. Anywhere
      // else: clear and let the real route show.
      if (popped === routePathRef.current || !poppedScreen) {
        useScreenNav.getState().setOverride(null);
      } else {
        useScreenNav.getState().setOverride(poppedScreen);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // The same check `AppHeader` uses to decide which tabs to light, so the
  // two can never disagree about what's actually on screen: if the override
  // points somewhere the cache can't actually serve, both fall back to the
  // real route together instead of one showing new tabs over old content.
  const resolved = resolveScreen(routePath, override);

  // An override the cache couldn't back up is dead weight — left alone, it
  // would spring back to life the moment something populates that cache
  // entry later, swapping the screen out from under whoever is reading it.
  useEffect(() => {
    if (override !== null && resolved !== override) useScreenNav.getState().setOverride(null);
  }, [override, resolved]);

  // Deliberately keyed on `override`, not on comparing `routePath` to the
  // target screen: Next mirrors `usePathname()` to match our own pushState
  // (see the class comment), so right after a cached swap `routePath` already
  // reads as the target screen even though `children` is still whatever was
  // last actually rendered. `override` only reflects our own swap intent, so
  // it stays a reliable "is there a swap to render" signal regardless of what
  // Next's router does with the URL behind it.
  if (override === "orders" && resolved === "orders") {
    const params = useOrdersNav.getState().params;
    const data = useOrdersCache.getState().peek(ordersViewKey(params));
    if (data) return <OrdersWorkspace initialParams={params} initialData={data} />;
  }

  if (override === "dashboard" && resolved === "dashboard") {
    const view = peekCurrentDashboard();
    if (view) return <DashboardWorkspace initialView={view} />;
  }

  if (override === "returns" && resolved === "returns") {
    const view = peekCurrentReturns();
    if (view) return <ReturnsDesk initialView={view} initialTab="returns" />;
  }

  if (override === "pdf-printer" && resolved === "pdf-printer") return <PdfPrinter />;

  return <>{children}</>;
}
