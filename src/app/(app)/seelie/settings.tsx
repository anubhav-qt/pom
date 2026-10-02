"use client";

import { ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Modal } from "@/components/modal";
import { Toggle } from "@/components/toggle";
import { CenteredSpinner, Spinner } from "@/components/ui";
import type { AccountLimits, LimitWindow } from "@/lib/seelie/limits";
import type { MetaStatus } from "@/lib/seelie/meta";
import type { StoreStatus } from "@/lib/seelie/store";
import type { ImageBudget } from "@/lib/seelie/studio/budget";
import { useSeelie } from "@/lib/stores/seelie-store";

import {
  accountEnabledAction,
  cancelLoginAction,
  finishLoginAction,
  imageBudgetAction,
  loginStatusAction,
  metaChooseAction,
  metaConnectAction,
  metaDisconnectAction,
  metaMonthAction,
  metaRefreshAction,
  metaStatusAction,
  type MetaMonth,
  removeAccountAction,
  startLoginAction,
  storeSignInAction,
  storeSignOutAction,
  storeStatusAction,
} from "./actions";
import { Notice } from "./timeline";

/** The accounts CLIProxyAPI can log in (LOGIN_PROVIDERS on the server). */
const PROVIDERS = [
  { id: "antigravity", label: "Google Antigravity" },
  { id: "codex", label: "ChatGPT (Codex)" },
  { id: "claude", label: "Claude" },
];

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const owner = useSeelie((s) => s.status?.me.owner ?? false);
  const online = useSeelie((s) => s.status?.online ?? false);
  const showThinking = useSeelie((s) => s.showThinking);

  return (
    <Modal title="Seelie settings" onClose={onClose} width="40rem">
      <div className="space-y-6">
        <Toggle
          checked={showThinking}
          onChange={(v) => useSeelie.getState().setShowThinking(v)}
          label="Show Seelie's thinking"
          hint="The reasoning before each reply, folded under it."
        />
        {online ? <Accounts owner={owner} /> : null}
        {online ? <ImageGeneration /> : null}
        {owner ? <Store /> : null}
        {owner ? <Meta /> : null}
      </div>
    </Modal>
  );
}

function Heading({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center justify-between gap-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
        {children}
      </h3>
      {action}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Model accounts and their limits                                            */
/* -------------------------------------------------------------------------- */

function Accounts({ owner }: { owner: boolean }) {
  const limits = useSeelie((s) => s.limits);
  const error = useSeelie((s) => s.limitsError);
  const [refreshing, setRefreshing] = useState(false);

  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([useSeelie.getState().loadLimits(true), useSeelie.getState().loadStatus(true)]);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void useSeelie.getState().loadLimits();
  }, []);

  return (
    <section>
      <Heading
        action={
          <button type="button" className="btn px-2 py-1 text-xs" onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </button>
        }
      >
        Model accounts
      </Heading>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {!limits && !error ? <CenteredSpinner className="py-6" /> : null}
      {limits && !limits.length ? <p className="muted text-sm">No accounts connected yet.</p> : null}
      <div className="space-y-2.5">
        {limits?.map((a) => <Account key={a.name} account={a} owner={owner} onChanged={refresh} />)}
      </div>
      {owner ? <Connect onDone={refresh} /> : null}
    </section>
  );
}

function resetIn(at: string | null) {
  if (!at) return null;
  const ms = new Date(at).getTime() - Date.now();
  if (ms <= 0) return "resets now";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  if (h >= 24) return `resets in ${Math.floor(h / 24)}d ${h % 24}h`;
  return h ? `resets in ${h}h ${m}m` : `resets in ${m}m`;
}

