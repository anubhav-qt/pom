import "server-only";

import { Type } from "@paribelle/pi-ai";

import { deleteRoutine, listRoutines, runRoutineNow, saveRoutine, setRoutineEnabled, type RoutineView } from "../routines";
import { checkSchedule, describeSchedule, whenLabel, type RoutineSchedule } from "../schedule";
import { defineTool, ToolError } from "./types";
import { optional, StringEnum } from "./util";

/** A routine as the model reads it. */
function brief(r: RoutineView) {
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    schedule: r.schedule,
    when: r.when,
    on: r.enabled,
    autoApprove: r.autoApprove,
    model: r.model ?? "the default",
    thinking: r.thinking ?? "the default",
    next: r.nextRunAt ? whenLabel(r.nextRunAt) : null,
    last: r.lastRunAt ? `${whenLabel(r.lastRunAt)} (${r.lastStatus ?? "unknown"})` : null,
    note: r.lastNote,
    chatId: r.chatId,
  };
}

function scheduleText(raw: unknown) {
  try {
    return describeSchedule(checkSchedule(raw));
  } catch {
    return "an unreadable schedule";
  }
}

export const routines = defineTool({
  name: "routines",
  label: "Routines",
  description: [
    "Seelie's routines: a message you get on a schedule (India time), each run replying in the routine's own chat while nobody watches; the owner manages them in Routines on this screen too.",
    "Use it when the owner wants something done regularly (\"every Monday morning send me the ads report\", \"check stock daily at 8\").",
    "action 'list': every routine with its schedule, next and last run. 'create': name, prompt (the message, written as the owner would ask it, complete on its own: the run sees this chat's history only if it's the routine's chat),",
    "schedule ({every: 'hours', hours: 1|2|3|4|6|8|12, time: first slot 'HH:MM'} | {every: 'day', time} | {every: 'week', days: [0 Sun … 6 Sat], time} | {every: 'month', day: 1–31, time}), optional model, thinking, autoApprove (ordinary OMS changes run without asking; ads, posts, marketplaces and paribelle.in always wait).",
    "'update': id plus the fields to change. 'enable' / 'disable' / 'delete' (the chat stays) / 'run_now': id.",
  ].join(" "),
  parameters: Type.Object({
    action: StringEnum(["list", "create", "update", "enable", "disable", "delete", "run_now"]),
    id: optional(Type.Integer({ minimum: 1 })),
    name: optional(Type.String({ minLength: 1, maxLength: 80 })),
    prompt: optional(Type.String({ minLength: 1, maxLength: 4000 })),
    schedule: optional(
      Type.Object({
        every: StringEnum(["hours", "day", "week", "month"]),
        time: Type.String({ pattern: "^\\d{1,2}:\\d{2}$" }),
        hours: optional(Type.Integer({ minimum: 1, maximum: 12 })),
        days: optional(Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), { maxItems: 7 })),
        day: optional(Type.Integer({ minimum: 1, maximum: 31 })),
      }),
    ),
    model: optional(Type.String({ maxLength: 120 })),
    thinking: optional(Type.String({ maxLength: 20 })),
    autoApprove: optional(Type.Boolean()),
  }),
  kind: (a) => (a.action === "list" ? "read" : "write"),
  summary: (a) => {
    switch (a.action) {
      case "list":
        return "List routines";
      case "create":
        return `New routine "${a.name ?? "?"}": ${a.schedule ? scheduleText(a.schedule) : "no schedule"}${a.autoApprove ? ", OMS changes without asking" : ""}`;
      case "update":
        return `Change routine ${a.id ?? "?"}${a.name ? ` to "${a.name}"` : ""}${a.schedule ? `: ${scheduleText(a.schedule)}` : ""}${a.prompt ? " (new message)" : ""}${a.autoApprove !== undefined ? `, auto-approve ${a.autoApprove ? "on" : "off"}` : ""}`;
      case "run_now":
        return `Run routine ${a.id ?? "?"} now`;
      default:
        return `${a.action[0].toUpperCase()}${a.action.slice(1)} routine ${a.id ?? "?"}`;
    }
  },
  async execute(a, ctx) {
    if (a.action === "list") return { data: (await listRoutines(ctx.user)).map(brief) };
    if (a.action === "create") {
      if (!a.name || !a.prompt || !a.schedule) throw new ToolError("A new routine needs name, prompt and schedule.");
      const made = await saveRoutine(ctx.user, {
        name: a.name,
        prompt: a.prompt,
        schedule: a.schedule as RoutineSchedule,
        model: a.model,
        thinking: a.thinking,
        autoApprove: a.autoApprove ?? false,
      }).catch(fail);
      return { text: `Made. It first runs ${made.nextRunAt ? whenLabel(made.nextRunAt) : "when switched on"}.`, data: brief(made) };
    }
    if (!a.id) throw new ToolError("Which routine (id from list)?");
    const all = await listRoutines(ctx.user);
    const r = all.find((x) => x.id === a.id);
    if (!r) throw new ToolError(`There's no routine ${a.id}. list shows them.`);
    switch (a.action) {
      case "update": {
        const saved = await saveRoutine(ctx.user, {
          id: r.id,
          name: a.name ?? r.name,
          prompt: a.prompt ?? r.prompt,
          schedule: (a.schedule as RoutineSchedule | undefined) ?? r.schedule,
          model: a.model ?? r.model,
          thinking: a.thinking ?? r.thinking,
          autoApprove: a.autoApprove ?? r.autoApprove,
          enabled: r.enabled,
        }).catch(fail);
        return { data: brief(saved) };
      }
      case "enable":
      case "disable":
        await setRoutineEnabled(ctx.user, r.id, a.action === "enable").catch(fail);
        return { data: brief((await listRoutines(ctx.user)).find((x) => x.id === r.id)!) };
      case "delete":
        await deleteRoutine(ctx.user, r.id).catch(fail);
        return { text: `Deleted "${r.name}". Its chat stays.` };
      case "run_now": {
        const started = await runRoutineNow(ctx.user, r.id).catch(fail);
        return { text: `Started "${r.name}" in its chat (${started.chatId}); it replies there.` };
      }
    }
    throw new ToolError("Unknown action.");
  },
});

function fail(err: unknown): never {
  throw new ToolError(err instanceof Error ? err.message : String(err));
}
