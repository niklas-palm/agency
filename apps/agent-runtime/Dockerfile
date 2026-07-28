# Agent runtime container. AgentCore requires linux/arm64.
FROM --platform=linux/arm64 node:22-slim AS base
WORKDIR /app

# Basic tools the base coding toolset (run_bash) may reach for.
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash git curl ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install workspace deps. We copy the whole monorepo manifest set so npm can
# resolve the @agency/shared workspace dependency.
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY apps/agent-runtime/package.json apps/agent-runtime/
RUN npm install --omit=dev --workspace @agency/agent-runtime --include-workspace-root || npm install
# tsx is the entrypoint runner but a devDependency (omitted above). Bake it into
# the image explicitly so `npx tsx` resolves it locally and never reaches the npm
# registry at container start - the isolated (no-egress) runtime has no internet,
# so a startup download would hang the microVM forever.
RUN npm install --no-save tsx@4.19.2

# Copy sources.
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/agent-runtime apps/agent-runtime

ENV WORK_ROOT=/tmp/agency-work
EXPOSE 8080
# Invoke the baked-in tsx binary directly (never `npx`, which can hit the network).
CMD ["node", "node_modules/tsx/dist/cli.mjs", "apps/agent-runtime/src/server.ts"]
