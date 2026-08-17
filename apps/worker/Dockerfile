FROM node:26-bookworm-slim

ENV NODE_ENV=production
ENV TSX_DISABLE_CACHE=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/core/package.json packages/core/package.json

RUN pnpm install \
  --filter @responder/worker... \
  --frozen-lockfile \
  --prod

COPY apps/worker apps/worker
COPY packages/core packages/core

WORKDIR /app/apps/worker

USER node

CMD ["node", "--import", "tsx", "src/index.ts"]
