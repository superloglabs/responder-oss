FROM node:24-bookworm-slim AS mcp-grafana

# Automations reach self-hosted Grafana through grafana/mcp-grafana. Keep the
# version and checksums in sync with scripts/install-mcp-grafana.mjs.
ARG TARGETARCH
ADD --checksum=sha256:3ef1c7a66aab3ba149de53681d72ea58244baa41331eb3aed9cdd2f68acc0db7 \
  https://github.com/grafana/mcp-grafana/releases/download/v1.5.1/mcp-grafana_Linux_x86_64.tar.gz \
  /tmp/mcp-grafana-amd64.tar.gz
ADD --checksum=sha256:6ae7bd9d89879f9332b76ba95865bed1aa59e89ce2a30f9bbb91d67e8dfb6b57 \
  https://github.com/grafana/mcp-grafana/releases/download/v1.5.1/mcp-grafana_Linux_arm64.tar.gz \
  /tmp/mcp-grafana-arm64.tar.gz
RUN mkdir -p /opt/mcp-grafana \
  && tar -xzf "/tmp/mcp-grafana-${TARGETARCH}.tar.gz" -C /opt/mcp-grafana \
    mcp-grafana LICENSE \
  && chmod 0555 /opt/mcp-grafana/mcp-grafana

FROM node:24-bookworm-slim

ENV NODE_ENV=production
ENV PORT=3000
ENV MCP_GRAFANA_BINARY=/usr/local/bin/mcp-grafana

COPY --from=mcp-grafana /opt/mcp-grafana/mcp-grafana /usr/local/bin/mcp-grafana
COPY --from=mcp-grafana /opt/mcp-grafana/LICENSE /usr/share/licenses/mcp-grafana/LICENSE

RUN corepack enable

WORKDIR /app

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

WORKDIR /app/apps/control-plane

USER node

EXPOSE 3000

CMD ["node", "--import", "tsx", "server/production.ts"]
