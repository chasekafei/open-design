# Build + runtime both use bookworm (glibc). Do not mix alpine build with
# debian runtime — native addons such as better-sqlite3 would break.
ARG NODE_IMAGE=docker.io/library/node:24-bookworm-slim
ARG RUNTIME_IMAGE=docker.io/library/node:24-bookworm-slim
# Pin Hermes the same way as https://github.com/praveen-ks-2001/hermes-agent-template
# Override at build time: docker build --build-arg HERMES_REF=v2026.7.20 ...
ARG HERMES_REF=v2026.7.20

FROM ${NODE_IMAGE} AS build

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG http_proxy
ARG https_proxy
ARG no_proxy
ARG NO_PROXY

ENV HTTP_PROXY=${HTTP_PROXY}
ENV HTTPS_PROXY=${HTTPS_PROXY}
ENV http_proxy=${http_proxy}
ENV https_proxy=${https_proxy}
ENV no_proxy=${no_proxy}
ENV NO_PROXY=${NO_PROXY}
ENV CI=true

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts/postinstall.mjs ./scripts/postinstall.mjs
COPY packages ./packages
COPY tools ./tools
# postinstall builds @open-design/daemon (needs tsconfig, bin, and src).
# Copy only daemon — not the full apps/ tree — so web source changes do not
# invalidate the dependency-install layer.
COPY apps/daemon/package.json apps/daemon/tsconfig.json ./apps/daemon/
COPY apps/daemon/bin ./apps/daemon/bin
COPY apps/daemon/src ./apps/daemon/src
COPY apps/web/package.json ./apps/web/package.json
COPY e2e/package.json ./e2e/package.json
RUN corepack enable && \
    corepack prepare pnpm@10.33.2 --activate && \
    pnpm install --frozen-lockfile

COPY apps ./apps
RUN pnpm --filter @open-design/daemon build && \
    pnpm --filter @open-design/web build && \
    pnpm --filter @open-design/daemon deploy --legacy --prod /app/deploy/daemon && \
    pnpm store prune && \
    rm -rf \
      /root/.cache \
      /root/.local/share/pnpm/store \
      /app/deploy/daemon/node_modules/.cache \
      /app/deploy/daemon/node_modules/@types \
      /app/deploy/daemon/node_modules/.pnpm/@types+* \
      /app/deploy/daemon/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/deps \
      /app/deploy/daemon/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/src && \
    find /app/deploy/daemon/node_modules -type d \( \
      -name test -o \
      -name tests -o \
      -name "__tests__" -o \
      -name docs -o \
      -name doc -o \
      -name example -o \
      -name examples -o \
      -name ".github" \
    \) -prune -exec rm -rf '{}' + && \
    find /app/deploy/daemon/node_modules -type f \( \
      -name "*.md" -o \
      -name "*.markdown" -o \
      -name "*.d.ts" -o \
      -name "*.d.cts" -o \
      -name "*.d.mts" -o \
      -name "*.map" -o \
      -name "*.tsbuildinfo" -o \
      -name "binding.gyp" \
    \) -delete

# Stage-2 assets — copied into the build stage so the runtime stage
# can pull them via --from=build instead of reaching back into the
# build context.  This lets the Dockerfile work when the build context
# differs from the repo root (Railway, CI runners with a subdirectory
# context, etc.).
COPY skills ./skills
COPY design-templates ./design-templates
COPY design-systems ./design-systems
COPY craft ./craft
COPY prompt-templates ./prompt-templates
COPY assets ./assets
COPY plugins/_official ./plugins/_official

FROM ${RUNTIME_IMAGE}

ARG HERMES_REF

# tini = PID 1 zombie reaper (same as hermes-agent-template).
# gosu replaces Alpine su-exec for dropping to the open-design user.
# python3 + build deps are needed for Hermes' editable install / vision.
# Keep runtime libs (libjpeg62-turbo, zlib1g); only purge -dev + compilers.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      tini gosu poppler-utils bash git curl ca-certificates \
      python3 python3-dev \
      gcc g++ libjpeg62-turbo libjpeg62-turbo-dev zlib1g zlib1g-dev && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd --system --gid 1001 open-design && \
    useradd --system --uid 1001 --gid open-design \
      --home-dir /home/open-design --create-home \
      --shell /usr/sbin/nologin open-design

