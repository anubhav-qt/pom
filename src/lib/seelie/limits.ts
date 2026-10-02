import "server-only";

import { apiCall, listCredentials, LOGIN_PROVIDERS, type Credential } from "./cliproxy";

/**
 * Each connected account's usage limits (the 5-hour and weekly windows), read from the
 * provider through CLIProxyAPI's `api-call`, which puts the account's token in for
 * `$TOKEN$`. Requests and parsing follow CLIProxyAPI's Management Center. Read at most
 * once a minute per account.
 */

export type LimitWindow = {
  id: string;
  /** "5 hours", "Weekly", "Weekly · Opus", ... */
  label: string;
  /** What it counts, when the provider says (Antigravity's model groups). */
  scope?: string;
  /** 0 = untouched, 1 = used up. */
  used: number;
  resetAt: string | null;
};

export type AccountLimits = {
  name: string;
  authIndex: string;
  provider: string;
  providerName: string;
  email: string | null;
  plan: string | null;
  /** CLIProxyAPI's own view: active, disabled, cooling down after errors. */
  status: "active" | "disabled" | "unavailable";
  statusMessage: string | null;
  windows: LimitWindow[];
  /** Why the limits couldn't be read, if they couldn't. */
  error: string | null;
  fetchedAt: string;
};

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: AccountLimits }>();

const ANTIGRAVITY_UA = "antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)";
const ANTIGRAVITY_PLANS: Record<string, string> = {
  "free-tier": "Free",
  "g1-pro-tier": "Google AI Pro",
  "g1-ultra-tier": "Google AI Ultra",
  "g1-ultra-lite-tier": "Google AI Ultra Lite",
};

function clamp01(n: number) {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function windowLabel(window: string | undefined, fallback: string) {
  const w = (window ?? "").toLowerCase();
  if (w === "5h") return "5 hours";
  if (w === "weekly") return "Weekly";
  if (w === "daily") return "Daily";
  return fallback;
}

/* -------------------------------------------------------------------------- */
/* Antigravity                                                                */
/* -------------------------------------------------------------------------- */

type AntigravityBucket = {
  bucketId?: string;
  displayName?: string;
  window?: string;
  resetTime?: string;
  remainingFraction?: number | string;
};
type AntigravityGroup = { displayName?: string; description?: string; buckets?: AntigravityBucket[] };

async function antigravity(cred: Credential): Promise<Pick<AccountLimits, "windows" | "plan">> {
  const header = { Authorization: "Bearer $TOKEN$", "Content-Type": "application/json", "User-Agent": ANTIGRAVITY_UA };
  const [quota, assist] = await Promise.all([
    apiCall({
      authIndex: cred.auth_index,
      method: "POST",
      url: "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      header,
      data: JSON.stringify({ project: cred.project_id ?? "" }),
    }),
    apiCall({
      authIndex: cred.auth_index,
      method: "POST",
      url: "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
      header,
      data: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
    }).catch(() => null),
  ]);
  if (quota.status !== 200) throw new Error(`Google answered ${quota.status}`);

  const groups = ((quota.body as { groups?: AntigravityGroup[] })?.groups ?? []) as AntigravityGroup[];
  const order = (w?: string) => (w === "5h" ? 0 : w === "weekly" ? 1 : 2);
  const windows: LimitWindow[] = [];
  groups.forEach((group, g) => {
    const buckets = [...(group.buckets ?? [])].sort((a, b) => order(a.window) - order(b.window));
    for (const [b, bucket] of buckets.entries()) {
      const remaining = num(bucket.remainingFraction);
      if (remaining === null) continue;
      windows.push({
        id: `${g}-${bucket.bucketId ?? bucket.window ?? b}`,
        label: windowLabel(bucket.window, bucket.displayName ?? "Limit"),
        scope: group.displayName,
        used: clamp01(1 - remaining),
        resetAt: bucket.resetTime ?? null,
      });
    }
  });

  const tier = (assist?.body as { paidTier?: { id?: string; name?: string }; currentTier?: { id?: string; name?: string } })
    ?? {};
  const plan = tier.paidTier ?? tier.currentTier;
  return { windows, plan: plan ? (ANTIGRAVITY_PLANS[plan.id ?? ""] ?? plan.name ?? plan.id ?? null) : null };
}

/* -------------------------------------------------------------------------- */
/* Codex (ChatGPT)                                                            */
/* -------------------------------------------------------------------------- */

type CodexWindow = {
  used_percent?: number | string;
  limit_window_seconds?: number | string;
  reset_after_seconds?: number | string;
  reset_at?: number | string;
};
type CodexRateLimit = { primary_window?: CodexWindow | null; secondary_window?: CodexWindow | null };

function codexAccountId(cred: Credential): string | null {
  const direct = cred.chatgpt_account_id ?? cred.metadata?.chatgpt_account_id ?? cred.attributes?.chatgpt_account_id;
  if (typeof direct === "string" && direct) return direct;
  const token = cred.id_token ?? cred.metadata?.id_token;
  if (typeof token !== "string") return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    const auth = payload["https://api.openai.com/auth"] ?? payload;
    return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : null;
  } catch {
    return null;
  }
}

