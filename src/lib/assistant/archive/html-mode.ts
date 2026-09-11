/**
 * ARCHIVED — the assistant's "custom page" display mode: the model designed
 * its own HTML answer instead of using a fixed card. Removed when the chat
 * widget dropped its Cards/Page toggle (cards-only now). Kept here, unwired,
 * in case this mode comes back — see also archive/sanitize-html.ts and
 * components/assistant/archive/.
 *
 * To restore: reinstate a `displayMode` parameter on `runAssistant`
 * (agent.ts), pass `HTML_MODE_ADDENDUM` into its system prompt when
 * `mode === "html"`, bind `renderHtmlTool` into the model's tools for that
 * mode only, and re-add the `displayMode` field to the chat route's request
 * schema.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { sanitizeAssistantHtml } from "./sanitize-html";

export type DisplayMode = "cards" | "html";

export const HTML_MODE_ADDENDUM = `

You are in custom-page display mode. After you've gathered the data you need from the
tools above, call render_html exactly once, as your last tool call, with a hand-designed
HTML fragment presenting that specific answer — pick whatever layout actually fits (a
table, a ranked list, a stat grid, grouped sections) rather than defaulting to one shape
every time. Base it only on data you already have from this turn's tool results — don't
restate the schema or invent rows. Then give your normal short prose reply.`;

/**
 * Lets the model design its own presentation instead of fitting the answer
 * into one of the fixed card shapes; sanitize-html.ts strips anything that
 * could execute or phone home before it's ever returned.
 */
export const renderHtmlTool = tool(
  async ({ html }) => ({ type: "html" as const, html: sanitizeAssistantHtml(html) }),
  {
    name: "render_html",
    description:
      "Renders a custom HTML snippet as the visual answer to this question, instead of a predetermined " +
      "card. Design the layout to fit what was actually asked — a table, a stat grid, a ranked list, " +
      "whatever communicates the specific data best — using only the values you already got back from " +
      "other tool calls this turn. Inline CSS only (no <style> block, no external stylesheets); no " +
      "<script>, <iframe>, <form>, or any external resource (images, fonts) — all of those are stripped " +
      "before the page is shown, so don't rely on them. Write a fragment (no <html>/<head>/<body>), and " +
      "call this once you have the data, as your final step.",
    schema: z.object({
      html: z
        .string()
        .min(1)
        .describe("A self-contained HTML fragment using inline style attributes, e.g. <div style=\"...\">…</div>."),
    }),
  },
);
