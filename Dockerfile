# ─── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

# Install pnpm via corepack
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /app

# Copy all workspace config files first (maximize layer caching)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./

# Copy all package manifests (needed before install)
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

# Install ALL dependencies (including devDeps for build)
# --ignore-scripts to avoid Replit-specific post-install hooks
RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy full source
COPY lib/ ./lib/
COPY packages/ ./packages/

# Build dashboard
RUN pnpm --filter @workspace/dashboard run build

# ─── Stage 2: Production Runtime ──────────────────────────────────────────────
FROM node:20-alpine AS runtime

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /app

# Copy workspace manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY lib/db/package.json ./lib/db/
COPY lib/db/tsconfig.json ./lib/db/
COPY packages/core/package.json ./packages/core/
COPY packages/core/tsconfig.json ./packages/core/
COPY packages/agents/package.json ./packages/agents/
COPY packages/agents/tsconfig.json ./packages/agents/
COPY packages/api-server/package.json ./packages/api-server/
COPY packages/api-server/tsconfig.json ./packages/api-server/

# Production install only
RUN pnpm install --frozen-lockfile --ignore-scripts --prod

# Copy source (tsx runs TypeScript directly — no compile step needed)
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/packages/core ./packages/core
COPY --from=builder /app/packages/agents ./packages/agents
COPY --from=builder /app/packages/api-server ./packages/api-server
COPY --from=builder /app/packages/dashboard/dist ./packages/dashboard/dist

# Persist SQLite DB across deploys
RUN mkdir -p /app/.local
VOLUME ["/app/.local"]

EXPOSE 5000

CMD ["pnpm", "--filter", "@workspace/api-server", "run", "start"]
