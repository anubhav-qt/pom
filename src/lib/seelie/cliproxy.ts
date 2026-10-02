import "server-only";

import { requireSeelieConfig } from "./config";

/**
 * CLIProxyAPI's management API (the v8 routes), cut down to what Seelie uses: the
 * connected accounts, logging one in, the model definitions, and `api-call`, which
 * sends a request upstream with an account's token put in for `$TOKEN$` (how the
 * limits are read without the OMS ever holding a token).
 */

const TIMEOUT_MS = 15_000;

export class CliproxyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CliproxyError";
  }
}

async function call<T>(
  path: string,
  init: { method?: string; json?: unknown; query?: Record<string, string>; key?: "management" | "api" } = {},
): Promise<T> {
  const config = requireSeelieConfig();
  const url = new URL(config.url + path);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
  const key = init.key === "api" ? config.apiKey : config.managementKey;
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      ...(init.json === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  }).catch((err: unknown) => {
    throw new CliproxyError(`CLIProxyAPI is unreachable (${err instanceof Error ? err.message : String(err)})`, 0);
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : text.slice(0, 200);
    throw new CliproxyError(`CLIProxyAPI ${res.status}: ${message || res.statusText}`, res.status);
  }
  return body as T;
}

/* -------------------------------------------------------------------------- */
/* Accounts                                                                   */
/* -------------------------------------------------------------------------- */

/** One connected account (a credential file), as the management API lists it. Tokens are never listed. */
export type Credential = {
  id: string;
  name: string;
  provider: string;
  type?: string;
  email?: string;
  account?: string;
  label?: string;
  auth_index: string;
  project_id?: string;
  status?: string;
  status_message?: string;
  disabled?: boolean;
  unavailable?: boolean;
  success?: number;
  failed?: number;
  created_at?: string;
  updated_at?: string;
  /** Codex keeps its ChatGPT account id here or in the id token's claims. */
  chatgpt_account_id?: string;
  id_token?: string;
  metadata?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
};

export async function listCredentials(): Promise<Credential[]> {
  const body = await call<{ files?: Credential[] }>("/v8/management/credentials");
  return body.files ?? [];
}

export async function deleteCredential(name: string): Promise<void> {
  await call("/v8/management/credentials", { method: "DELETE", query: { name } });
}

export async function setCredentialDisabled(name: string, disabled: boolean): Promise<void> {
  await call("/v8/management/credentials/status", { method: "PATCH", json: { name, disabled } });
}

/* -------------------------------------------------------------------------- */
/* Logging an account in                                                      */
/* -------------------------------------------------------------------------- */

/** The OAuth providers CLIProxyAPI logs in itself, and the names Seelie shows for them. */
export const LOGIN_PROVIDERS = {
  antigravity: "Google Antigravity",
  codex: "ChatGPT (Codex)",
  claude: "Claude",
} as const;
export type LoginProvider = keyof typeof LOGIN_PROVIDERS;

/**
 * Starts a login. The URL's redirect is `http://localhost:<port>/...` on the machine
 * running CLIProxyAPI, so it lands by itself only when the browser is on that machine;
 * anywhere else the browser shows an error page whose address the user pastes back
 * (`finishLogin`).
 */
export async function startLogin(provider: LoginProvider): Promise<{ url: string; state: string }> {
  const body = await call<{ url: string; state: string }>("/v8/management/oauth/auth-url", {
    query: { provider, is_webui: "true" },
  });
  return { url: body.url, state: body.state };
}

export type LoginStatus = { status: "wait" } | { status: "ok" } | { status: "error"; error: string };

export async function loginStatus(state: string): Promise<LoginStatus> {
  const body = await call<{ status: string; error?: string }>("/v8/management/oauth/status", { query: { state } });
  if (body.status === "ok") return { status: "ok" };
  if (body.status === "error") return { status: "error", error: body.error ?? "Login failed" };
  return { status: "wait" };
}

/** Hands CLIProxyAPI the address the login ended on (the paste-back path). */
export async function finishLogin(provider: LoginProvider, redirectUrl: string): Promise<void> {
  await call("/v8/management/oauth/callback", { method: "POST", json: { provider, redirect_url: redirectUrl } });
}

export async function cancelLogin(state: string): Promise<void> {
  await call("/v8/management/oauth/session", { method: "DELETE", query: { state } });
}

/* -------------------------------------------------------------------------- */
/* Models                                                                     */
/* -------------------------------------------------------------------------- */

/** What CLIProxyAPI knows about a model, per channel (antigravity, codex, claude, ...). */
export type ModelDefinition = {
  id: string;
  owned_by?: string;
  display_name?: string;
  description?: string;
  context_length?: number;
  max_completion_tokens?: number;
  supportedInputModalities?: string[];
  supportedOutputModalities?: string[];
  thinking?: { min?: number; max?: number; zero_allowed?: boolean; dynamic_allowed?: boolean; levels?: string[] };
};

export async function modelDefinitions(channel: string): Promise<ModelDefinition[]> {
  const body = await call<{ models?: ModelDefinition[] }>(
    `/v8/management/routing/model-definitions/${encodeURIComponent(channel)}`,
  );
  return body.models ?? [];
}

/** The models the connected accounts can serve right now. */
export async function availableModels(): Promise<{ id: string; owned_by: string }[]> {
  const body = await call<{ data?: { id: string; owned_by: string }[] }>("/v1/models", { key: "api" });
  return body.data ?? [];
}

/* -------------------------------------------------------------------------- */
/* Upstream calls with an account's token                                     */
/* -------------------------------------------------------------------------- */

export type ApiCallRequest = {
  authIndex: string;
  method: "GET" | "POST";
  url: string;
  header: Record<string, string>;
  data?: string;
};

export async function apiCall(req: ApiCallRequest): Promise<{ status: number; body: unknown }> {
  const res = await call<{ status_code: number; body?: string }>("/v8/management/requests/api-call", {
    method: "POST",
    json: { auth_index: req.authIndex, method: req.method, url: req.url, header: req.header, data: req.data },
  });
  let body: unknown = res.body ?? null;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      // Not JSON; keep the text.
    }
  }
  return { status: res.status_code, body };
}
