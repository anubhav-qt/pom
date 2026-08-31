import { config } from "dotenv";
import type { Config } from "drizzle-kit";

// drizzle-kit runs outside Next.js, so it does not pick up .env.local on its own.
config({ path: ".env.local" });
config({ path: ".env" });

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
} satisfies Config;