function Bar({ w, detail }: { w: LimitWindow; detail?: string }) {
  const pct = Math.round(w.used * 100);
  const color = w.used > 0.85 ? "var(--danger)" : w.used > 0.6 ? "var(--warn)" : "var(--accent)";
  return (
    <div>
      {/* The detail drops under the label when a phone has no room for both. */}
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-xs">
        <span className="min-w-0 truncate">
          <span className="font-medium">{w.label}</span>
          {w.scope ? <span className="muted"> · {w.scope}</span> : null}
        </span>
        <span className="muted shrink-0 tabular-nums">
          {detail ?? `${pct}% used`}
          {resetIn(w.resetAt) ? ` · ${resetIn(w.resetAt)}` : ""}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full" style={{ background: "var(--panel)" }}>
        <div className="h-full rounded-full transition-[width]" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function Account({ account: a, owner, onChanged }: { account: AccountLimits; owner: boolean; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(true);
    setError(null);
    const res = await fn();
    if (!res.ok) setError(res.error ?? "That didn't work.");
    await onChanged();
    setBusy(false);
    setConfirm(false);
  }

  const tone = a.status === "active" ? "var(--ok)" : a.status === "disabled" ? "var(--muted-2)" : "var(--warn)";
  return (
    <div className="surface-2 space-y-2.5 p-3.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tone }} title={a.status} />
        <span className="text-sm font-medium">{a.providerName}</span>
        {a.plan ? (
          <span className="rounded-full px-2 py-px text-[11px] font-medium" style={{ background: "var(--accent-soft)", color: "var(--accent-ink)" }}>
            {a.plan}
          </span>
        ) : null}
        <span className="muted min-w-0 flex-1 truncate text-xs">{a.email}</span>
        {owner ? (
          <div className="flex shrink-0 items-center gap-1">
            {busy ? <Spinner size="1rem" /> : null}
            <button
              type="button"
              className="btn px-2 py-1 text-xs"
              disabled={busy}
              onClick={() => void run(() => accountEnabledAction(a.name, a.status === "disabled"))}
            >
              {a.status === "disabled" ? "Turn on" : "Turn off"}
            </button>
            <button
              type="button"
              className="btn px-2 py-1 text-xs"
              style={{ color: "var(--danger)" }}
              disabled={busy}
              onClick={() => (confirm ? void run(() => removeAccountAction(a.name)) : setConfirm(true))}
              onBlur={() => setConfirm(false)}
            >
              {confirm ? "Remove for good?" : "Remove"}
            </button>
          </div>
        ) : null}
      </div>
      {a.statusMessage && a.status !== "active" ? <p className="text-xs" style={{ color: "var(--warn)" }}>{a.statusMessage}</p> : null}
      {a.windows.map((w) => (
        <Bar key={w.id} w={w} />
      ))}
      {a.error ? <p className="muted text-xs">{a.error}</p> : null}
      {error ? <p className="text-xs" style={{ color: "var(--danger)" }}>{error}</p> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Image generation: the photoshoot budget from Seelie's own ledger            */
/* -------------------------------------------------------------------------- */

function ImageGeneration() {
  // Reloads with the accounts (their Refresh button, an account turned on or off).
  const limits = useSeelie((s) => s.limits);
  const [budget, setBudget] = useState<ImageBudget | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void imageBudgetAction().then((res) => {
      if (!live) return;
      if (res.ok) {
        setBudget(res.data);
        setError(null);
      } else setError(res.error);
    });
    return () => {
      live = false;
    };
  }, [limits]);

  const b = budget;
  return (
    <section>
      <Heading>Image generation</Heading>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {!b && !error ? <CenteredSpinner className="py-6" /> : null}
      {b ? (
        <div className="surface-2 space-y-2 p-3.5">
          <Bar
            w={{
              id: "images",
              label: "Photoshoots",
              scope: `~${b.capacity} images per 5 hours${b.accounts > 1 ? ` across ${b.accounts} accounts` : ""}`,
              used: b.blockedUntil ? 1 : b.capacity ? Math.min(1, b.used / b.capacity) : 0,
              resetAt: b.resetAt,
            }}
            detail={b.blockedUntil ? "used up" : `about ${b.left} of ~${b.capacity} left`}
          />
          {b.waiting ? (
            <p className="muted text-xs">
              {b.waiting === 1 ? "1 look is" : `${b.waiting} looks are`} waiting in a shoot. Tell Seelie to continue in that chat once
              the images are back.
            </p>
          ) : null}
          <p className="muted text-xs">
            Google doesn&apos;t show this limit, so Seelie counts every image it makes and learns where the limit falls. Only
            photoshoots use it; editing photos is free.
          </p>
        </div>
      ) : null}
    </section>
  );
}

/** Logs a new account in: CLIProxyAPI's sign-in page in a new tab, then waits for it to land. */
function Connect({ onDone }: { onDone: () => Promise<void> }) {
  const [login, setLogin] = useState<{ provider: string; state: string; url: string } | null>(null);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const live = useRef(true);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // Poll until the login lands by itself (on the ThinkPad) or through the pasted address.
  useEffect(() => {
    if (!login) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      const res = await loginStatusAction(login.state);
      if (stop || !live.current) return;
      if (!res.ok) {
        setError(res.error);
        return;
      }
      if (res.data.status === "ok") {
        setDone(PROVIDERS.find((p) => p.id === login.provider)?.label ?? login.provider);
        setLogin(null);
        setPasted("");
        await onDoneRef.current();
        return;
      }
      if (res.data.status === "error") {
        setError(res.data.error);
        setLogin(null);
        return;
      }
      setTimeout(tick, 2000);
    };
    const first = setTimeout(tick, 2000);
    return () => {
      stop = true;
      clearTimeout(first);
    };
  }, [login]);

  async function start(provider: string) {
    setBusy(provider);
    setError(null);
    setDone(null);
    // Opened before the await, so the browser counts it as the click's own window.
    const tab = window.open("about:blank", "_blank");
    const res = await startLoginAction(provider);
    setBusy(null);
    if (!res.ok) {
      tab?.close();
      setError(res.error);
      return;
    }
    if (tab) tab.location.href = res.data.url;
    setLogin({ provider, state: res.data.state, url: res.data.url });
  }

  async function finish() {
    if (!login || !pasted.trim()) return;
    setBusy("finish");
    setError(null);
    const res = await finishLoginAction(login.provider, pasted);
    setBusy(null);
    if (!res.ok) setError(res.error);
  }

  async function cancel() {
    if (login) await cancelLoginAction(login.state);
    setLogin(null);
    setPasted("");
  }

  return (
    <div className="mt-4 space-y-2.5">
      <p className="text-sm font-medium">Connect an account</p>
      {login ? (
        <div className="surface-2 space-y-2.5 p-3.5 text-sm">
          <p>
            Sign in on the tab that opened.{" "}
            <a href={login.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium underline" style={{ color: "var(--accent-ink)" }}>
              Open it again <ExternalLink className="h-3 w-3" />
            </a>
          </p>
          <p className="muted text-xs">
            On the ThinkPad it finishes by itself. Anywhere else the last page won&apos;t load: copy its address from the address bar and paste it here.
          </p>
          <div className="flex gap-2">
            <input className="input text-base sm:text-sm" placeholder="http://localhost:…" value={pasted} onChange={(e) => setPasted(e.target.value)} />
            <button type="button" className="btn btn-primary shrink-0" disabled={!pasted.trim() || busy === "finish"} onClick={() => void finish()}>
              {busy === "finish" ? <Spinner size="1rem" color="currentColor" /> : "Finish"}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <Spinner size="0.9rem" />
            <span className="muted flex-1 text-xs">Waiting for the sign-in…</span>
            <button type="button" className="btn px-2 py-1 text-xs" onClick={() => void cancel()}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {PROVIDERS.map((p) => (
            <button key={p.id} type="button" className="btn btn-white text-[13px]" disabled={busy !== null} onClick={() => void start(p.id)}>
              {busy === p.id ? <Spinner size="1rem" /> : null}
              {p.label}
            </button>
          ))}
        </div>
      )}
      {done ? <p className="text-xs" style={{ color: "var(--ok)" }}>{done} is connected.</p> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* paribelle.in                                                               */
/* -------------------------------------------------------------------------- */

function Store() {
  const [status, setStatus] = useState<StoreStatus | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void storeStatusAction().then((res) => (res.ok ? setStatus(res.data) : setError(res.error)));
  }, []);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await storeSignInAction(email.trim(), password);
    setBusy(false);
    setPassword("");
    if (res.ok) setStatus(res.data);
    else setError(res.error);
  }

  async function signOut() {
    setBusy(true);
    setError(null);
    const res = await storeSignOutAction();
    setBusy(false);
    if (res.ok) setStatus(res.data);
    else setError(res.error);
  }

  return (
    <section>
      <Heading>paribelle.in</Heading>
      {!status && !error ? <CenteredSpinner className="py-6" /> : null}
      {status && !status.configured ? (
        <p className="muted text-sm">PARIBELLE_API_URL isn&apos;t set on this server, so Seelie can&apos;t reach the store from here.</p>
      ) : null}
      {status?.configured && status.signedIn ? (
        <div className="surface-2 flex flex-wrap items-center gap-3 p-3.5">
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-medium">Signed in as {status.name ?? status.email}</p>
            <p className="muted text-xs">
              {status.email}
              {status.role ? ` · ${status.role}` : ""}
              {status.savedAt ? ` · since ${new Date(status.savedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}` : ""}
            </p>
          </div>
          <button type="button" className="btn btn-white text-[13px]" disabled={busy} onClick={() => void signOut()}>
            {busy ? <Spinner size="1rem" /> : null}
            Sign out
          </button>
        </div>
      ) : null}
      {status?.configured && !status.signedIn ? (
        <form onSubmit={signIn} className="space-y-2.5">
          {status.needsSignIn ? <Notice tone="warn">The saved sign-in stopped working. Sign in again.</Notice> : null}
          <p className="muted text-xs">
            Sign Seelie in once with your paribelle.in admin login. It is kept encrypted on this server and used again by itself. Every change to the store still asks you first.
          </p>
          <input className="input text-base sm:text-sm" type="email" autoComplete="username" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <input
            className="input text-base sm:text-sm"
            type="password"
            autoComplete="current-password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <button type="submit" className="btn btn-primary" disabled={busy || !email.trim() || !password}>
            {busy ? <Spinner size="1rem" color="currentColor" /> : "Sign in"}
          </button>
        </form>
      ) : null}
      {error ? <div className="mt-2"><Notice tone="danger">{error}</Notice></div> : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Meta: Instagram and ads                                                    */
/* -------------------------------------------------------------------------- */

const META_STEPS = [
  "In Meta Business Settings (business.facebook.com/settings), add the Paribelle Page and its Instagram account to the business.",
  "Create an app at developers.facebook.com (type Business, with the Marketing API and Instagram products) and add it to the business.",
  "Business Settings → Users → System users: add a system user (Employee is enough) and assign it the Page, the Instagram account, the ad account and the app, with full control.",
  "In the app's Settings → Basic, add a privacy policy URL Meta can read (it fetches the page without running scripts), then switch the app to Live: Meta refuses photo and video ads built by an app in development.",
  "Generate token on the system user for that app, expiry Never, with:business_management, pages_show_list, pages_read_engagement, instagram_basic, instagram_content_publish, instagram_manage_insights, ads_management, ads_read.",
];

const formatMoney = (n: number, currency: string) => {
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${Math.round(n)} ${currency}`;
  }
};

type MetaResult = { ok: true; data: MetaStatus } | { ok: false; error: string };

/** The prepaid balance, with the link to add money (only the owner can: Meta has no API for it). */
function PrepaidLine({ prepaid, currency }: { prepaid: NonNullable<MetaMonth["prepaid"]>; currency: string }) {
  const link = (
    <a className="inline-flex items-center gap-1 font-medium hover:underline" href={prepaid.topUp} target="_blank" rel="noreferrer">
      Add funds <ExternalLink className="h-3 w-3" />
    </a>
  );
  const text = prepaid.balance === null ? "Prepaid funds: Meta didn't say how much is left." : `Prepaid balance: ${formatMoney(prepaid.balance, currency)}.`;
  if (prepaid.low) {
    return (
      <Notice tone="warn">
        {text} That&apos;s low: ads stop when it runs out, and only you can add money. {link}
      </Notice>
    );
  }
  return (
    <p className="muted flex flex-wrap items-center gap-x-2 text-xs tabular-nums">
      {text} {link}
    </p>
  );
}

function Meta() {
  const [status, setStatus] = useState<MetaStatus | null>(null);
  const [month, setMonth] = useState<MetaMonth | null>(null);
  const [token, setToken] = useState("");
  const [cap, setCap] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function show(next: MetaStatus) {
    setStatus(next);
    setCap(next.monthlyCap === null ? "" : String(next.monthlyCap));
    if (next.connected && next.adAccount) void metaMonthAction().then((res) => setMonth(res.ok ? res.data : null));
    else setMonth(null);
  }

  useEffect(() => {
    void metaStatusAction().then((res) => (res.ok ? show(res.data) : setError(res.error)));
  }, []);

  async function run(what: string, action: () => Promise<MetaResult>) {
    setBusy(what);
    setError(null);
    const res = await action();
    setBusy(null);
    if (res.ok) show(res.data);
    else setError(res.error);
    return res.ok;
  }

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    if (await run("connect", () => metaConnectAction(token))) setToken("");
  }

  const currency = status?.adAccount?.currency ?? "INR";
  const capValue = cap.trim() === "" ? null : Number(cap);
  const capValid = capValue === null || (Number.isFinite(capValue) && capValue >= 0);
  const capChanged = !!status && capValue !== status.monthlyCap;

  return (
    <section>
      <Heading
        action={
          status?.connected ? (
            <button
              type="button"
              className="nav-icon-btn h-7 w-7"
              title="Look again for Pages and ad accounts"
              aria-label="Look again for Pages and ad accounts"
              disabled={busy !== null}
              onClick={() => void run("refresh", metaRefreshAction)}
            >
              {busy === "refresh" ? <Spinner size="0.9rem" /> : <RefreshCw className="h-3.5 w-3.5" />}
            </button>
          ) : undefined
        }
      >
        Meta: Instagram and ads
      </Heading>
      {!status && !error ? <CenteredSpinner className="py-6" /> : null}

      {status?.connected ? (
        <div className="space-y-3">
          <div className="surface-2 flex flex-wrap items-center gap-3 p-3.5">
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium">{status.page?.instagram ? `Posting as @${status.page.instagram.username}` : "No Instagram account linked"}</p>
              <p className="muted text-xs">
                {status.page ? `Page: ${status.page.name}` : "No Page chosen"}
                {status.systemUser ? ` · token of ${status.systemUser}` : ""}
              </p>
            </div>
            <button type="button" className="btn btn-white text-[13px]" disabled={busy !== null} onClick={() => void run("disconnect", metaDisconnectAction)}>
              {busy === "disconnect" ? <Spinner size="1rem" /> : null}
              Disconnect
            </button>
          </div>

          {status.missingPermissions.length ? (
            <Notice tone="warn">The token lacks {status.missingPermissions.join(", ")}. Generate a new one with them, disconnect and paste it.</Notice>
          ) : null}

          {status.pages.length > 1 ? (
            <label className="block text-xs">
              <span className="muted mb-1 block">Facebook Page</span>
              <select
                className="input text-base sm:text-sm"
                value={status.page?.id ?? ""}
                disabled={busy !== null}
                onChange={(e) => void run("page", () => metaChooseAction({ pageId: e.target.value }))}
              >
                {status.page ? null : <option value="">Pick a Page</option>}
                {status.pages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.instagram ? ` (@${p.instagram.username})` : " (no Instagram)"}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {status.adAccounts.length ? (
            <label className="block text-xs">
              <span className="muted mb-1 block">Ad account</span>
              <select
                className="input text-base sm:text-sm"
                value={status.adAccount?.id ?? ""}
                disabled={busy !== null}
                onChange={(e) => void run("account", () => metaChooseAction({ adAccountId: e.target.value }))}
              >
                {status.adAccount ? null : <option value="">Pick an ad account</option>}
                {status.adAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.currency}
                    {a.status === 1 ? "" : " (not active)"}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="muted text-xs">
              No ad account yet, so Seelie can post but not run ads. Create one in Business Settings → Accounts → Ad accounts, add a payment method, assign it to the system user,
              then press the refresh button above.
            </p>
          )}

          {status.adAccount ? (
            <div className="space-y-2">
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (capValid && capChanged) void run("cap", () => metaChooseAction({ monthlyCap: capValue }));
                }}
              >
                <label className="block min-w-0 flex-1 text-xs">
                  <span className="muted mb-1 block">Monthly ad cap ({currency})</span>
                  <input
                    className="input text-base tabular-nums sm:text-sm"
                    inputMode="numeric"
                    placeholder="Not set: no ad may spend"
                    value={cap}
                    onChange={(e) => setCap(e.target.value.replace(/[^\d.]/g, ""))}
                  />
                </label>
                <button type="submit" className="btn btn-primary" disabled={busy !== null || !capValid || !capChanged}>
                  {busy === "cap" ? <Spinner size="1rem" color="currentColor" /> : "Save"}
                </button>
              </form>
              {month ? (
                <p className="muted text-xs tabular-nums">
                  This month: {formatMoney(month.spent, month.currency)} spent
                  {month.heldByRunning > 0 ? `, up to ${formatMoney(month.heldByRunning, month.currency)} more by running ads` : ""}
                  {status.monthlyCap !== null ? ` · ${formatMoney(month.room, month.currency)} left for new ads` : ""}
                  {month.accountStatus !== "active" ? ` · account ${month.accountStatus}` : ""}
                </p>
              ) : null}
              {month?.prepaid ? <PrepaidLine prepaid={month.prepaid} currency={month.currency} /> : null}
              <p className="muted text-xs">
                Seelie asks before every ad, restart or bigger budget, and refuses anything that wouldn&apos;t fit under the cap. It may pause an ad or lower its budget on its own.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      {status && !status.connected ? (
        <form onSubmit={connect} className="space-y-2.5">
          {status.needsToken ? <Notice tone="warn">Meta stopped taking the saved token. Paste a new one.</Notice> : null}
          <p className="muted text-xs">
            One system-user token lets Seelie post on Instagram (it asks before every post) and run ads within a monthly cap you set. It is kept encrypted on this server and doesn&apos;t
            expire.
          </p>
          <ol className="muted list-decimal space-y-1 pl-4 text-xs">
            {META_STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <input
            className="input text-base sm:text-sm"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="System-user access token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
          />
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className="btn btn-primary" disabled={busy !== null || token.trim().length < 40}>
              {busy === "connect" ? <Spinner size="1rem" color="currentColor" /> : "Connect"}
            </button>
            <a
              className="muted inline-flex items-center gap-1 text-xs hover:underline"
              href="https://developers.facebook.com/docs/marketing-api/system-users/"
              target="_blank"
              rel="noreferrer"
            >
              About system users <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </form>
      ) : null}
      {error ? (
        <div className="mt-2">
          <Notice tone="danger">{error}</Notice>
        </div>
      ) : null}
    </section>
  );
}
