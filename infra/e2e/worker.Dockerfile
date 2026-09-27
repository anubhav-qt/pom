# The edge Worker under wrangler dev, for the end-to-end test (compose.yml).
FROM node:24-bookworm-slim
WORKDIR /edge
# To reach Render over TLS when the ThinkPad side can't answer.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
ENV WRANGLER_SEND_METRICS=false CI=1
COPY package.json package-lock.json ./
RUN npm ci
COPY edge.ts failover.ts tsconfig.json wrangler.jsonc ./
EXPOSE 8787
CMD ["npx", "wrangler", "dev", "--ip", "0.0.0.0", "--port", "8787", \
     "--var", "THINKPAD_ORIGIN:http://gate:8080", "--var", "WWW_FALLBACK_ORIGIN:http://vercel:3000", "--var", "EDGE_KEY:e2e-edge-key"]
