"use client";

import { KeyRound, LogOut, RefreshCw, Settings as SettingsIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { DropdownMenu } from "@/components/dropdown-menu";
import {
  ordersViewKey,
  paramsToQuery,
  queryToParams,
  useOrdersCache,
  useOrdersNav,
} from "@/lib/stores/orders-cache";
import { useDashboardCache, useDashboardNav } from "@/lib/stores/dashboard-cache";
import { useHeaderCounts } from "@/lib/stores/header-counts";
import { resolveScreen, screenFromPath, screenHref, useScreenNav, type Screen } from "@/lib/stores/screen-nav";
import type { OrdersViewParams } from "@/app/(app)/orders/view-actions";
import { STATUS_LABELS } from "@/components/ui";
import { withBasePath } from "@/lib/base-path";
import { cn } from "@/lib/utils";

/** Where `RailTabs` mounts itself: band 3 of the header. */
export const RAIL_SLOT_ID = "header-rail-slot";

export interface HeaderCounts {
  toShip: number;
  shipped: number;
  cancelledRto: number;
}

interface SyncResult {
  ok: boolean;
  runId?: number;
  error?: string;
}

/**
 * `ok` only when a sync was actually started. `skipped` says why not: the last
 * one is still recent, or one is already running.
 *
 * `runId` is the thing to act on, not `ok`. It comes back both for a run we
 * started and for one already in flight, and either way it has to be watched.
 */
interface AutoSyncResult {
  ok: boolean;
  runId?: number;
  skipped?: "fresh" | "running" | "error";
}

/**
 * The app's header: a single merged top bar, replacing the old floating pill.
 *
 *  Band 1 — brand · Dashboard/Orders switch · sync status · Sync now · avatar.
 *           Shown on every screen.
 *  Band 2 — the Orders status tabs. Shown only on /orders.
 *
 * It is sticky rather than fixed, so it reserves its own layout space and page
 * content no longer needs a hand-tuned top padding to clear it.
 */
export function AppHeader({
  userName,
  lastSyncAt,
  primaryAccountId,
  counts,
  onSignOut,
  onSyncNow,
  onAutoSync,
}: {
  userName: string;
  /** ISO timestamp of the most recent sync run, or null if none yet. */
  lastSyncAt: string | null;
  /** The account "Sync now" acts on, or null if no account is connected. */
  primaryAccountId: number | null;
  counts: HeaderCounts;
  /** Server action — a real form-less call, kept identical to the proven one. */
  onSignOut: () => Promise<void>;
  /** Server action that kicks a manual sync and returns its run id. */
  onSyncNow: (accountId: number) => Promise<SyncResult>;
  /** Server action that syncs on open, but only when one is due. */
  onAutoSync: (accountId: number) => Promise<AutoSyncResult>;
}) {
  const pathname = usePathname();
  const override = useScreenNav((s) => s.override);
  // What is actually on screen: the toggle can swap in a cached screen without
  // moving the Next route, so band 2 and the switch highlight follow this, not
  // the pathname. Resolved the same way `ScreenSwitcher` decides what to
  // render, so the tabs and the body can never disagree about which screen
  // is showing.
  const effectiveScreen = resolveScreen(pathname, override);
  const onOrders = effectiveScreen === "orders";

  // Mirrored into a store so the mobile category dropdown (rendered in the
  // page body, below the header) can read the same real counts instead of
  // running a second query for them.
  useEffect(() => {
    useHeaderCounts.getState().set(counts);
  }, [counts.toShip, counts.shipped, counts.cancelledRto]);

  return (
    <header
      className="no-print sticky top-0 z-40"
      style={{ background: "var(--panel)", borderBottom: "1px solid var(--border)" }}
    >
      {/* ---------------------------------------------------------- band 1 -- */}
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:gap-5 sm:px-6">
        {/* Desktop: the PariBelle wordmark (same face and colours as the
            storefront navbar), and the Dashboard/Orders switch sits beside it. Below `sm` there's no room for both a switch and a
            usable search box, so the switch collapses into the brand mark
            itself — same corner square, hamburger glyph instead of "P",
            opening the same dropdown the Orders breadcrumb uses. */}
        <Link
          href="/orders"
          className="hidden shrink-0 text-[26px] leading-none tracking-wide transition-colors hover:text-[#c0607a] sm:block"
          style={{ fontFamily: "var(--font-logo)", color: "#3a2a30" }}
        >
          PariBelle
        </Link>
        {/* On the PDF printer there is no search to make room for, so mobile
            gets the same toggle as desktop instead of the hamburger. */}
        <div className="sm:hidden">
          {effectiveScreen === "pdf-printer" ? (
            <AppSwitch effectiveScreen={effectiveScreen} routeScreen={screenFromPath(pathname)} hidePrinter />
          ) : (
            <MobileScreenMenu effectiveScreen={effectiveScreen} routeScreen={screenFromPath(pathname)} />
          )}
        </div>

        <div className="hidden sm:block">
          <AppSwitch effectiveScreen={effectiveScreen} routeScreen={screenFromPath(pathname)} />
        </div>

        <div className="hidden flex-1 sm:block" />

        {/* Band 2's own search only ever shows from `md` up (see `OrdersTabs`)
            — mobile has no search at all otherwise, so it gets this stand-in
            here, right before Sync/avatar, filling the width the switch
            would otherwise take. Gone again from `md` so the two never both
            show at once. */}
        {onOrders ? (
          <div className="flex-1 md:hidden">
            <HeaderSearch compact />
          </div>
        ) : (
          <div className="flex-1 sm:hidden" />
        )}

        <SyncStatus lastSyncAt={lastSyncAt} />

        {primaryAccountId !== null ? (
          <SyncNowButton
            accountId={primaryAccountId}
            onSyncNow={onSyncNow}
            onAutoSync={onAutoSync}
          />
        ) : null}

        <AvatarMenu userName={userName} onSignOut={onSignOut} />
      </div>

      {/* ---------------------------------------------------------- band 2 -- */}

      {/* ---------------------------------------------------------- band 3 -- */}
      {/* Empty slot the Orders sub-status tabs (`RailTabs`) portal into, so they
          sit inside the header: attached to band 2, full width, same look. */}
      {onOrders ? <div id={RAIL_SLOT_ID} /> : null}
    </header>
  );
}

/* -------------------------------------------------------------------------- */
/* Band 1 — Dashboard / Orders switch                                         */
/* -------------------------------------------------------------------------- */

/** `/dashboard` for the default range, `?range=` otherwise, matching page.tsx. */
function dashboardHref(): string {
  const { range } = useDashboardNav.getState();
  return range === "30d" ? "/dashboard" : `/dashboard?range=${range}`;
}

function ordersHref(): string {
  return `/orders${paramsToQuery(useOrdersNav.getState().params)}`;
}

function hrefFor(screen: Screen): string {
  if (screen === "orders") return ordersHref();
  if (screen === "pdf-printer") return "/pdf-printer";
  return dashboardHref();
}

function targetIsCached(screen: Screen): boolean {
  // Nothing to fetch for the printer: its state is client-side.
  if (screen === "pdf-printer") return true;
  if (screen === "orders") {
    return (
      useOrdersCache.getState().peek(ordersViewKey(useOrdersNav.getState().params)) !== null
    );
  }
  return useDashboardCache.getState().peek(useDashboardNav.getState().range) !== null;
}

/**
 * Mobile's stand-in for `AppSwitch` — the brand mark itself becomes the
 * trigger (hamburger glyph instead of "P"), opening the same `DropdownMenu`
 * the Orders breadcrumb uses instead of a permanent segmented pill, since
 * band 1 has no room for both that and a usable search box on a phone.
 */
function MobileScreenMenu({
  effectiveScreen,
  routeScreen,
}: {
  effectiveScreen: Screen | null;
  routeScreen: Screen | null;
}) {
  const router = useRouter();

  function select(screen: Screen) {
    if (screen === effectiveScreen) return;
    // App-relative. Raw pushState needs the basePath added by hand, but
    // router.push adds it itself, so it is given this unprefixed form.
    const href = hrefFor(screen);

    if (screen === routeScreen) {
      useScreenNav.getState().setOverride(null);
      window.history.pushState(null, "", withBasePath(href));
      return;
    }
    if (targetIsCached(screen)) {
      window.history.pushState(null, "", withBasePath(href));
      useScreenNav.getState().setOverride(screen);
      return;
    }
    useScreenNav.getState().setOverride(null);
    router.push(href);
  }

  return (
    <DropdownMenu
      trigger={
        <span
          className="flex h-7 w-7 items-center justify-center rounded-lg text-white"
          style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
          aria-hidden
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </span>
      }
      options={[
        { id: "dashboard", label: "Dashboard" },
        { id: "orders", label: "Orders" },
      ]}
      activeId={effectiveScreen ?? "orders"}
      onSelect={(id) => select(id as Screen)}
    />
  );
}

function AppSwitch({
  effectiveScreen,
  routeScreen,
  hidePrinter = false,
}: {
  effectiveScreen: Screen | null;
  routeScreen: Screen | null;
  /** Mobile reaches the printer from the Orders bottom bar, not from here. */
  hidePrinter?: boolean;
}) {
  const items: { screen: Screen; label: string }[] = [
    { screen: "dashboard", label: "Dashboard" },
    { screen: "orders", label: "Orders" },
    ...(hidePrinter ? [] : [{ screen: "pdf-printer" as Screen, label: "PDF printer" }]),
  ];

  function onNav(e: React.MouseEvent, screen: Screen) {
    if (screen === effectiveScreen) return;

    // App-relative. Raw pushState needs the basePath added by hand, but
    // router.push adds it itself, so it is given this unprefixed form.
    const href = hrefFor(screen);

    // Back to the screen the server actually rendered: just drop the override
    // and put the URL back. No navigation, nothing to fetch.
    if (screen === routeScreen) {
      e.preventDefault();
      useScreenNav.getState().setOverride(null);
      window.history.pushState(null, "", withBasePath(href));
      return;
    }

    // The other screen, and its cache can answer: swap it in place. On a miss
    // the click falls through to the <Link> and Next navigates for real.
    if (targetIsCached(screen)) {
      e.preventDefault();
      window.history.pushState(null, "", withBasePath(href));
      useScreenNav.getState().setOverride(screen);
      return;
    }
    // Uncached: Next navigates for real. Any earlier in-place swap has to go
    // now, or it keeps painting over the page being navigated to.
    useScreenNav.getState().setOverride(null);
  }

  return (
    <div
      className="inline-flex rounded-[9px] p-[3px]"
      style={{ background: "var(--panel-2)", border: "1px solid var(--border)" }}
    >
      {items.map((item) => {
        const active = effectiveScreen === item.screen;
        return (
          <Link
            key={item.screen}
            href={screenHref(item.screen)}
            onClick={(e) => onNav(e, item.screen)}
            className={cn(
              "rounded-[7px] px-3.5 py-1.5 text-[13px] font-medium transition-colors",
              !active && "muted hover:text-[var(--text)]",
            )}
            style={
              active
                ? {
                    background: "var(--panel)",
                    color: "var(--text)",
                    fontWeight: 600,
                    boxShadow: "var(--shadow-xs)",
                  }
                : undefined
            }
          >
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Band 1 — sync status text                                                  */
/* -------------------------------------------------------------------------- */

function SyncStatus({ lastSyncAt }: { lastSyncAt: string | null }) {
  // Rendered only after mount: the relative time would otherwise differ
  // between the server render and the client and trip a hydration warning.
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    function compute() {
      if (!lastSyncAt) {
        setLabel("Not synced yet");
        return;
      }
      const last = new Date(lastSyncAt).getTime();
      const agoMin = Math.max(0, Math.round((Date.now() - last) / 60_000));
      const ago =
        agoMin < 1 ? "just now" : agoMin < 60 ? `${agoMin} min ago` : `${Math.round(agoMin / 60)}h ago`;
      // Sync is manual only (no cron) — report the last sync, never promise a next one.
      setLabel(`Synced ${ago}`);
    }
    compute();
    const id = setInterval(compute, 30_000);
    return () => clearInterval(id);
  }, [lastSyncAt]);

  if (!label) return null;

  const stalled = label === "Not synced yet";
  return (
    <span className="hidden items-center gap-2 text-xs md:inline-flex" style={{ color: "var(--muted)" }}>
      <span
        className="h-[7px] w-[7px] rounded-full"
        style={{
          background: stalled ? "var(--muted-2)" : "var(--ok)",
          boxShadow: stalled ? undefined : "0 0 0 3px var(--ok-soft)",
        }}
        aria-hidden
      />
      {label}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Band 1 — Sync now                                                          */
/* -------------------------------------------------------------------------- */

const POLL_MS = 800;

function SyncNowButton({
  accountId,
  onSyncNow,
  onAutoSync,
}: {
  accountId: number;
  onSyncNow: (accountId: number) => Promise<SyncResult>;
  /** Fires once on open; the server decides whether it is actually due. */
  onAutoSync: (accountId: number) => Promise<AutoSyncResult>;
}) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "syncing" | "error">("idle");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    [],
  );

  /**
   * Opening the app is what triggers a sync now that there is no cron.
   *
   * Whether one is actually due is decided on the server, not here: a browser
   * flag would let two tabs, two people or a reload each believe they were
   * first. This just asks, and starts watching if the answer is yes.
   *
   * The guard is for React running effects twice in development, not for
   * concurrency, which the server handles.
   */
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;

    let cancelled = false;
    void onAutoSync(accountId).then((res) => {
      // Deliberately not gated on `res.ok`: a run someone else started needs
      // watching just as much as one we started, otherwise it lands without
      // anything telling the cache to drop its pre-sync orders.
      if (cancelled || !res.runId) return;
      setState("syncing");
      watch(res.runId);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  async function start() {
    setState("syncing");
    const res = await onSyncNow(accountId);

    if (!res.ok || !res.runId) {
      setState("error");
      setTimeout(() => setState("idle"), 2500);
      return;
    }

    watch(res.runId);
  }

  function watch(runId: number) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const r = await fetch(withBasePath(`/api/sync-progress?runId=${runId}`));
      if (!r.ok) return;
      const data = (await r.json()) as { status: "running" | "ok" | "failed" };
      if (data.status !== "running") {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        setState(data.status === "failed" ? "error" : "idle");
        // A sync rewrites orders wholesale, so nothing cached survives it.
        // This is the half of the caching contract that keeps the queue honest:
        // without it, a tab held in memory would go on showing pre-sync data.
        useOrdersCache.getState().bumpSync();
        router.refresh();
        if (data.status === "failed") setTimeout(() => setState("idle"), 2500);
      }
    }, POLL_MS);
  }

  return (
    <button
      onClick={start}
      disabled={state === "syncing"}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-[10px] px-3 py-2 text-[12.5px] font-medium text-white transition-[filter] hover:brightness-105 disabled:opacity-70"
      style={{
        background:
          state === "error"
            ? "var(--danger)"
            : "linear-gradient(135deg, var(--accent), var(--accent-2))",
      }}
    >
      <RefreshCw className={cn("h-3.5 w-3.5", state === "syncing" && "animate-spin")} />
      <span className="hidden sm:inline">
        {state === "syncing" ? "Syncing…" : state === "error" ? "Sync failed" : "Sync now"}
      </span>
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Band 1 — avatar menu                                                       */
/* -------------------------------------------------------------------------- */

function AvatarMenu({
  userName,
  onSignOut,
}: {
  userName: string;
  onSignOut: () => Promise<void>;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const initial = userName.trim().charAt(0).toUpperCase() || "U";

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold text-white transition-transform hover:scale-105"
        style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
      >
        {initial}
      </button>

      {open ? (
        <div
          role="menu"
          className="panel absolute right-0 top-full z-20 mt-2 w-56 origin-top-right p-1.5"
          style={{ animation: "rise-in 0.15s var(--ease-premium)" }}
        >
          <p className="truncate px-3 py-2 text-xs" style={{ color: "var(--muted)" }}>
            Signed in as{" "}
            <span className="font-medium" style={{ color: "var(--text)" }}>
              {userName}
            </span>
          </p>
          <Link
            href="/settings"
            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-[var(--accent-soft)]"
          >
            <SettingsIcon className="h-4 w-4" style={{ color: "var(--muted)" }} />
            Settings
          </Link>
          <Link
            href="/change-password"
            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-[var(--accent-soft)]"
          >
            <KeyRound className="h-4 w-4" style={{ color: "var(--muted)" }} />
            Change password
          </Link>
          <form action={onSignOut}>
            <button
              type="submit"
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--danger-soft)]"
              style={{ color: "var(--danger)" }}
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Band 2 — Orders status tabs                                                */
/* -------------------------------------------------------------------------- */

export type TabKey = "toShip" | "shipped" | "delivered" | "cancellations" | "all";

export const ORDER_TABS: { key: TabKey; label: string; params: OrdersViewParams }[] = [
  { key: "toShip", label: "To Ship", params: {} },
  { key: "shipped", label: "Shipped", params: { status: "shipped" } },
  { key: "delivered", label: "Delivered", params: { status: "delivered" } },
  { key: "cancellations", label: "Cancelled & RTO", params: { view: "cancellations" } },
  { key: "all", label: "All orders", params: { status: "all" } },
];

/**
 * The single source of truth for "which of the 5 category tabs is active" and
 * "how to switch to another one" — shared by the desktop tab band below and
 * the mobile category dropdown (`MobileOrdersCrumb`), so the two can never
 * disagree about what's showing, same as `RailTabs` already does for the
 * sub-status rail.
 *
 * A `status` outside {shipped, delivered, all} but still a real `OrderStatus`
 * (e.g. `cancelled`, reached by drilling into a tile from All orders'
 * Collection view) is a sub-state of "All orders", not a tab of its own —
 * there is no 6th tab for it.
 */
export function useOrderTabs() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const go = useOrdersNav((s) => s.go);
  const status = params.get("status");
  const view = params.get("view");

  // On /orders the tabs switch in place so the client cache can answer; from
  // anywhere else there is no workspace mounted yet, so it has to navigate.
  function select(next: OrdersViewParams) {
    if (pathname === "/orders") go({ ...next, q: params.get("q") ?? undefined });
    else router.push(`/orders${paramsToQuery(next)}`);
  }

  let activeKey: TabKey = "toShip";
  if (view === "cancellations") activeKey = "cancellations";
  else if (status === "all") activeKey = "all";
  else if (status === "shipped") activeKey = "shipped";
  else if (status === "delivered") activeKey = "delivered";
  else if (status === "cancellations") activeKey = "cancellations";
  else if (status && status in STATUS_LABELS) activeKey = "all";

  return { activeKey, select, tabs: ORDER_TABS };
}

/**
 * The order search box — band 2's own version (desktop, `md` up) and band 1's
 * compact mobile stand-in (`compact`) both render this, so search keeps
 * behaving identically (same `q` param, same "keep whatever tab you're on")
 * everywhere it appears.
 */
export function HeaderSearch({ compact }: { compact?: boolean }) {
  const params = useSearchParams();

  function onSearch(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const value = String(new FormData(e.currentTarget).get("q") ?? "").trim();
    useOrdersNav.getState().go({ ...queryToParams(params.toString()), q: value || undefined });
  }

  return (
    <form onSubmit={onSearch}>
      <div
        className={cn(
          "search-box",
          // Fills its flex-1 wrapper for the compact mobile version.
          compact ? "w-full" : "w-56",
        )}
      >
        <label htmlFor="header-search" className="search-label">
          <svg viewBox="0 0 24 24" className="search-icon" fill="none" strokeWidth="2.5" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
        </label>
        <input
          id="header-search"
          size={1}
          key={params.get("q") ?? ""}
          name="q"
          defaultValue={params.get("q") ?? ""}
          placeholder="Search order ID, buyer, pincode, SKU…"
          className="search-input"
        />
        <span className="search-divider" aria-hidden />
        {/* Voice search is not wired up yet. */}
        <button type="button" className="search-mic" aria-label="Voice search">
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M12 15a4 4 0 0 0 4-4V6a4 4 0 0 0-8 0v5a4 4 0 0 0 4 4Zm6-4a1 1 0 1 1 2 0 8 8 0 0 1-7 7.94V21h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3v-2.06A8 8 0 0 1 4 11a1 1 0 1 1 2 0 6 6 0 0 0 12 0Z" />
          </svg>
        </button>
      </div>
    </form>
  );
}
