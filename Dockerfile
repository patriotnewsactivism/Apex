# ─── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM mirror.gcr.io/library/node:22-slim AS builder

RUN corepack enable && corepack prepare pnpm@11.19.0 --activate

WORKDIR /app

# Copy workspace config (layer caching)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json .npmrc ./

# Copy all package manifests
COPY lib/db/package.json ./lib/db/
COPY lib/db/tsconfig.json ./lib/db/
COPY packages/health-monitor/package.json ./packages/health-monitor/
COPY packages/health-monitor/tsconfig.json ./packages/health-monitor/
COPY packages/background-jobs/package.json ./packages/background-jobs/
COPY packages/background-jobs/tsconfig.json ./packages/background-jobs/
COPY packages/learning-system/package.json ./packages/learning-system/
COPY packages/learning-system/tsconfig.json ./packages/learning-system/
COPY packages/cicd-automation/package.json ./packages/cicd-automation/
COPY packages/cicd-automation/tsconfig.json ./packages/cicd-automation/
COPY packages/multiapp/package.json ./packages/multiapp/
COPY packages/multiapp/tsconfig.json ./packages/multiapp/
COPY packages/predictive/package.json ./packages/predictive/
COPY packages/predictive/tsconfig.json ./packages/predictive/
COPY packages/core/package.json ./packages/core/
COPY packages/core/tsconfig.json ./packages/core/
COPY packages/agents/package.json ./packages/agents/
COPY packages/agents/tsconfig.json ./packages/agents/
COPY packages/api-server/package.json ./packages/api-server/
COPY packages/api-server/tsconfig.json ./packages/api-server/
COPY packages/dashboard/package.json ./packages/dashboard/
COPY packages/dashboard/tsconfig.json ./packages/dashboard/
COPY packages/convex-backend/package.json ./packages/convex-backend/
COPY packages/convex-backend/tsconfig.json ./packages/convex-backend/
COPY packages/buildmybot-ops/package.json ./packages/buildmybot-ops/
COPY packages/cicd-worker/package.json ./packages/cicd-worker/
COPY packages/cicd-worker/tsconfig.json ./packages/cicd-worker/
COPY packages/orchestrator/package.json ./packages/orchestrator/
COPY packages/orchestrator/tsconfig.json ./packages/orchestrator/
COPY packages/executor/package.json ./packages/executor/
COPY packages/executor/tsconfig.json ./packages/executor/
# NOTE: packages/frontend is deliberately NOT copied. The directory contains
# only a stray src/ — it has no package.json, so pnpm does not treat it as a
# workspace package and nothing depends on it. A `COPY packages/frontend/
# package.json` line was added here on 2026-07-29 alongside the (correct)
# convex-backend fix, and it failed every build since with:
#   failed to compute cache key: "/packages/frontend/package.json": not found
# Reproduced locally with a real `docker build` before removing. If frontend
# ever becomes a real package, add the COPY back together with its package.json.

# Install exactly the dependency graph reviewed in pnpm-lock.yaml.
RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy source
COPY lib/ ./lib/
COPY packages/ ./packages/

# Build dashboard
RUN pnpm --filter @workspace/dashboard run build

# ─── Stage 2: Production Runtime ──────────────────────────────────────────────
# DEBIAN, NOT ALPINE, AND THE REASON IS LOAD-BEARING.
#
# The runtime stage was node:22-alpine while the builder above is node:22-slim.
# That split silently broke semantic memory: @xenova/transformers pulls
# onnxruntime-node, whose prebuilt binary is linked against glibc, and musl has
# no ld-linux-x86-64.so.2 for it to load. Production logged this every 30s to
# two minutes from 2026-08-28 until the base images were matched:
#
#   Local embedding pipeline unavailable: Error loading shared library
#   ld-linux-x86-64.so.2 ... libonnxruntime.so.1.14.0
#   Vector recall failed, falling back to keyword search
#
# The failure was graceful, which is why it survived so long: memory.ts caught
# it and degraded to keyword search, so agents kept working with worse recall
# and nothing ever went red. The invariant to keep is simple -- this stage runs
# `pnpm install` for the same lockfile the builder resolved, so its libc has to
# be the one those prebuilt native modules were built for.
FROM mirror.gcr.io/library/node:22-slim AS runtime

# git is needed at runtime by @workspace/cicd-automation's ci-workspace.ts,
# which maintains a separate scratch checkout (with devDependencies) to run
# real typecheck/build verification -- isolated from this --prod-only image.
#
# chromium is for QA Director's browserCheck tool (real headless-browser QA,
# added 2026-07-22). `pnpm install --ignore-scripts` skips Playwright's
# postinstall browser download, so we install the distro's chromium and point
# Playwright at it via executablePath; both call sites already probe
# /usr/bin/chromium alongside Alpine's /usr/bin/chromium-browser.
#
# Only direct needs are listed. Alpine required nss/freetype/harfbuzz to be
# named by hand; apt resolves them as chromium's own Depends, so spelling them
# out here would only be a second place to get a package name wrong.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium \
        fonts-freefont-ttf \
        git \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.19.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json .npmrc ./
