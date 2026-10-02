import "server-only";

import { Type, type Api, type Model, type ModelThinkingLevel, type Static } from "@paribelle/pi-ai";

import { effectiveThinking, getCatalog, resolveModel } from "./catalog";
import { defineTool } from "./tools/types";
import { StringEnum } from "./tools/util";
import type { HelperState } from "./types";

/**
 * Seelie's helpers: one reply can hand parts of a request that don't need each other to
 * up to MAX_HELPERS helpers, which work at the same time, each with Seelie's tools and
 * the same approvals, and answer back to Seelie. The engine runs them (engine.ts
 * runHelpers); this is the tool the model sees, the model a helper runs on and what
 * a helper is told.
 */

export const MAX_HELPERS = 4;
/** The most tool calls one helper may make. */
export const HELPER_MAX_CALLS = 30;
/** Helpers run on Gemini 3.8 Flash when a connected account serves it (Antigravity first); Seelie picks the thinking. */
export const HELPER_FAMILY = "gemini-3.8-flash";

const TIERS = ["minimal", "low", "medium", "high"] as const;
const ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const helpersParameters = Type.Object({
  jobs: Type.Array(
    Type.Object({
      title: Type.String({ minLength: 1, maxLength: 80, description: "A few words for the card, e.g. 'Stock of the Anarkali kurtis'." }),
      task: Type.String({
        minLength: 1,
        maxLength: 6000,
        description:
          "Everything the helper needs, complete on its own (it doesn't see this chat): what to find or do, the ids, SKUs, dates and filters, images as chat:N, and exactly what to report back.",
      }),
      thinking: StringEnum(TIERS, {
        description: "How hard it thinks: minimal or low for lookups and simple changes, medium for a few steps, high for analysis or careful writing.",
      }),
    }),
    { minItems: 1, maxItems: MAX_HELPERS },
  ),
});

export type HelperJob = Static<typeof helpersParameters>["jobs"][number];

/** The tool as the model sees it. The engine runs it; it's never in toolsFor, so helpers can't start helpers. */
export const helpersTool = defineTool({
  name: "helpers",
  label: "Helpers",
  description: [
    `Hand up to ${MAX_HELPERS} parts of the request that don't depend on each other to helpers that work at the same time, then put their answers together.`,
    "Each helper has your tools and the same approvals, sees only its task (not this chat), and answers back to you, not the user.",
  ].join(" "),
  parameters: helpersParameters,
  kind: "read",
  summary: (a) => {
    const titles = a.jobs.map((j) => j.title);
    return `${titles.length === 1 ? "1 helper" : `${titles.length} helpers at once`}: ${titles.join(", ")}`;
  },
  async execute() {
    throw new Error("Helpers run in the engine.");
  },
});

/** What the main reply is told about helpers. */
export function helpersSection() {
  return [
    "Helpers (the helpers tool):",
    "- When a request has parts that don't need each other's results (\"check stock of these, pull last week's ad results and draft a caption\"), give them to helpers in one helpers call so they run at the same time, then answer from what they report. It's faster; use it whenever there are two or more such parts that each take a few steps.",
    "- Don't use helpers for a single quick lookup, for steps where one needs another's result (do those yourself, in order), or to split one tool call that already takes many things at once.",
    "- A helper sees only its task: write it complete, with the ids, SKUs, dates, filters and chat:N images it needs and what to report back. Pick each helper's thinking for its job.",
    "- Their changes ask the user like yours; a helper doesn't wait for the others. Check what they report before you state it, and say if a helper failed or a change is waiting.",
  ].join("\n");
}

/** What a helper is told, after Seelie's own system prompt. */
export function helperSection(job: HelperJob, index: number, total: number) {
  return [
    `You are helper ${index + 1} of ${total} that Seelie started for one part of a bigger request. Your job: ${job.title}.`,
    "- Do only this job, with your tools; other helpers are doing the other parts at the same time.",
    "- Your answer goes back to Seelie, not the user: give the facts, numbers and ids it asked for, what you changed, what's waiting for approval and anything that failed. Complete, short, no greetings.",
    "- You can't ask questions. If something is unclear, make the sensible choice and say which.",
  ].join("\n");
}

/** What the main reply reads back: each helper's answer. */
export function helpersReport(states: HelperState[]) {
  return states
    .map((h, i) => {
      const how = h.status === "done" ? "" : h.status === "stopped" ? " (stopped before it finished)" : " (failed)";
      return `Helper ${i + 1}, "${h.title}"${how}:\n${h.answer?.trim() || "(no answer)"}`;
    })
    .join("\n\n");
}

/**
 * The model a helper runs on: Gemini 3.8 Flash (the variant named for the tier asked,
 * else the plain one, else the nearest tier), Antigravity's first; the reply's own model
 * when no account serves it. The tier becomes the nearest thinking level the model takes.
 */
export async function helperModel(tier: string, fallback: Model<Api>): Promise<{ model: Model<Api>; thinking: ModelThinkingLevel }> {
  const catalog = await getCatalog().catch(() => null);
  const suffix = (id: string) => (id === HELPER_FAMILY ? "" : id.slice(HELPER_FAMILY.length + 1));
  const flash = (catalog?.models ?? [])
    .filter((m) => m.id === HELPER_FAMILY || (m.id.startsWith(`${HELPER_FAMILY}-`) && (ORDER.includes(suffix(m.id)) || suffix(m.id) === "preview")))
    .sort((a, b) => Number(b.provider === "antigravity") - Number(a.provider === "antigravity"));
  const want = ORDER.indexOf(tier);
  const distance = (id: string) => (ORDER.includes(suffix(id)) ? Math.abs(ORDER.indexOf(suffix(id)) - want) : ORDER.length);
  const pick =
    flash.find((m) => suffix(m.id) === tier) ??
    flash.find((m) => !ORDER.includes(suffix(m.id))) ??
    [...flash].sort((a, b) => distance(a.id) - distance(b.id))[0];
  const model = (pick && (await resolveModel(pick.id).catch(() => null))) || fallback;
  return { model, thinking: effectiveThinking(model, tier) };
}
