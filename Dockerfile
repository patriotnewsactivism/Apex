# ─── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /app

# Copy workspace config (layer caching)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json .npmrc ./

# Copy all package manifests
COPY lib/db/package.json ./lib/db/
COPY lib/db/tsconfig.json ./lib/db/
COPY packages/core/package.json ./packages/core/
COPY packages/core/tsconfig.json ./packages/core/
COPY packages/agents/package.json ./packages/agents/
COPY packages/agents/tsconfig.json ./packages/agents/
COPY packages/api-server/package.json ./packages/api-server/
COPY packages/api-server/tsconfig.json ./packages/api-server/
COPY packages/dashboard/package.json ./packages/dashboard/
COPY packages/dashboard/tsconfig.json ./packages/dashboard/

# Install all deps
RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy source
COPY lib/ ./lib/
COPY packages/ ./packages/

# Build dashboard
RUN pnpm --filter @workspace/dashboard run build

# ─── Stage 2: Production Runtime ──────────────────────────────────────────────
FROM node:20-alpine AS runtime

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json .npmrc ./
COPY lib/db/package.json ./lib/db/
COPY lib/db/tsconfig.json ./lib/db/
COPY packages/core/package.json ./packages/core/
COPY packages/core/tsconfig.json ./packages/core/
COPY packages/agents/package.json ./packages/agents/
COPY packages/agents/tsconfig.json ./packages/agents/
COPY packages/api-server/package.json ./packages/api-server/
COPY packages/api-server/tsconfig.json ./packages/api-server/

# Production deps only
RUN pnpm install --frozen-lockfile --ignore-scripts --prod

# Copy built source
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/packages/core ./packages/core
COPY --from=builder /app/packages/agents ./packages/agents
COPY --from=builder /app/packages/api-server ./packages/api-server
COPY --from=builder /app/packages/dashboard/dist ./packages/dashboard/dist

# Create .local dir for SQLite (Railway volume mounts here)
RUN mkdir -p /app/.local

EXPOSE 5000

CMD ["pnpm", "--filter", "@workspace/api-server", "run", "start"]
