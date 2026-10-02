"use client";

import { ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Modal } from "@/components/modal";
import { Toggle } from "@/components/toggle";
import { CenteredSpinner, Spinner } from "@/components/ui";
import type { InstagramStatus } from "@/lib/seelie/instagram";
import type { AccountLimits, LimitWindow } from "@/lib/seelie/limits";
import type { StoreStatus } from "@/lib/seelie/store";
import type { ImageBudget } from "@/lib/seelie/studio/budget";
import { useSeelie } from "@/lib/stores/seelie-store";

import {
  accountEnabledAction,
  cancelLoginAction,
  finishLoginAction,
  imageBudgetAction,
  instagramConnectAction,
  instagramDisconnectAction,
  instagramStatusAction,
  loginStatusAction,
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
        {owner ? <Instagram /> : null}
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
/* Instagram                                                                  */
/* -------------------------------------------------------------------------- */

const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

function Instagram() {
  const [status, setStatus] = useState<InstagramStatus | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void instagramStatusAction().then((res) => (res.ok ? setStatus(res.data) : setError(res.error)));
  }, []);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await instagramConnectAction(token);
    setBusy(false);
    if (res.ok) {
      setToken("");
      setStatus(res.data);
    } else setError(res.error);
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    const res = await instagramDisconnectAction();
    setBusy(false);
    if (res.ok) setStatus(res.data);
    else setError(res.error);
  }

  return (
    <section>
      <Heading>Instagram</Heading>
      {!status && !error ? <CenteredSpinner className="py-6" /> : null}
      {status?.connected ? (
        <div className="surface-2 flex flex-wrap items-center gap-3 p-3.5">
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-medium">Posting as @{status.username}</p>
            <p className="muted text-xs">
              {status.accountType === "MEDIA_CREATOR" ? "Creator account" : status.accountType === "BUSINESS" ? "Business account" : "Professional account"}
              {status.expiresAt ? ` · token renews by itself, good till ${shortDate(status.expiresAt)}` : " · token renews by itself"}
            </p>
          </div>
          <button type="button" className="btn btn-white text-[13px]" disabled={busy} onClick={() => void disconnect()}>
            {busy ? <Spinner size="1rem" /> : null}
            Disconnect
          </button>
        </div>
      ) : null}
      {status && !status.connected ? (
        <form onSubmit={connect} className="space-y-2.5">
          {status.needsToken ? <Notice tone="warn">Instagram stopped taking the saved token{status.username ? ` for @${status.username}` : ""}. Paste a new one.</Notice> : null}
          <p className="muted text-xs">
            Seelie posts finished videos as reels, and asks you before each one. Paste a long-lived access token for the shop&apos;s Instagram business or creator account (Meta for
            Developers → your app → Instagram API with Instagram Login → Generate token). It is kept encrypted on this server and renewed by itself.
          </p>
          <input
            className="input text-base sm:text-sm"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Access token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
          />
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className="btn btn-primary" disabled={busy || token.trim().length < 40}>
              {busy ? <Spinner size="1rem" color="currentColor" /> : "Connect"}
            </button>
            <a
              className="muted inline-flex items-center gap-1 text-xs hover:underline"
              href="https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login"
              target="_blank"
              rel="noreferrer"
            >
              How to get a token <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </form>
      ) : null}
      {error ? <div className="mt-2"><Notice tone="danger">{error}</Notice></div> : null}
    </section>
  );
}
