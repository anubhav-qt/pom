import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";

import { ASSISTANT_DB_TOOLS } from "./db-tools";
import { ASSISTANT_TOOL_MAP, ASSISTANT_TOOLS, renderHtmlTool } from "./tools";

export type DisplayMode = "cards" | "html";

const BASE_SYSTEM_PROMPT = `You are the built-in data assistant inside Paribelle OMS, an
order-management tool for a small clothing seller on Amazon (and eventually other
marketplaces). You are talking directly to the business owner.

Rules:
- Never invent a number. Every figure you state must come from a tool call — if you
  don't have a tool that answers the question, say so plainly instead of guessing.
- Prefer calling a tool over asking a clarifying question. If the user doesn't give a
  time range, default to "30d".
- Prefer the purpose-built tools (get_summary_stats, get_status_breakdown, get_top_skus,
  get_revenue_trend, search_orders, get_late_orders) whenever one of them fits the
  question — they're reviewed, parameterized queries and the more reliable source of an
  answer. Only fall back to get_schema + run_sql when the question genuinely isn't
  covered by those (e.g. an ad-hoc breakdown by city, a question spanning tables no
  fixed tool joins). When you do use run_sql, call get_schema first, write a single
  read-only SELECT, and double-check it actually answers what was asked before reporting
  the result — there is no second reviewer on a query you write yourself.
- After tool results come back, answer in short, plain prose — one to three sentences.
  The numbers themselves are shown to the user below your reply, so do not repeat every
  figure back in a wall of text; add the one insight the raw numbers don't say on their
  own (e.g. "cancellations are higher than usual" — only if the tool result actually
  shows that).
- If a tool result is empty or an error, say so honestly rather than papering over it.
- You cannot take any action (no packing, no order changes) — you can only look things
  up and report them.`;

const HTML_MODE_ADDENDUM = `

You are in custom-page display mode. After you've gathered the data you need from the
tools above, call render_html exactly once, as your last tool call, with a hand-designed
HTML fragment presenting that specific answer — pick whatever layout actually fits (a
table, a ranked list, a stat grid, grouped sections) rather than defaulting to one shape
every time. Base it only on data you already have from this turn's tool results — don't
restate the schema or invent rows. Then give your normal short prose reply.`;

function systemPrompt(mode: DisplayMode): string {
  return mode === "html" ? BASE_SYSTEM_PROMPT + HTML_MODE_ADDENDUM : BASE_SYSTEM_PROMPT;
}

/** How many think→act cycles one question is allowed before it gets cut off. */
const MAX_STEPS = 4;

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface AssistantCard {
  type: string;
  [key: string]: unknown;
}

export interface AssistantResult {
  reply: string;
  cards: AssistantCard[];
}

async function chatModel(mode: DisplayMode) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set — add it to .env.local to enable the assistant.");
  }
  const model = new ChatGoogleGenerativeAI({
    apiKey,
    model: process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
    temperature: 0.2,
  });
  // render_html is only offered in "html" mode — in "cards" mode the fixed
  // React components own presentation, and there's nothing for the model to
  // render itself.
  const tools =
    mode === "html"
      ? [...ASSISTANT_TOOLS, renderHtmlTool, ...ASSISTANT_DB_TOOLS]
      : [...ASSISTANT_TOOLS, ...ASSISTANT_DB_TOOLS];
  return model.bindTools(tools);
}

function tryParseRunSqlResult(text: string): AssistantCard | null {
  try {
    const parsed = JSON.parse(text) as { sql?: string; rowCount?: number; rows?: Record<string, unknown>[] };
    if (!Array.isArray(parsed.rows)) return null;
    return {
      type: "table",
      sql: parsed.sql ?? "",
      rowCount: parsed.rowCount ?? parsed.rows.length,
      columns: parsed.rows.length > 0 ? Object.keys(parsed.rows[0]) : [],
      rows: parsed.rows,
    };
  } catch {
    return null;
  }
}

function contentToText(content: AIMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : "text" in part ? part.text : ""))
      .join("");
  }
  return "";
}

/**
 * Runs one question through Gemini with tool-calling bound, executing our own
 * safe query tools as the model asks for them, and stops either when the
 * model produces a final answer with no further tool calls or after
 * MAX_STEPS — a model stuck in a call loop should fail fast, not hang the
 * request indefinitely.
 */
export async function runAssistant(
  history: ChatTurn[],
  question: string,
  displayMode: DisplayMode = "cards",
): Promise<AssistantResult> {
  const chat = await chatModel(displayMode);
  // Every tool here has its own zod-typed `invoke` signature, so the union
  // isn't statically callable; narrow the merged map to the one shared
  // surface we actually use. Safe because every tool re-validates its args
  // against its own schema regardless of this cast.
  const toolMap = {
    ...ASSISTANT_TOOL_MAP,
    render_html: renderHtmlTool,
    ...Object.fromEntries(ASSISTANT_DB_TOOLS.map((t) => [t.name, t])),
  } as unknown as Record<string, { invoke: (args: unknown) => Promise<unknown> }>;

  const messages: BaseMessage[] = [
    new SystemMessage(systemPrompt(displayMode)),
    // Only recent turns — this is a lookup tool, not a long-memory chat, and a
    // shorter context keeps latency and cost predictable.
    ...history.slice(-8).map((h) => (h.role === "user" ? new HumanMessage(h.content) : new AIMessage(h.content))),
    new HumanMessage(question),
  ];

  const cards: AssistantCard[] = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const response = (await chat.invoke(messages)) as AIMessage;
    messages.push(response);
    if (process.env.ASSISTANT_DEBUG) {
      console.error(`[assistant] step ${step} tool_calls:`, response.tool_calls?.length ?? 0, "content:", response.content);
    }

    if (!response.tool_calls || response.tool_calls.length === 0) {
      return { reply: contentToText(response.content) || "I don't have an answer for that.", cards };
    }

    for (const call of response.tool_calls) {
      const toolFn = toolMap[call.name];
      let result: unknown;

      if (!toolFn) {
        result = { error: `No such tool: ${call.name}` };
      } else {
        try {
          // Fixed tools and the freeform DB tools share the same `invoke(args)`
          // surface, so both dispatch through the one map above. Every tool
          // re-validates `call.args` against its own schema regardless.
          result = await toolFn.invoke(call.args);
        } catch (err) {
          if (process.env.ASSISTANT_DEBUG) console.error(`[assistant] tool ${call.name} threw:`, err);
          result = { error: err instanceof Error ? err.message : String(err) };
        }
      }

      if (result && typeof result === "object" && "type" in result && !("error" in result)) {
        cards.push(result as AssistantCard);
      } else if (call.name === "run_sql" && typeof result === "string") {
        // run_sql returns raw JSON text (no fixed shape — the query is ad-hoc),
        // not one of our typed cards. Turn its rows into a generic "table" card
        // so the UI has something to render besides prose.
        const parsed = tryParseRunSqlResult(result);
        if (parsed) cards.push(parsed);
      }

      messages.push(new ToolMessage(JSON.stringify(result), call.id ?? call.name, call.name));
    }
  }

  return {
    reply: "That question needed more steps than I'm allowed to take — try asking something narrower.",
    cards,
  };
}