COPY lib/db/package.json ./lib/db/
COPY lib/db/tsconfig.json ./lib/db/
COPY packages/health-monitor/package.json ./packages/health-monitor/
COPY packages/health-monitor/tsconfig.json ./packages/health-monitor/
COPY packages/background-jobs/package.json ./packages/background-jobs/
COPY packages/background-jobs/tsconfig.json ./packages/background-jobs/
COPY packages/learning-system/package.json ./packages/learning-system/
COPY packages/learning-system/tsconfig.json ./packages/learning-system/
COPY packages/cicd-automation/package.json ./packages/cicd-automation/
COPY packages/cicd-automation/tsconfig.json ./packages/cicd-automation/
COPY packages/multiapp/package.json ./packages/multiapp/
COPY packages/multiapp/tsconfig.json ./packages/multiapp/
COPY packages/predictive/package.json ./packages/predictive/
COPY packages/predictive/tsconfig.json ./packages/predictive/
COPY packages/core/package.json ./packages/core/
COPY packages/core/tsconfig.json ./packages/core/
COPY packages/agents/package.json ./packages/agents/
COPY packages/agents/tsconfig.json ./packages/agents/
COPY packages/api-server/package.json ./packages/api-server/
COPY packages/api-server/tsconfig.json ./packages/api-server/
COPY packages/executor/package.json ./packages/executor/
COPY packages/executor/tsconfig.json ./packages/executor/

# Production deps only, still pinned to the reviewed lockfile.
#
# --ignore-scripts is deliberate: no dependency gets to run arbitrary code at
# build time. sharp is the one exception it cannot survive. @xenova/transformers
# requires sharp, sharp ships no binary in its tarball, and its install script is
# what fetches the prebuilt sharp-linux-x64.node. Skipped, the module throws on
# import and semantic memory silently degrades to keyword search -- which is
# exactly what production did until 2026-09-15.
#
# `pnpm rebuild -r sharp` runs that one package's install script and nothing
# else, so the posture holds for every other dependency. It is a separate RUN so
# a failure here is legible instead of being buried in the install layer.
RUN pnpm install --frozen-lockfile --ignore-scripts --prod
RUN pnpm rebuild -r sharp

# Copy built source
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/packages/health-monitor ./packages/health-monitor
COPY --from=builder /app/packages/background-jobs ./packages/background-jobs
COPY --from=builder /app/packages/learning-system ./packages/learning-system
COPY --from=builder /app/packages/cicd-automation ./packages/cicd-automation
COPY --from=builder /app/packages/multiapp ./packages/multiapp
COPY --from=builder /app/packages/predictive ./packages/predictive
COPY --from=builder /app/packages/core ./packages/core
COPY --from=builder /app/packages/agents ./packages/agents
COPY --from=builder /app/packages/api-server ./packages/api-server
COPY --from=builder /app/packages/executor ./packages/executor
COPY --from=builder /app/packages/dashboard/dist ./packages/dashboard/dist

# Root docs ARE the agents' workspace: Sales reads BUSINESS_PROFILE.md, every
# agent references AGENTS.md/APEX_CHARTER.md. Without these the readFile tool
# fails live ("BUSINESS_PROFILE.md doesn't exist") and whole scheduled sweeps
# die on retries. Keep in sync if new workspace docs are added at repo root.
COPY *.md ./

# ─── Build provenance ────────────────────────────────────────────────────────
# Baked in so /health can report exactly which commit is running. Without this,
# a mutable `:latest` tag makes "is my fix actually deployed?" unanswerable
# without a redeploy — which cost hours on 2026-08-19. Pass from CodeBuild:
#   --build-arg APEX_BUILD_SHA=$CODEBUILD_RESOLVED_SOURCE_VERSION
#   --build-arg APEX_BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# Defaults to 'unknown' so an un-updated buildspec still builds (and says so).
ARG APEX_BUILD_SHA=unknown
ARG APEX_BUILD_TIME=
ENV APEX_BUILD_SHA=$APEX_BUILD_SHA
ENV APEX_BUILD_TIME=$APEX_BUILD_TIME

# Local execution sandboxes live here. Durable application state is in
# Supabase Postgres.
RUN mkdir -p /app/.local

EXPOSE 5000

CMD ["pnpm", "--filter", "@workspace/api-server", "run", "start"]
