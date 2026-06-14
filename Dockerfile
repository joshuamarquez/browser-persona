FROM node:22-bookworm-slim AS base
WORKDIR /app

# Needed for Playwright's --with-deps browser install
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install workspace manifests first for layer caching
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
COPY packages/event-normalizer/package.json ./packages/event-normalizer/
COPY packages/pattern-miner/package.json ./packages/pattern-miner/
COPY packages/playwright-executor/package.json ./packages/playwright-executor/

RUN npm install

# Linux Chromium for in-container runs (headless automation inside Docker)
RUN npx playwright install --with-deps chromium

COPY packages ./packages
COPY apps/api ./apps/api

ENV DOCKER_CONTAINER=true
ENV PLAYWRIGHT_HEADLESS=true

EXPOSE 3001

# Monorepo packages are TypeScript source; tsx runs them directly
CMD ["npx", "tsx", "apps/api/src/index.ts"]
