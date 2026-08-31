/**
 * End-to-end check of the AI assistant: real Gemini call, real tool-calling,
 * real database query — against whatever is actually in the local database.
 *
 *   npm run check:assistant
 *   npm run check:assistant -- "What's my best seller this month?"
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const question = process.argv[2] ?? "How much revenue have we made in the last 30 days, and what's late right now?";

  console.log(`Model: ${process.env.GEMINI_MODEL || "gemini-3.6-flash"}`);
  console.log(`Question: "${question}"\n`);

  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set in .env.local");
    process.exit(1);
  }

  const { runAssistant } = await import("../src/lib/assistant/agent");

  const started = Date.now();
  const result = await runAssistant([], question);
  const ms = Date.now() - started;

  console.log(`Reply (${ms}ms):`);
  console.log(`  ${result.reply}\n`);

  console.log(`Cards returned: ${result.cards.length}`);
  for (const card of result.cards) {
    console.log(`  [${card.type}]`, JSON.stringify(card, null, 2).slice(0, 500));
  }

  if (result.cards.length === 0) {
    console.log("\n(No cards — either the model answered without a tool call, or every call errored.)");
  }

  console.log("\n✓ Assistant responded successfully.");
  process.exit(0);
}

main().catch((err) => {
  console.error("\n✗ Assistant check failed:\n", err);
  process.exit(1);
});
