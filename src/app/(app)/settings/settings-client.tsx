"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { CHANNEL_META } from "@/channels";
import { ChannelTag, Empty, Spinner } from "@/components/ui";
import { ENABLED_CHANNELS, FEATURES } from "@/config/features";
import type { Channel } from "@/db/schema";
import { withBasePath } from "@/lib/base-path";
import { dayLabel } from "@/lib/utils";

import { addChannelAccount, deleteChannelAccount, setAccountActive, syncNow } from "./actions";

/** What each channel needs before it can do anything. */
type CredentialField = {
  key: string;
  label: string;
  hint?: string;
  type?: "text" | "checkbox";
};

const CREDENTIAL_FIELDS: Record<Channel, CredentialField[]> = {
  amazon: [
    { key: "refreshToken", label: "LWA refresh token", hint: "Starts with Atzr| — from Authorize app" },
    { key: "sellerId", label: "Seller / merchant ID", hint: "Settings › Account Info › Merchant Token" },
    {
      key: "sandbox",
      label: "This is a sandbox account",
      type: "checkbox",
      hint: "Sandbox returns fixed mock data, not your real orders. Use it to prove the connection works.",
    },
    { key: "clientId", label: "LWA client ID (optional)", hint: "Falls back to the env var" },
    { key: "clientSecret", label: "LWA client secret (optional)" },
  ],
  flipkart: [
    { key: "appId", label: "App ID", hint: "Seller Dashboard › Developer Access" },
    { key: "appSecret", label: "App secret" },
    { key: "locationId", label: "Location ID", hint: "Warehouse used for stock updates" },
  ],
  meesho: [],
};

export interface AccountRow {
  id: number;
  channel: Channel;
  label: string;
  active: boolean;
  ordersSyncedThrough: string | null;
  credentialKeys: string[];
  sandbox: boolean;
}

