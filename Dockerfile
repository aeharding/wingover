# syntax=docker/dockerfile:1

# The versioned PWA container: builds the static web bundle, then serves it
# with Caddy. This image IS the deploy unit — the wingover repo publishes it to
# GHCR on release; the infra pulls it. No server paths, no SSH, no rsync here.

# ---- Stage 1: build the static bundle ------------------------------------
# glibc (bookworm-slim) over musl: rolldown/esbuild/react-compiler ship
# prebuilt native binaries and glibc is the lower-risk target for them.
FROM node:24-bookworm-slim AS build

WORKDIR /app

# Corepack pins pnpm from package.json's `packageManager` field (10.33.4).
# The prompt env var keeps the first download non-interactive in CI.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Install against the lockfile first so this layer caches across source edits.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# The rest of the source (src/, public/, index.html, vite/tsconfig, dev/).
COPY . .

# The origin-restricted MapKit token is baked into the client bundle. It is
# public and origin-locked, so passing it as a build-arg is safe.
ARG VITE_MAPKIT_TOKEN_WINGOVER_APP
ENV VITE_MAPKIT_TOKEN_WINGOVER_APP=${VITE_MAPKIT_TOKEN_WINGOVER_APP}

# tsc --noEmit && vite build -> /app/dist
RUN pnpm build

# ---- Stage 2: serve the bundle -------------------------------------------
FROM caddy:2-alpine AS serve

COPY --from=build /app/dist /srv
COPY deploy/pwa.Caddyfile /etc/caddy/Caddyfile

EXPOSE 80

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
