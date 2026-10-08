# Seelie's video renderer (ghcr.io/<owner>/pom-render): HyperFrames compositions (HTML +
# GSAP) seeked frame by frame in chrome-headless-shell and encoded with ffmpeg. It runs
# with no network at all (infra/compose.yml); the OMS hands it jobs through the
# seelie-media volume (worker.mjs). Based on HyperFrames' own render image
# (dist/docker/Dockerfile.render), without its Debian Chromium fallback.
FROM node:24-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates ffmpeg fontconfig unzip \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libpangocairo-1.0-0 \
    libcairo2 libxshmfence1 \
    fonts-noto-core fonts-noto-color-emoji fonts-liberation \
    && rm -rf /var/lib/apt/lists/* && fc-cache -f

WORKDIR /opt/render
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

# The Chrome HyperFrames 0.8.138 is tested with (its CHROME_VERSION): the headless shell
# has BeginFrame, the deterministic capture path.
ARG CHROME_VERSION=152.0.7977.30
RUN npx @puppeteer/browsers install chrome-headless-shell@${CHROME_VERSION} --path /opt/render/browsers \
    && ln -s "$(find /opt/render/browsers -name chrome-headless-shell -type f | head -1)" /usr/local/bin/chrome-headless-shell \
    && /usr/local/bin/chrome-headless-shell --version

ENV NODE_ENV=production \
    PATH=/opt/render/node_modules/.bin:$PATH \
    PRODUCER_HEADLESS_SHELL_PATH=/usr/local/bin/chrome-headless-shell \
    HYPERFRAMES_BROWSER_PATH=/usr/local/bin/chrome-headless-shell \
    HYPERFRAMES_FFMPEG_PATH=/usr/bin/ffmpeg \
    HYPERFRAMES_FFPROBE_PATH=/usr/bin/ffprobe \
    HYPERFRAMES_NO_TELEMETRY=1 \
    DO_NOT_TRACK=1 \
    HYPERFRAMES_NO_UPDATE_CHECK=1 \
    HYPERFRAMES_NO_AUTO_INSTALL=1 \
    HYPERFRAMES_NO_FEEDBACK=1 \
    HYPERFRAMES_SKIP_SKILLS=1 \
    CONTAINER=true \
    SEELIE_MEDIA_DIR=/data/seelie

COPY worker.mjs ./

# The OMS's user id (its Dockerfile), so both read and clear each other's files in the volume.
RUN useradd --system --uid 10001 --create-home render
USER render

ARG RELEASE=dev
ENV RELEASE=$RELEASE
CMD ["node", "/opt/render/worker.mjs"]
