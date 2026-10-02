import "server-only";

import type { Api, Model, ModelThinkingLevel, ThinkingLevelMap } from "@paribelle/pi-ai";
import { getSupportedThinkingLevels } from "@paribelle/pi-ai";

import { availableModels, modelDefinitions, type ModelDefinition } from "./cliproxy";
import { DEFAULT_MODEL, DEFAULT_THINKING, requireSeelieConfig } from "./config";

/**
 * The models Seelie can use: whatever the connected accounts serve (CLIProxyAPI's
 * /v1/models), described by CLIProxyAPI's model definitions (name, context, the
 * thinking levels each takes). Read once a minute at most.
 */

/** What the screen shows for a model. */
export type SeelieModel = {
  id: string;
  name: string;
  description: string;
  /** The channel serving it (antigravity, codex, claude, ...). */
  provider: string;
  /** The levels the thinking picker offers, weakest first. */
  thinkingLevels: ModelThinkingLevel[];
  contextWindow: number;
  images: boolean;
  /** It watches video (Gemini): drafts and attached clips go to it as video, not frames. */
  video: boolean;
};

export type Catalog = { models: SeelieModel[]; defaultModel: string; defaultThinking: ModelThinkingLevel };

const TTL_MS = 60_000;
const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type Loaded = { at: number; models: Map<string, Model<Api>>; catalog: Catalog };
let cached: Loaded | null = null;
let inflight: Promise<Loaded> | null = null;

function apiFor(id: string, channel: string): { api: Api; path: string } {
  const lower = id.toLowerCase();
  if (lower.startsWith("gemini")) return { api: "google-generative-ai", path: "/v1beta" };
  // The Anthropic SDK appends /v1/messages itself.
  if (lower.startsWith("claude")) return { api: "anthropic-messages", path: "" };
  if (channel === "codex" || lower.includes("codex") || /^gpt-5/.test(lower)) return { api: "openai-responses", path: "/v1" };
  return { api: "openai-completions", path: "/v1" };
}

/**
 * pi's level map from a definition. Gemini names the levels it takes, and those go on
 * the wire as `thinkingLevel`; Claude and the OpenAI models take any level as a token
 * budget or an effort. A level a model can't take is null, so the picker hides it.
 */
function thinkingMap(def: ModelDefinition | undefined): { reasoning: boolean; map?: ThinkingLevelMap } {
  const thinking = def?.thinking;
  if (!thinking) return { reasoning: false };
  const map: ThinkingLevelMap = {};
  if (thinking.levels?.length) {
    const levels = new Set(thinking.levels.map((l) => l.toLowerCase()));
    for (const level of THINKING_ORDER) {
      if (level === "off") map.off = thinking.zero_allowed ? undefined : null;
      else map[level] = levels.has(level) ? level : null;
    }
  } else {
    map.off = thinking.zero_allowed ? undefined : null;
    map.xhigh = null;
    map.max = null;
  }
  return { reasoning: true, map };
}

function titleFromId(id: string) {
  return id.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

async function load(): Promise<Loaded> {
  const config = requireSeelieConfig();
  const listed = await availableModels();
  const channels = [...new Set(listed.map((m) => m.owned_by).filter(Boolean))];
  const definitions = new Map<string, ModelDefinition>();
  await Promise.all(
    channels.map(async (channel) => {
      const defs = await modelDefinitions(channel).catch(() => []);
      for (const def of defs) if (!definitions.has(def.id)) definitions.set(def.id, def);
    }),
  );

  const models = new Map<string, Model<Api>>();
  const infos: SeelieModel[] = [];
  for (const { id, owned_by: channel } of listed) {
    const def = definitions.get(id);
    // Image generators answer with pictures, not the text and tool calls Seelie runs on.
    if (def?.supportedOutputModalities?.includes("image")) continue;
    if (models.has(id)) continue;
    const { api, path } = apiFor(id, channel);
    const { reasoning, map } = thinkingMap(def);
    const images = def?.supportedInputModalities?.includes("image") ?? false;
    // Only pi's Gemini converter sends video; other APIs get a placeholder line.
    const video = api === "google-generative-ai" && (def?.supportedInputModalities?.includes("video") ?? false);
    const model: Model<Api> = {
      id,
      name: def?.display_name ?? titleFromId(id),
      api,
      provider: channel,
      baseUrl: config.url + path,
      input: ["text", ...(images ? (["image"] as const) : []), ...(video ? (["video"] as const) : [])],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reasoning,
      ...(map ? { thinkingLevelMap: map } : {}),
      contextWindow: def?.context_length ?? 128_000,
      maxTokens: def?.max_completion_tokens ?? 32_000,
    };
    models.set(id, model);
    infos.push({
      id,
      name: model.name,
      description: def?.description ?? model.name,
      provider: channel,
      thinkingLevels: getSupportedThinkingLevels(model),
      contextWindow: model.contextWindow,
      images,
      video,
    });
  }

  infos.sort((a, b) => (a.id === DEFAULT_MODEL ? -1 : b.id === DEFAULT_MODEL ? 1 : a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name)));
  const defaultModel = models.has(DEFAULT_MODEL) ? DEFAULT_MODEL : (infos[0]?.id ?? DEFAULT_MODEL);
  return {
    at: Date.now(),
    models,
    catalog: { models: infos, defaultModel, defaultThinking: DEFAULT_THINKING },
  };
}

async function current(force = false) {
  if (!force && cached && Date.now() - cached.at < TTL_MS) return cached;
  inflight ??= load()
    .then((next) => (cached = next))
    .finally(() => (inflight = null));
  return inflight;
}

export async function getCatalog(force = false): Promise<Catalog> {
  return (await current(force)).catalog;
}

/** pi's model object for an id, or null when no connected account serves it. */
export async function resolveModel(id: string): Promise<Model<Api> | null> {
  const state = await current();
  return state.models.get(id) ?? (await current(true)).models.get(id) ?? null;
}

/** The level a model will actually run at for the one asked for (the nearest it takes). */
export function effectiveThinking(model: Model<Api>, level: string): ModelThinkingLevel {
  const supported = getSupportedThinkingLevels(model);
  if ((supported as string[]).includes(level)) return level as ModelThinkingLevel;
  const want = THINKING_ORDER.indexOf(level as (typeof THINKING_ORDER)[number]);
  if (want < 0) return supported.at(-1) ?? "off";
  for (let i = want; i < THINKING_ORDER.length; i++) if (supported.includes(THINKING_ORDER[i])) return THINKING_ORDER[i];
  for (let i = want - 1; i >= 0; i--) if (supported.includes(THINKING_ORDER[i])) return THINKING_ORDER[i];
  return "off";
}

export function forgetCatalog() {
  cached = null;
}
