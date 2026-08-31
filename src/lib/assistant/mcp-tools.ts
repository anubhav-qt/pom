import path from "node:path";

import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import type { DynamicStructuredTool } from "@langchain/core/tools";

/**
 * Loads the paribelle-oms-db MCP server (mcp/server.ts) as LangChain tools —
 * get_schema and run_sql — so the assistant can answer questions the fixed
 * tools in tools.ts don't cover. Spawned once per server process and reused;
 * `npx tsx` (not `npm run`) so nothing but MCP's own JSON-RPC ever hits the
 * child's stdout.
 */

let toolsPromise: Promise<DynamicStructuredTool[]> | null = null;

export function getMcpAssistantTools(): Promise<DynamicStructuredTool[]> {
  if (!toolsPromise) {
    const client = new MultiServerMCPClient({
      mcpServers: {
        "paribelle-oms-db": {
          command: "npx",
          args: ["tsx", path.join(process.cwd(), "mcp", "server.ts")],
        },
      },
    });
    toolsPromise = client.getTools().catch((err) => {
      // A tool source failing to load shouldn't take the whole assistant down —
      // the fixed tools in tools.ts still cover the common questions.
      console.error("[assistant] failed to load paribelle-oms-db MCP tools:", err);
      toolsPromise = null; // allow a retry on the next call instead of caching the failure forever
      return [];
    });
  }
  return toolsPromise;
}
