import "server-only";

import { Type } from "@paribelle/pi-ai";

import { PLAN_TOOL } from "../types";
import { defineTool, ToolError } from "./types";
import { optional, StringEnum } from "./util";

/**
 * The job's plan, like Claude Code's to-do list: Seelie writes the steps of a bigger job
 * first and ticks them off as it goes. The chat draws it as a checklist on a wide screen
 * and a progress card on a phone, pinned above the box while the job runs. Each call
 * replaces the whole list; the tool itself only checks it.
 */

export const MAX_PLAN_STEPS = 8;

export const plan = defineTool({
  name: PLAN_TOOL,
  label: "Plan",
  description: [
    "The checklist the owner watches while you work on a job of three or more steps. Each call replaces the whole list.",
    "steps: 3-6 short steps in everyday words (what you'll do, not tool names), each pending, active (one at a time), done or skipped; short: one or two words for the progress bar ('Photos', 'Render', 'Post');",
    "asks: true on a step that will wait for the owner's OK (an Instagram post, ad spend, a photoshoot). title: the job in a few words ('Reel for the blue kurta').",
    "next: with the last update, when everything's done, up to 3 things the owner may want next, in their own words ('Post it on Instagram', 'Make a 15 s version').",
    "Update it in the same reply as the next step's own calls (mark one done and the next active together), never as a call of its own.",
  ].join(" "),
  parameters: Type.Object({
    title: optional(Type.String({ maxLength: 60 })),
    steps: Type.Array(
      Type.Object({
        text: Type.String({ minLength: 1, maxLength: 90 }),
        short: optional(Type.String({ maxLength: 16 })),
        status: StringEnum(["pending", "active", "done", "skipped"]),
        asks: optional(Type.Boolean()),
      }),
      { minItems: 1, maxItems: MAX_PLAN_STEPS },
    ),
    next: optional(Type.Array(Type.String({ minLength: 1, maxLength: 60 }), { maxItems: 3 })),
  }),
  kind: "read",
  summary: (a) => `${a.steps.filter((s) => s.status === "done").length} of ${a.steps.length} done`,
  async execute(a) {
    if (a.steps.filter((s) => s.status === "active").length > 1) throw new ToolError("Only one step is active at a time; mark the others pending or done.");
    const done = a.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
    return { text: done === a.steps.length ? "Plan done." : "Plan updated." };
  },
});

/** What the reply is told about plans. */
export function planSection() {
  return [
    "Plans (the plan tool): the owner watches a job through its plan, so give every job of three or more steps one.",
    "- A reel, a photoshoot, store or catalogue work over several products, anything that posts or spends: call plan first, with 3-6 steps and the first one active, in the same reply as that step's first calls.",
    "- As you go, update it in the same reply as the next step's calls: the finished step done, the next one active. Mark steps that wait for the owner's OK with asks, and steps you no longer need as skipped.",
    "- When the job's done, mark every step done (with next: up to 3 likely follow-ups) and then reply. The checklist shows every step, so don't repeat it in prose.",
    "- No plan for a quick question, a lookup or a single change.",
  ].join("\n");
}
