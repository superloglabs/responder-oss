#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repository_root"

if [[ ! -s .env.local ]]; then
  bash scripts/local-setup.sh
fi

# shellcheck disable=SC1091
source scripts/local-runtime-environment.sh
responder_load_runtime_environment "$repository_root"

if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  if [[ -x /opt/homebrew/bin/node ]] &&
    /opt/homebrew/bin/node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
    export PATH="/opt/homebrew/bin:$PATH"
  else
    echo "Responder requires Node.js 24 or newer." >&2
    exit 1
  fi
fi

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

exec bash scripts/local-portless.sh
