"use client";

import { KeyRound, LogOut, RefreshCw, Settings as SettingsIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

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
}) {
  const pathname = usePathname();
  const onOrders = pathname === "/orders" || pathname.startsWith("/orders/");

  return (
    <header
      className="no-print sticky top-0 z-40"
      style={{ background: "var(--panel)", borderBottom: "1px solid var(--border)" }}
    >
      {/* ---------------------------------------------------------- band 1 -- */}
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:gap-5 sm:px-6">
        <Link href="/orders" className="flex shrink-0 items-center gap-2.5">
          <span
            className="flex h-7 w-7 items-center justify-center rounded-lg text-xs font-bold text-white"
            style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
            aria-hidden
          >
            P
          </span>
          <span className="hidden text-sm font-semibold tracking-tight sm:inline">Paribelle</span>
        </Link>

        <AppSwitch pathname={pathname} />

        <div className="flex-1" />

        <SyncStatus lastSyncAt={lastSyncAt} />

        {primaryAccountId !== null ? (
          <SyncNowButton accountId={primaryAccountId} onSyncNow={onSyncNow} />
        ) : null}

        <AvatarMenu userName={userName} onSignOut={onSignOut} />
      </div>

      {/* ---------------------------------------------------------- band 2 -- */}
      {onOrders ? <OrdersTabs counts={counts} /> : null}
    </header>
  );
}

/* -------------------------------------------------------------------------- */
/* Band 1 — Dashboard / Orders switch                                         */
/* -------------------------------------------------------------------------- */

function AppSwitch({ pathname }: { pathname: string }) {
  const items = [
    { href: "/dashboard", label: "Dashboard" },
    { href: "/orders", label: "Orders" },
  ];
  return (
    <div
      className="inline-flex rounded-[9px] p-[3px]"
      style={{ background: "var(--panel-2)", border: "1px solid var(--border)" }}
    >
      {items.map((item) => {
        const active =
          pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
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
}: {
  accountId: number;
  onSyncNow: (accountId: number) => Promise<SyncResult>;
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

  async function start() {
    setState("syncing");
    const res = await onSyncNow(accountId);

    if (!res.ok || !res.runId) {
      setState("error");
      setTimeout(() => setState("idle"), 2500);
      return;
    }

    pollRef.current = setInterval(async () => {
      const r = await fetch(`/api/sync-progress?runId=${res.runId}`);
      if (!r.ok) return;
      const data = (await r.json()) as { status: "running" | "ok" | "failed" };
      if (data.status !== "running") {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        setState(data.status === "failed" ? "error" : "idle");
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

type TabKey = "toShip" | "shipped" | "delivered" | "cancellations" | "all";

const ORDER_TABS: { key: TabKey; label: string; query: string }[] = [
  { key: "toShip", label: "To Ship", query: "" },
  { key: "shipped", label: "Shipped", query: "?status=shipped" },
  { key: "delivered", label: "Delivered", query: "?status=delivered" },
  { key: "cancellations", label: "Cancelled & RTO", query: "?view=cancellations" },
  { key: "all", label: "All orders", query: "?status=all" },
];

function OrdersTabs({ counts }: { counts: HeaderCounts }) {
  const params = useSearchParams();
  const router = useRouter();
  const status = params.get("status");
  const view = params.get("view");

  let activeKey: TabKey = "toShip";
  if (view === "cancellations") activeKey = "cancellations";
  else if (status === "all") activeKey = "all";
  else if (status === "shipped") activeKey = "shipped";
  else if (status === "delivered") activeKey = "delivered";

  const badgeFor: Partial<Record<TabKey, number>> = {
    toShip: counts.toShip,
    shipped: counts.shipped,
    cancellations: counts.cancelledRto,
  };

  // Search keeps the tab you are on; it only sets/clears `q`.
  function onSearch(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const value = String(new FormData(e.currentTarget).get("q") ?? "").trim();
    const next = new URLSearchParams(params.toString());
    if (value) next.set("q", value);
    else next.delete("q");
    router.push(`/orders${next.toString() ? `?${next}` : ""}`);
  }

  return (
    <div
      className="mx-auto flex max-w-7xl items-center gap-6 px-4 sm:px-6"
      style={{ borderTop: "1px solid var(--border)" }}
    >
      {ORDER_TABS.map((tab) => {
        const active = tab.key === activeKey;
        const badge = badgeFor[tab.key];
        return (
          <Link
            key={tab.key}
            href={`/orders${tab.query}`}
            className={cn(
              "inline-flex items-center gap-2 whitespace-nowrap border-b-2 py-3 text-[13.5px] font-medium transition-colors",
              !active && "muted hover:text-[var(--text)]",
            )}
            style={{
              borderColor: active ? "var(--accent)" : "transparent",
              color: active ? "var(--text)" : undefined,
              fontWeight: active ? 600 : 500,
            }}
          >
            {tab.label}
            {badge ? (
              <span
                className="rounded-full px-1.5 py-px text-[10.5px] font-semibold tabular-nums"
                style={{
                  background: active ? "var(--accent-soft)" : "var(--panel-2)",
                  color: active ? "#0b7fb0" : "var(--muted)",
                }}
              >
                {badge}
              </span>
            ) : null}
          </Link>
        );
      })}

      <div className="flex-1" />

      <form onSubmit={onSearch} className="hidden py-2 md:block">
        <div className="relative">
          <svg
            viewBox="0 0 24 24"
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
            fill="none"
            stroke="var(--muted-2)"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            key={params.get("q") ?? ""}
            name="q"
            defaultValue={params.get("q") ?? ""}
            placeholder="Search order ID, buyer, pincode…"
            className="w-56 rounded-lg py-1.5 pl-8 pr-3 text-[12.5px] outline-none transition-colors focus:w-72"
            style={{ background: "var(--panel-2)", border: "1px solid var(--border)", color: "var(--text)" }}
          />
        </div>
      </form>
    </div>
  );
}
