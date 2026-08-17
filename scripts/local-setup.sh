#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  if [[ -x /opt/homebrew/bin/node ]] &&
    /opt/homebrew/bin/node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
    export PATH="/opt/homebrew/bin:$PATH"
  else
    echo "Responder requires Node.js 24 or newer." >&2
    exit 1
  fi
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "Missing required command: pnpm" >&2
  exit 1
fi

pnpm install --frozen-lockfile

if [[ "${CONDUCTOR_IS_LOCAL:-1}" == "0" ]]; then
  echo "Cloud workspace dependencies are ready. Local Docker services were skipped."
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Missing required command: docker" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed but not running. Start Docker Desktop and try again." >&2
  exit 1
fi

existing_workspace_path=""
existing_web_port=""
if [[ -s .env.local ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
  existing_workspace_path="${RESPONDER_WORKSPACE_PATH:-}"
  existing_web_port="${CONTROL_PLANE_WEB_PORT:-}"
fi

if [[
  "$existing_workspace_path" == "$repository_root" &&
  "$existing_web_port" =~ ^[0-9]+$ &&
  -z "${CONDUCTOR_PORT:-}"
]]; then
  base_port="$existing_web_port"
else
  base_port="$(node scripts/local-port-block.mjs "$repository_root")"
fi

node scripts/local-write-environment.mjs "$base_port"

set -a
# shellcheck disable=SC1091
source .env.local
set +a

database_is_reachable() {
  node --input-type=module -e '
    import { connect } from "node:net";
    const socket = connect(Number(process.argv[1]), "127.0.0.1");
    socket.setTimeout(500);
    socket.once("connect", () => { socket.destroy(); process.exit(0); });
    socket.once("timeout", () => { socket.destroy(); process.exit(1); });
    socket.once("error", () => process.exit(1));
  ' "$LOCAL_DATABASE_PORT"
}

if ! database_is_reachable; then
  docker compose --env-file .env.local up -d --wait postgres
fi
pnpm db:migrate
pnpm --filter @responder/core exec node scripts/local-bootstrap.mjs

echo
echo "Local Responder environment is ready."
echo "Dashboard:  https://${RESPONDER_PORTLESS_NAME}.${RESPONDER_LOCAL_TLD}"
echo "API:        http://localhost:${CONTROL_PLANE_API_PORT}"
echo "Postgres:   127.0.0.1:${LOCAL_DATABASE_PORT}"
echo
echo "Run pnpm local:dev to start the application at its worktree URL."