export function ChannelAccounts({
  accounts,
  isOwner,
}: {
  accounts: AccountRow[];
  isOwner: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState<Channel | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function run(fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) {
    startTransition(async () => {
      const res = await fn();
      setMessage(res.ok ? (res.message ?? "Done.") : (res.error ?? "Something went wrong."));
      router.refresh();
    });
  }

  return (
    <section className="space-y-3">
      <h1 className="text-lg font-semibold">Connected accounts</h1>

      {message ? (
        <p className="rounded-md bg-blue-500/10 px-3 py-2 text-sm text-blue-600">{message}</p>
      ) : null}

      <div className="panel divide-y" style={{ borderColor: "var(--border)" }}>
        {accounts.length === 0 ? (
          <Empty title="No channels connected" hint="Add one below to start pulling orders." />
        ) : (
          accounts.map((account) => (
            <div key={account.id} className="flex flex-wrap items-center gap-3 p-3">
              <ChannelTag channel={account.channel} />
              <span className="text-sm font-medium">{account.label}</span>

              {!account.active ? (
                <span
                  className="rounded-full px-2.5 py-0.5 text-xs font-medium"
                  style={{ background: "var(--panel-2)", color: "var(--muted)" }}
                >
                  paused
                </span>
              ) : null}

              {account.sandbox ? (
                <span
                  className="rounded-full px-2.5 py-0.5 text-xs font-semibold tracking-wide"
                  style={{ background: "var(--warn-soft)", color: "var(--warn)" }}
                  title="Sandbox returns fixed mock data. Nothing here reflects real orders."
                >
                  SANDBOX
                </span>
              ) : null}

              {account.channel === "meesho" ? (
                <span className="muted text-xs">file import — no API</span>
              ) : (
                <span className="muted text-xs">
                  {account.ordersSyncedThrough
                    ? `synced ${dayLabel(new Date(account.ordersSyncedThrough))}`
                    : "never synced"}
                </span>
              )}

              <div className="ml-auto flex gap-2">
                {account.channel !== "meesho" ? (
                  <SyncControl accountId={account.id} onSettled={() => router.refresh()} />
                ) : null}

                {isOwner ? (
                  <>
                    <button
                      className="btn text-xs"
                      disabled={pending}
                      onClick={() => run(() => setAccountActive(account.id, !account.active))}
                    >
                      {pending ? <Spinner size="1rem" color="currentColor" /> : account.active ? "Pause" : "Resume"}
                    </button>
                    <button
                      className="btn text-xs text-rose-500"
                      disabled={pending}
                      onClick={() => {
                        if (
                          !confirm(
                            `Remove "${account.label}"? This deletes its orders and sync history from this app. The marketplace itself is untouched.`,
                          )
                        )
                          return;
                        run(() => deleteChannelAccount(account.id));
                      }}
                    >
                      {pending ? <Spinner size="1rem" color="currentColor" /> : "Remove"}
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>

      {isOwner ? (
        <div className="flex flex-wrap gap-2">
          {ENABLED_CHANNELS.map((channel) => (
            <button
              key={channel}
              className="btn text-xs"
              onClick={() => setAdding(adding === channel ? null : channel)}
            >
              + Add {CHANNEL_META[channel].name} account
            </button>
          ))}
        </div>
      ) : null}

      {adding ? (
        <form
          className="panel space-y-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            const credentials: Record<string, string> = {};
            for (const field of CREDENTIAL_FIELDS[adding]) {
              credentials[field.key] = String(fd.get(field.key) ?? "");
            }
            startTransition(async () => {
              await addChannelAccount({
                channel: adding,
                label: String(fd.get("label") ?? ""),
                credentials,
              });
              setAdding(null);
              router.refresh();
            });
          }}
        >
          <h2 className="text-sm font-semibold capitalize">Add {adding} account</h2>

          <div>
            <label className="muted mb-1 block text-xs">Name it something recognisable</label>
            <input name="label" className="input" placeholder="Paribelle — main" required />
          </div>

          {CREDENTIAL_FIELDS[adding].map((field) =>
            field.type === "checkbox" ? (
              <div key={field.key}>
                <label className="flex items-center gap-2 text-sm">
                  <input name={field.key} type="checkbox" value="true" />
                  {field.label}
                </label>
                {field.hint ? <p className="muted mt-0.5 text-xs">{field.hint}</p> : null}
              </div>
            ) : (
              <div key={field.key}>
                <label className="muted mb-1 block text-xs">{field.label}</label>
                <input name={field.key} className="input font-mono text-xs" />
                {field.hint ? <p className="muted mt-0.5 text-xs">{field.hint}</p> : null}
              </div>
            ),
          )}

          {adding === "meesho" ? (
            <p className="muted text-xs">
              Meesho has no self-serve API, so there is nothing to configure. Orders and labels are
              uploaded from the supplier panel exports below.
            </p>
          ) : null}

          <button className="btn btn-primary" disabled={pending}>
            {pending ? <Spinner size="1rem" color="currentColor" /> : "Save account"}
          </button>
        </form>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- */

interface SyncProgressState {
  status: "running" | "ok" | "failed";
  itemsSeen: number;
  itemsWritten: number;
  totalEstimate: number | null;
  error: string | null;
}

const POLL_MS = 600;
/** How long the finished state stays visible before the chip reverts to a button. */
const SETTLE_DISPLAY_MS = 2200;

/**
 * Replaces the "Sync now" button with a live progress chip for the duration
 * of a sync. The button click gets a runId back almost immediately — the
 * fetch itself keeps running in the background on the server — so this polls
 * that run's row for real numbers instead of just disabling the button and
 * hoping.
 */
function SyncControl({ accountId, onSettled }: { accountId: number; onSettled: () => void }) {
  const [runId, setRunId] = useState<number | null>(null);
  const [progress, setProgress] = useState<SyncProgressState | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function start() {
    setError(null);
    setStarting(true);

    const res = await syncNow(accountId);
    setStarting(false);

    if (!res.ok || !("runId" in res) || !res.runId) {
      setError(!res.ok ? res.error : "Sync did not start.");
      return;
    }

    setRunId(res.runId);
    setProgress({ status: "running", itemsSeen: 0, itemsWritten: 0, totalEstimate: null, error: null });

    pollRef.current = setInterval(async () => {
      const r = await fetch(withBasePath(`/api/sync-progress?runId=${res.runId}`));
      if (!r.ok) return; // a missed tick is invisible — the next one catches up
      const data = (await r.json()) as SyncProgressState;
      setProgress(data);

      if (data.status !== "running") {
        stopPolling();
        onSettled();
        setTimeout(() => {
          setRunId(null);
          setProgress(null);
        }, SETTLE_DISPLAY_MS);
      }
    }, POLL_MS);
  }

  if (error) {
    return (
      <button className="btn text-xs" style={{ color: "var(--danger)" }} onClick={start}>
        Retry sync
      </button>
    );
  }

  if (!runId || !progress) {
    return (
      <button className="btn text-xs" disabled={starting} onClick={start}>
        {starting ? <Spinner size="1rem" color="currentColor" /> : "Sync now"}
      </button>
    );
  }

  const total = progress.totalEstimate;
  const percent = total ? Math.min(100, Math.round((progress.itemsSeen / total) * 100)) : null;
  const done = progress.status !== "running";
  const failed = progress.status === "failed";

  return (
    <div
      className="flex w-48 flex-col gap-1.5 rounded-xl px-3 py-2"
      style={{ background: "var(--panel-2)", border: "1px solid var(--border)" }}
    >
      <div className="flex items-center justify-between text-xs">
        <span className={failed ? "" : "font-medium"} style={failed ? { color: "var(--danger)" } : undefined}>
          {failed
            ? "Sync failed"
            : done
              ? `Synced ${progress.itemsWritten}`
              : percent !== null
                ? `Fetching ${percent}%`
                : <Spinner size="1rem" color="currentColor" />}
        </span>
      </div>

      <div
        className="h-1.5 w-full overflow-hidden rounded-full"
        style={{ background: "var(--border)" }}
      >
        <div
          className="h-full rounded-full transition-all duration-300 ease-out"
          style={{
            width: percent !== null ? `${percent}%` : done ? "100%" : "35%",
            background: failed
              ? "var(--danger)"
              : "linear-gradient(90deg, var(--accent), var(--accent-2))",
            // While the total is still unknown (still paging the order list),
            // there is nothing honest to show as a percentage — an indeterminate
            // sweep says "working" without claiming a number we don't have yet.
            animation: percent === null && !done ? "sync-sweep 1.1s ease-in-out infinite" : undefined,
          }}
        />
      </div>

      {failed && progress.error ? (
        <p className="truncate text-[11px]" style={{ color: "var(--danger)" }} title={progress.error}>
          {progress.error}
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export function MeeshoImport({ accounts }: { accounts: { id: number; label: string }[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  if (!FEATURES.meeshoImport || accounts.length === 0) return null;

  async function upload(form: HTMLFormElement) {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(withBasePath("/api/import/meesho"), {
        method: "POST",
        body: new FormData(form),
      });
      const json = await res.json();
      setResult(res.ok ? formatSummary(json.summary) : (json.error ?? "Import failed."));
      if (res.ok) {
        form.reset();
        router.refresh();
      }
    } catch (err) {
      setResult(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Meesho import</h2>
      <p className="muted text-sm">
        Download the order sheet and the combined label PDF from the Meesho supplier panel and drop
        them here. Labels are matched to orders by sub-order ID, so the two files do not need to
        cover exactly the same set.
      </p>

      <form
        className="panel space-y-3 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void upload(e.currentTarget);
        }}
      >
        <div>
          <label className="muted mb-1 block text-xs">Account</label>
          <select name="accountId" className="input">
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="muted mb-1 block text-xs">Order sheet (.xlsx / .csv)</label>
            <input name="sheet" type="file" accept=".xlsx,.xls,.csv" className="input" />
          </div>
          <div>
            <label className="muted mb-1 block text-xs">Label PDF (optional)</label>
            <input name="labels" type="file" accept="application/pdf" className="input" />
          </div>
        </div>

        <button className="btn btn-primary" disabled={busy}>
          {busy ? <Spinner size="1rem" color="currentColor" /> : "Import"}
        </button>

        {result ? (
          <pre className="whitespace-pre-wrap rounded-md p-3 text-xs" style={{ background: "var(--bg)" }}>
            {result}
          </pre>
        ) : null}
      </form>
    </section>
  );
}

function formatSummary(summary: Record<string, any> | undefined) {
  if (!summary) return "Done.";
  const lines: string[] = [];

  if (summary.orders) {
    const o = summary.orders;
    lines.push(`Orders: ${o.written} written from ${o.parsed} rows.`);
    if (o.skippedRows) lines.push(`  ${o.skippedRows} rows skipped (no sub-order ID).`);
    if (o.unmappedSkus?.length) {
      lines.push(`  Unmapped SKUs: ${o.unmappedSkus.join(", ")}`);
    }
    if (o.unrecognisedColumns?.length) {
      lines.push(`  Columns not recognised: ${o.unrecognisedColumns.join(", ")}`);
    }
  }

  if (summary.labels) {
    const l = summary.labels;
    lines.push(`Labels: ${l.attached} attached from ${l.pagesMatched} matched pages.`);
    if (l.unmatchedPages?.length) {
      lines.push(`  Pages with no matching order: ${l.unmatchedPages.join(", ")}`);
    }
  }

  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */

export interface RunRow {
  id: number;
  kind: string;
  status: string;
  startedAt: string;
  itemsWritten: number;
  error: string | null;
  accountLabel: string;
  channel: Channel;
}

export function SyncLog({ runs }: { runs: RunRow[] }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Sync log</h2>
      <p className="muted text-sm">
        The last 25 sync attempts. This is the first place to look when orders stop appearing.
      </p>

      <div className="panel overflow-x-auto">
        {runs.length === 0 ? (
          <Empty title="No syncs yet" />
        ) : (
          <table className="grid-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Account</th>
                <th>Kind</th>
                <th className="text-right">Written</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td className="whitespace-nowrap text-xs">
                    {new Date(run.startedAt).toLocaleString("en-IN")}
                  </td>
                  <td className="text-xs">
                    <ChannelTag channel={run.channel} />
                    <span className="muted ml-1">{run.accountLabel}</span>
                  </td>
                  <td className="text-xs">{run.kind}</td>
                  <td className="text-right tabular-nums">{run.itemsWritten}</td>
                  <td className="max-w-md text-xs">
                    {run.status === "ok" ? (
                      <span className="text-emerald-600">ok</span>
                    ) : run.status === "running" ? (
                      <span className="muted">running…</span>
                    ) : (
                      <span className="break-all text-rose-500">{run.error ?? "failed"}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
