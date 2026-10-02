import "server-only";

import { Type } from "@paribelle/pi-ai";

import { addMemory, deleteMemories, listMemories, MAX_MEMORY, MemoryError, memoriesById, updateMemory } from "../memories";
import { defineTool, ToolError } from "./types";
import { optional, StringEnum } from "./util";

const quote = (text: string) => `“${text.length > 120 ? `${text.slice(0, 119)}…` : text}”`;

export const memory = defineTool({
  name: "memory",
  label: "Memory",
  description: [
    "What the person you're talking with asked you to remember, kept across all their chats until they delete it (everything kept is already in your instructions with its id).",
    "action 'remember': text (one standalone line, their words; several separate things go in texts). 'list': everything kept. 'update': id and the new text.",
    "'forget': ids to delete; it always asks them first.",
  ].join(" "),
  parameters: Type.Object({
    action: StringEnum(["remember", "list", "update", "forget"]),
    text: optional(Type.String({ minLength: 1, maxLength: MAX_MEMORY })),
    texts: optional(Type.Array(Type.String({ minLength: 1, maxLength: MAX_MEMORY }), { maxItems: 10 })),
    id: optional(Type.Integer({ minimum: 1 })),
    ids: optional(Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, maxItems: 100 })),
  }),
  // Saving is what they just asked for, so it doesn't wait; forgetting always asks.
  kind: (a) => (a.action === "forget" ? "forget" : a.action === "update" ? "write" : "read"),
  summary: async (a, { user }) => {
    switch (a.action) {
      case "remember": {
        const all = [...(a.text ? [a.text] : []), ...(a.texts ?? [])];
        return all.length === 1 ? `Remember ${quote(all[0])}` : `Remember ${all.length} things`;
      }
      case "list":
        return "What I remember";
      case "update":
        return `Change memory ${a.id ?? "?"} to ${a.text ? quote(a.text) : "?"}`;
      case "forget": {
        const found = await memoriesById(user, a.ids ?? (a.id ? [a.id] : []));
        if (!found.length) return "Forget (nothing found)";
        return `Forget ${found.map((m) => quote(m.text)).join(", ")}`;
      }
    }
  },
  async execute(a, ctx) {
    try {
      switch (a.action) {
        case "list":
          return { data: (await listMemories(ctx.user)).map((m) => ({ id: m.id, text: m.text })) };
        case "remember": {
          const all = [...(a.text ? [a.text] : []), ...(a.texts ?? [])];
          if (!all.length) throw new ToolError("What should I remember? Give text.");
          const saved = [];
          for (const text of all) saved.push(await addMemory(ctx.user, text, ctx.chatId));
          return {
            text: saved.every((s) => s.existed) ? "Already remembered." : "Remembered; it's in every chat from now on.",
            data: saved.map((s) => ({ id: s.memory.id, text: s.memory.text, ...(s.existed ? { already: true } : {}) })),
          };
        }
        case "update": {
          if (!a.id || !a.text) throw new ToolError("update needs id and text.");
          const m = await updateMemory(ctx.user, a.id, a.text);
          return { data: { id: m.id, text: m.text } };
        }
        case "forget": {
          const ids = a.ids ?? (a.id ? [a.id] : []);
          if (!ids.length) throw new ToolError("Which memories (ids)?");
          const gone = await deleteMemories(ctx.user, ids);
          if (!gone.length) throw new ToolError("None of those ids is remembered (they may be gone already).");
          const missing = ids.filter((id) => !gone.some((m) => m.id === id));
          return {
            text: `Forgot ${gone.length}.${missing.length ? ` Not found: ${missing.join(", ")}.` : ""}`,
            data: gone.map((m) => ({ id: m.id, text: m.text })),
          };
        }
      }
    } catch (err) {
      if (err instanceof MemoryError) throw new ToolError(err.message);
      throw err;
    }
    throw new ToolError("Unknown action.");
  },
});