function codexWindow(id: string, w: CodexWindow | null | undefined, scope?: string): LimitWindow | null {
  if (!w) return null;
  const used = num(w.used_percent);
  if (used === null) return null;
  const seconds = num(w.limit_window_seconds);
  const label = seconds === null ? "Limit" : seconds <= 6 * 3600 ? "5 hours" : seconds >= 6 * 86400 ? "Weekly" : `${Math.round(seconds / 3600)} hours`;
  const resetAt = num(w.reset_at);
  const resetAfter = num(w.reset_after_seconds);
  return {
    id,
    label,
    scope,
    used: clamp01(used / 100),
    resetAt:
      resetAt !== null
        ? new Date(resetAt * 1000).toISOString()
        : resetAfter !== null
          ? new Date(Date.now() + resetAfter * 1000).toISOString()
          : null,
  };
}

async function codex(cred: Credential): Promise<Pick<AccountLimits, "windows" | "plan">> {
  const header: Record<string, string> = {
    Authorization: "Bearer $TOKEN$",
    "Content-Type": "application/json",
    "User-Agent": "codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)",
  };
  const accountId = codexAccountId(cred);
  if (accountId) header["Chatgpt-Account-Id"] = accountId;
  const res = await apiCall({ authIndex: cred.auth_index, method: "GET", url: "https://chatgpt.com/backend-api/wham/usage", header });
  if (res.status !== 200) throw new Error(`ChatGPT answered ${res.status}`);
  const body = (res.body ?? {}) as {
    plan_type?: string;
    rate_limit?: CodexRateLimit | null;
    additional_rate_limits?: { limit_name?: string; rate_limit?: CodexRateLimit | null }[] | null;
  };
  const windows = [
    codexWindow("primary", body.rate_limit?.primary_window),
    codexWindow("secondary", body.rate_limit?.secondary_window),
    ...(body.additional_rate_limits ?? []).flatMap((extra, i) => [
      codexWindow(`extra-${i}-p`, extra.rate_limit?.primary_window, extra.limit_name),
      codexWindow(`extra-${i}-s`, extra.rate_limit?.secondary_window, extra.limit_name),
    ]),
  ].filter((w): w is LimitWindow => w !== null);
  const plan = body.plan_type ? body.plan_type.charAt(0).toUpperCase() + body.plan_type.slice(1) : null;
  return { windows, plan };
}

/* -------------------------------------------------------------------------- */
/* Claude                                                                     */
/* -------------------------------------------------------------------------- */

const CLAUDE_WINDOWS = [
  ["five_hour", "5 hours", undefined],
  ["seven_day", "Weekly", undefined],
  ["seven_day_opus", "Weekly", "Opus"],
  ["seven_day_sonnet", "Weekly", "Sonnet"],
  ["seven_day_oauth_apps", "Weekly", "Apps"],
] as const;

async function claude(cred: Credential): Promise<Pick<AccountLimits, "windows" | "plan">> {
  const res = await apiCall({
    authIndex: cred.auth_index,
    method: "GET",
    url: "https://api.anthropic.com/api/oauth/usage",
    header: {
      Authorization: "Bearer $TOKEN$",
      "Content-Type": "application/json",
      "User-Agent": "claude-cli/2.1.280 (external, cli)",
      "anthropic-beta": "oauth-2025-04-20",
    },
  });
  if (res.status !== 200) throw new Error(`Anthropic answered ${res.status}`);
  const body = (res.body ?? {}) as Record<string, { utilization?: number; resets_at?: string | null } | null>;
  const windows: LimitWindow[] = [];
  for (const [key, label, scope] of CLAUDE_WINDOWS) {
    const w = body[key];
    const used = num(w?.utilization);
    if (!w || used === null) continue;
    windows.push({ id: key, label, scope, used: clamp01(used / 100), resetAt: w.resets_at ?? null });
  }
  return { windows, plan: null };
}

/* -------------------------------------------------------------------------- */

const READERS: Partial<Record<string, (cred: Credential) => Promise<Pick<AccountLimits, "windows" | "plan">>>> = {
  antigravity,
  codex,
  claude,
};

function base(cred: Credential): Omit<AccountLimits, "windows" | "plan" | "error" | "fetchedAt"> {
  const provider = cred.provider || cred.type || "unknown";
  return {
    name: cred.name,
    authIndex: cred.auth_index,
    provider,
    providerName: LOGIN_PROVIDERS[provider as keyof typeof LOGIN_PROVIDERS] ?? provider,
    email: cred.email ?? cred.account ?? cred.label ?? null,
    status: cred.disabled ? "disabled" : cred.unavailable ? "unavailable" : "active",
    statusMessage: cred.status_message || null,
  };
}

async function readAccount(cred: Credential, force: boolean): Promise<AccountLimits> {
  const hit = cache.get(cred.auth_index);
  const meta = base(cred);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return { ...hit.value, ...meta };
  const reader = READERS[meta.provider];
  let value: AccountLimits;
  if (!reader || cred.disabled) {
    value = { ...meta, windows: [], plan: null, error: reader ? null : "Limits aren't readable for this provider", fetchedAt: new Date().toISOString() };
  } else {
    try {
      const { windows, plan } = await reader(cred);
      value = { ...meta, windows, plan, error: null, fetchedAt: new Date().toISOString() };
    } catch (err) {
      value = { ...meta, windows: [], plan: hit?.value.plan ?? null, error: err instanceof Error ? err.message : String(err), fetchedAt: new Date().toISOString() };
    }
  }
  cache.set(cred.auth_index, { at: Date.now(), value });
  return value;
}

/** Every connected account with its limits. */
export async function getLimits(force = false): Promise<AccountLimits[]> {
  const creds = await listCredentials();
  return Promise.all(creds.map((cred) => readAccount(cred, force)));
}
