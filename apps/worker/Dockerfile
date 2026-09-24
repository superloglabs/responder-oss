FROM node:24-bookworm-slim AS mcp-grafana

# Self-hosted Grafana context runs grafana/mcp-grafana. Keep the version and
# checksums in sync with scripts/install-mcp-grafana.mjs.
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
ENV TSX_DISABLE_CACHE=1
ENV MCP_GRAFANA_BINARY=/usr/local/bin/mcp-grafana

RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

COPY --from=mcp-grafana /opt/mcp-grafana/mcp-grafana /usr/local/bin/mcp-grafana
COPY --from=mcp-grafana /opt/mcp-grafana/LICENSE /usr/share/licenses/mcp-grafana/LICENSE

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
