FROM node:24-bookworm-slim

ENV NODE_ENV=production
ENV TSX_DISABLE_CACHE=1

RUN corepack enable

WORKDIR /app

ADD --checksum=sha256:e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3 \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  /app/certs/global-bundle.pem

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

RUN chmod 0555 /app/certs && chmod 0444 /app/certs/global-bundle.pem

WORKDIR /app/apps/worker

USER node

CMD ["node", "--import", "tsx", "src/index.ts"]
