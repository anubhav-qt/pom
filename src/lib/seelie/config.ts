import "server-only";

/**
 * Seelie reaches its models through CLIProxyAPI, which runs next to the OMS on the
 * ThinkPad and nowhere else. Without CLIPROXY_URL (the Vercel fallback) Seelie is
 * offline: the screen says so and nothing tries to call a model.
 */
export type SeelieConfig = {
  /** CLIProxyAPI's base URL, without a trailing slash. */
  url: string;
  /** The key the model endpoints take (CLIProxyAPI's `api-keys`). */
  apiKey: string;
  /** The management API's key (CLIProxyAPI's `remote-management.secret-key`). */
  managementKey: string;
};

export function seelieConfig(): SeelieConfig | null {
  const url = process.env.CLIPROXY_URL?.trim().replace(/\/+$/, "");
  if (!url) return null;
  return {
    url,
    apiKey: process.env.CLIPROXY_API_KEY?.trim() ?? "",
    managementKey: process.env.CLIPROXY_MANAGEMENT_KEY?.trim() ?? "",
  };
}

export function requireSeelieConfig(): SeelieConfig {
  const config = seelieConfig();
  if (!config) throw new SeelieOfflineError();
  return config;
}

export class SeelieOfflineError extends Error {
  constructor() {
    super("Seelie is offline here: it runs on the ThinkPad, next to CLIProxyAPI.");
    this.name = "SeelieOfflineError";
  }
}

/** A new chat's model and thinking level until someone picks others. */
export const DEFAULT_MODEL = "gemini-3.8-flash-high";
export const DEFAULT_THINKING = "high";
