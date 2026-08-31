import { neon } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

/**
 * Drizzle's two drivers have different generic types but the same query surface.
 * Everything in the app uses that shared surface, so this narrows to it rather
 * than leaking the driver choice into every call site.
 */
type Database = ReturnType<typeof drizzleNeon<typeof schema>> &
  Partial<ReturnType<typeof drizzlePg<typeof schema>>>;

let instance: Database | null = null;

/**
 * Neon is served over HTTP and needs its own driver; anything else is a normal
 * Postgres over TCP. Choosing by hostname means local Docker development and
 * serverless production run the same code with only DATABASE_URL differing.
 */
function isNeon(url: string) {
  return url.includes("neon.tech") || url.includes("neon.build");
}

function connect(): Database {
  if (instance) return instance;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set — copy .env.example to .env.local and fill it in.");
  }

  if (isNeon(url)) {
    instance = drizzleNeon(neon(url), { schema }) as Database;
  } else {
    // A small pool: local development, and any self-hosted deploy, share this
    // path. Serverless on Neon never reaches it.
    instance = drizzlePg(new Pool({ connectionString: url, max: 5 }), { schema }) as Database;
  }

  return instance;
}

/**
 * Connects on first use rather than at import time. `next build` imports every
 * route module to collect metadata, and a build should not need a reachable
 * database — nor should a missing env var fail the build instead of the request
 * that actually needed it.
 */
export const db = new Proxy({} as Database, {
  get(_target, prop, receiver) {
    return Reflect.get(connect(), prop, receiver);
  },
});

export { schema };