# Claude Code agent runtime (headless, driven by the daemon via
# --output-format stream-json).  The daemon auto-detects `claude`
# on PATH at startup.  Requires ANTHROPIC_AUTH_TOKEN (and optionally
# ANTHROPIC_BASE_URL for DeepSeek / custom endpoints) set as env
# vars on the container.
RUN npm install -g @anthropic-ai/claude-code && \
    claude --version && \
    echo "Claude Code installed at $(command -v claude)"

# Hermes Agent (ACP CLI) — same clone+uv pattern as
# https://github.com/praveen-ks-2001/hermes-agent-template, but:
#   * venv uses distro python3 so the open-design user can exec it
#     (uv-managed Pythons under /root are not readable after gosu)
#   * skip React dashboard / messaging gateway extras — OD only needs
#     `hermes acp --accept-hooks`
#   * include [acp] (agent-client-protocol deps — without this, `hermes acp`
#     exits immediately with "ACP dependencies not installed")
#   * include vision (Pillow) so oversized images don't brick sessions
COPY --from=ghcr.io/astral-sh/uv:python3.12-bookworm-slim /usr/local/bin/uv /usr/local/bin/uv
RUN git clone --depth 1 --branch "${HERMES_REF}" \
      https://github.com/NousResearch/hermes-agent.git /opt/hermes-agent && \
    cd /opt/hermes-agent && \
    uv venv /opt/hermes-venv --python /usr/bin/python3 && \
    uv pip install --python /opt/hermes-venv/bin/python --no-cache -e ".[acp,vision]" && \
    printf 'docker\n' > /opt/hermes-agent/.install_method && \
    ln -sf /opt/hermes-venv/bin/hermes /usr/local/bin/hermes && \
    hermes --version && \
    echo "Hermes installed at $(command -v hermes)" && \
    rm -rf /opt/hermes-agent/.git /root/.cache /root/.local/share/uv && \
    apt-get update && \
    apt-get purge -y --auto-remove python3-dev gcc g++ \
      libjpeg62-turbo-dev zlib1g-dev && \
    rm -rf /var/lib/apt/lists/* && \
    chmod -R a+rX /opt/hermes-agent /opt/hermes-venv

WORKDIR /app
COPY --from=build --chown=open-design:open-design /app/deploy/daemon ./apps/daemon
COPY --from=build --chown=open-design:open-design /app/apps/web/out ./apps/web/out
COPY --from=build --chown=open-design:open-design /app/skills ./skills
COPY --from=build --chown=open-design:open-design /app/design-templates ./design-templates
COPY --from=build --chown=open-design:open-design /app/design-systems ./design-systems
COPY --from=build --chown=open-design:open-design /app/craft ./craft
COPY --from=build --chown=open-design:open-design /app/prompt-templates ./prompt-templates
COPY --from=build --chown=open-design:open-design /app/assets/frames ./assets/frames
COPY --from=build --chown=open-design:open-design /app/assets/community-pets ./assets/community-pets
# Plan §3.J4 / spec §23.3.5 — bundled atom plugins registered on
# daemon boot. The directory contains `plugins/_official/atoms/<atom>/`
# pairs (SKILL.md + open-design.json); registerBundledPlugins() walks
# it on startup so the container ships with first-party atoms reachable
# via the same registry path third-party plugins use.
COPY --from=build --chown=open-design:open-design /app/plugins/_official ./plugins/_official

COPY deploy/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh && \
    mkdir -p /app/.od && \
    chown -R open-design:open-design /app

ENV NODE_ENV=production
# Tell the daemon where to find Claude Code / Hermes so detection skips
# PATH scanning after gosu drops privileges.
ENV CLAUDE_BIN=/usr/local/bin/claude
ENV HERMES_BIN=/usr/local/bin/hermes
# Default Hermes config/session root — entrypoint remaps under OD_DATA_DIR
# when that env is set (Volume). Redeploy-safe secrets still belong in
# Railway Variables (OPENAI_API_KEY + OPENAI_BASE_URL, etc.).
ENV HERMES_HOME=/app/.od/hermes
# The 192 MB heap limit from docker-compose is removed here because
# Claude Code / Hermes need significantly more memory.  On Railway
# the default V8 heap is fine; constrain via --max-old-space-size if
# you deploy to a smaller instance.
ENV OD_BIND_HOST=0.0.0.0
ENV OD_PORT=7456

EXPOSE 7456

# Stay as root so the entrypoint can fix volume permissions (platforms
# like Railway mount volumes as root). Privileges drop to open-design
# inside docker-entrypoint.sh via gosu.
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["/app/docker-entrypoint.sh"]
