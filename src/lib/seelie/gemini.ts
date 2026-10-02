import "server-only";

import { DEFAULT_MODEL, requireSeelieConfig } from "./config";

/**
 * One-off Gemini calls outside the chat loop, straight to CLIProxyAPI's Gemini route:
 * web search (googleSearch can't share a request with function tools), YouTube watching
 * (fileData), and image generation. The chat's own model isn't used, because a chat may
 * run on Claude or Codex, which can do none of these.
 */

/** Text, search and YouTube sub-calls. */
export const HELPER_MODEL = DEFAULT_MODEL;
/** Nano Banana 2, the image model the Antigravity account serves. */
export const IMAGE_MODEL = "gemini-3.1-flash-image";

export type GeminiPart =
  | { text: string; thought?: boolean }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { fileUri: string; mimeType: string } };

export interface GeminiRequest {
  contents: { role: "user" | "model"; parts: GeminiPart[] }[];
  systemInstruction?: { parts: { text: string }[] };
  tools?: unknown[];
  generationConfig?: Record<string, unknown>;
}

export interface GeminiResult {
  /** The answer, thoughts left out. */
  text: string;
  images: { mimeType: string; bytes: Buffer }[];
  /** What googleSearch read, when it searched. */
  sources: { title: string; url: string }[];
  queries: string[];
}

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

type Candidate = {
  content?: { parts?: ({ text?: string; thought?: boolean; inlineData?: { mimeType: string; data: string } } | null)[] };
  finishReason?: string;
  groundingMetadata?: { webSearchQueries?: string[]; groundingChunks?: { web?: { uri?: string; title?: string } }[] };
};

export async function generateContent(
  model: string,
  body: GeminiRequest,
  opts: { signal: AbortSignal; timeoutMs?: number },
): Promise<GeminiResult> {
  const config = requireSeelieConfig();
  const res = await fetch(`${config.url}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": config.apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 120_000)]),
    cache: "no-store",
  }).catch((err: unknown) => {
    if (opts.signal.aborted) throw err;
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    throw new GeminiError(timedOut ? `${model} took too long to answer.` : "CLIProxyAPI is unreachable.", 0);
  });
  const raw = await res.text();
  let json: { candidates?: Candidate[]; error?: { message?: string } } | null = null;
  try {
    json = JSON.parse(raw);
  } catch {
    // Not JSON: reported below.
  }
  if (!res.ok) {
    const why = json?.error?.message ?? raw.slice(0, 200);
    const limit = res.status === 429 ? " (the account's limit is used up; try again later)" : "";
    throw new GeminiError(`${model}: HTTP ${res.status}${limit}: ${why}`, res.status);
  }
  const cand = json?.candidates?.[0];
  if (!cand) throw new GeminiError(`${model} gave no answer.`, res.status);
  const parts = (cand.content?.parts ?? []).filter((p) => p !== null);
  const seen = new Set<string>();
  const sources: GeminiResult["sources"] = [];
  for (const c of cand.groundingMetadata?.groundingChunks ?? []) {
    const url = c.web?.uri;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({ title: c.web?.title ?? "", url });
  }
  return {
    text: parts
      .filter((p) => typeof p.text === "string" && !p.thought)
      .map((p) => p.text)
      .join("")
      .trim(),
    images: parts.filter((p) => p.inlineData?.mimeType.startsWith("image/")).map((p) => ({ mimeType: p.inlineData!.mimeType, bytes: Buffer.from(p.inlineData!.data, "base64") })),
    sources,
    queries: cand.groundingMetadata?.webSearchQueries ?? [],
  };
}

/** Today in India, for prompts: without it the search model assumes an older year. */
export function todayLine() {
  const date = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date());
  return `Today is ${date} (India).`;
}
