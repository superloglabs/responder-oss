#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

# Load .env.local and .env.providers.local so DATABASE_URL and the worker
# credentials are present when this script is started directly (pnpm dev:worker,
# dev:full, dev:local), not only through pnpm local:dev which already loads them.
# shellcheck disable=SC1091
source scripts/local-runtime-environment.sh
responder_load_runtime_environment "$repository_root"

# The worker is a pg-boss queue consumer, not an HTTP service. The control plane
# enqueues investigations onto the shared queue and this process runs them in a
# Daytona sandbox with the OpenAI agent runtime, matching production.
if [[ -z "${OPENAI_API_KEY:-}" || -z "${DAYTONA_API_KEY:-}" ]]; then
  echo "Note: set OPENAI_API_KEY and DAYTONA_API_KEY (usually in .env.providers.local)" >&2
  echo "      before running an investigation. The worker will start either way, but" >&2
  echo "      jobs fail until both are present." >&2
fi

# Self-hosted Grafana context runs the pinned grafana/mcp-grafana binary. The
# first start downloads and verifies it into .tools/.
if [[ -z "${MCP_GRAFANA_BINARY:-}" ]]; then
  if MCP_GRAFANA_BINARY="$(node scripts/install-mcp-grafana.mjs)"; then
    export MCP_GRAFANA_BINARY
  else
    unset MCP_GRAFANA_BINARY
    echo "Note: mcp-grafana could not be installed. Self-hosted Grafana context" >&2
    echo "      is unavailable until scripts/install-mcp-grafana.mjs succeeds." >&2
  fi
fi

pnpm --filter @responder/worker start &
worker_pid=$!
stopped=0
trap 'stopped=1; kill -TERM "$worker_pid" 2>/dev/null || true' INT TERM

status=0
wait "$worker_pid" || status=$?

# Only a genuine crash is worth a structured line. A signal-initiated shutdown
# (Ctrl+C, concurrently -k) leaves wait returning 128+signum, which is normal.
if [[ "$stopped" -eq 0 && "$status" -ne 0 ]]; then
  printf '{"event":"worker_exited","exitCode":%d}\n' "$status" >&2
fi
exit "$status"
