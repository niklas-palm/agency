# Control-plane container. Same image locally and (conceptually) in prod; only
# the entrypoint differs (Node server here, Lambda adapter in prod).
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY apps/control-plane/package.json apps/control-plane/
RUN npm install --workspace @agency/control-plane --include-workspace-root || npm install

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/control-plane apps/control-plane
COPY scripts scripts

EXPOSE 8787
# Ensure tables exist (idempotent), then start the API.
CMD ["sh", "-c", "npx tsx scripts/ensure-tables.ts && npx tsx apps/control-plane/src/server.ts"]
