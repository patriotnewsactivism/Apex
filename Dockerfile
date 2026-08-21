# ─── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM public.ecr.aws/docker/library/node:20-alpine AS builder

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
FROM public.ecr.aws/docker/library/node:20-alpine AS runtime

# git is needed at runtime by @workspace/cicd-automation's ci-workspace.ts,
# which maintains a separate scratch checkout (with devDependencies) to run
# real typecheck/build verification -- isolated from this --prod-only image.
#
# chromium + its runtime libs are for QA Director's new browserCheck tool
# (real headless-browser QA, added 2026-07-22). This is Alpine, and
# Playwright's own bundled Chromium build needs glibc (doesn't work here) --
# and the existing `pnpm install --ignore-scripts` already skips Playwright's
# postinstall browser download anyway. So we use Alpine's native musl-built
# chromium package instead and point Playwright at it via executablePath.
RUN apk add --no-cache git chromium nss freetype freetype-dev harfbuzz ca-certificates ttf-freefont

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

# Production deps only, still pinned to the reviewed lockfile.
RUN pnpm install --frozen-lockfile --ignore-scripts --prod

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
