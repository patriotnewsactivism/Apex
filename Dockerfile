# ─── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

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

# Install all deps (no-frozen-lockfile to tolerate catalog/override drift)
RUN pnpm install --no-frozen-lockfile --ignore-scripts

# Copy source
COPY lib/ ./lib/
COPY packages/ ./packages/

# Build dashboard
RUN pnpm --filter @workspace/dashboard run build

# ─── Stage 2: Production Runtime ──────────────────────────────────────────────
FROM node:20-alpine AS runtime

# git is needed at runtime by @workspace/cicd-automation's ci-workspace.ts,
# which maintains a separate scratch checkout (with devDependencies) to run
# real typecheck/build verification -- isolated from this --prod-only image.
RUN apk add --no-cache git

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

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

# Production deps only (no-frozen-lockfile to tolerate catalog/override drift)
RUN pnpm install --no-frozen-lockfile --ignore-scripts --prod

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

# Create .local dir for SQLite (Railway volume mounts here)
RUN mkdir -p /app/.local

EXPOSE 5000

CMD ["pnpm", "--filter", "@workspace/api-server", "run", "start"]
