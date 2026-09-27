# syntax=docker/dockerfile:1
# The sync: two-way copy between the ThinkPad's Postgres and the cloud copies,
# the readiness answer the gate asks for, pruning, and nightly backups.
# Built by CI as ghcr.io/<owner>/paribelle-sync; see infra/README.md.

FROM node:24-bookworm-slim AS base
# pg_dump/pg_restore 17 from the PostgreSQL apt repository (Debian's are 15, too old
# for a 17 server), and age to encrypt backups.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl age \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-17 \
  && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./

# The test suite, run against the stand-ins in test/compose.yml.
FROM base AS test
RUN npm ci
COPY . .
CMD ["npm", "test"]

FROM base AS runtime
RUN npm ci --omit=dev && npm cache clean --force
COPY policy.json ./
COPY src ./src
ARG RELEASE=dev
ENV RELEASE=$RELEASE NODE_ENV=production TZ=Asia/Kolkata
RUN mkdir -p /data/backups && chown -R node:node /data
USER node
EXPOSE 8090
CMD ["node", "src/main.ts"]
