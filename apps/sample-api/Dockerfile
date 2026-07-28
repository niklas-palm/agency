# Sample downstream API container (local demo target for integrations). Same app
# runs on Lambda in prod (see infra/lib/sample-api-stack.ts); only the entrypoint
# differs (Node server here).
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json* ./
COPY apps/sample-api/package.json apps/sample-api/
RUN npm install --workspace @agency/sample-api --include-workspace-root || npm install

COPY tsconfig.base.json ./
COPY apps/sample-api apps/sample-api

EXPOSE 8686
CMD ["npx", "tsx", "apps/sample-api/src/server.ts"]
