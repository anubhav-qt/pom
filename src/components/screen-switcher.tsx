"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

import { stripBasePath } from "@/lib/base-path";
import { ordersViewKey, useOrdersCache, useOrdersNav } from "@/lib/stores/orders-cache";
import { useDashboardCache, useDashboardNav } from "@/lib/stores/dashboard-cache";
import { screenFromPath, useScreenNav } from "@/lib/stores/screen-nav";

// Only pulled when an override actually activates, so /settings and friends do
// not carry the orders workspace in their first load.
const OrdersWorkspace = dynamic(
  () => import("@/app/(app)/orders/orders-workspace").then((m) => m.OrdersWorkspace),
  { ssr: false },
);
const DashboardWorkspace = dynamic(
  () => import("@/app/(app)/dashboard/dashboard-workspace").then((m) => m.DashboardWorkspace),
  { ssr: false },
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
 *  - Any genuine navigation changes `usePathname()` (pushState does not), so
 *    that is the signal to drop the override. Without this, a `<Link>` to
 *    /settings would render under a stale "show dashboard" override.
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
  }, [routePath]);

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

  if (override === "orders" && screenFromPath(routePath) !== "orders") {
    const params = useOrdersNav.getState().params;
    const data = useOrdersCache.getState().peek(ordersViewKey(params));
    if (data) return <OrdersWorkspace initialParams={params} initialData={data} />;
  }

  if (override === "dashboard" && screenFromPath(routePath) !== "dashboard") {
    const view = useDashboardCache.getState().peek(useDashboardNav.getState().range);
    if (view) return <DashboardWorkspace initialView={view} />;
  }

  return <>{children}</>;
}
