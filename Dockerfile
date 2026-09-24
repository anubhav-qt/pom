# syntax=docker/dockerfile:1
#
# Three stages that matter:
#   build    — full node_modules + source, runs `next build`
#   tools    — the build stage kept as-is, for one-off jobs (schema, seed)
#   runtime  — only Next's standalone output; this is what gets deployed
#
#   docker build -t paribelle/oms .                  # runtime image (last stage)
#   docker build -t paribelle/oms-tools --target tools .

# ---- deps ----
# Its own stage so the npm ci layer is reused whenever only source changes.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build ----
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- tools ----
# drizzle-kit and tsx are devDependencies, so schema and scripts/seed.ts
# can't run from the slim runtime image. DATABASE_URL comes from the
# environment; drizzle.config.ts only falls back to .env files, which the
# .dockerignore keeps out.
#
# The default is `push`, not `migrate`: the schema is maintained with db:push
# (see scripts/apply-migration.ts), so drizzle/ is not a complete history and
# only schema.ts can build an empty database. Never point this at production.
FROM build AS tools
CMD ["npx", "drizzle-kit", "push"]

# ---- runtime ----
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN useradd --system --uid 10001 oms

# standalone/ holds server.js plus only the node_modules the server actually
# imports. Static assets are left out of it by design and copied separately.
COPY --from=build --chown=oms:oms /app/.next/standalone ./
COPY --from=build --chown=oms:oms /app/.next/static ./.next/static

USER oms
EXPOSE 3000
CMD ["node", "server.js"]
