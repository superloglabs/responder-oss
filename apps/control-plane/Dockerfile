FROM node:24-bookworm-slim

ENV NODE_ENV=production
ENV PORT=3000

RUN corepack enable

WORKDIR /app

ADD --checksum=sha256:e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3 \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  /app/certs/global-bundle.pem

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY apps/control-plane/package.json apps/control-plane/package.json
COPY packages/core/package.json packages/core/package.json

RUN pnpm install \
  --filter @responder/control-plane... \
  --frozen-lockfile \
  --prod

COPY apps/control-plane apps/control-plane
COPY packages/core packages/core
COPY drizzle drizzle
RUN chmod 0555 /app/certs && chmod 0444 /app/certs/global-bundle.pem

WORKDIR /app/apps/control-plane

USER node

EXPOSE 3000

CMD ["node", "--import", "tsx", "server/production.ts"]
