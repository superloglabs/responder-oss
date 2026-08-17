#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

if [[ ! -s .env.local ]]; then
  echo "No local environment has been set up in this workspace."
  exit 0
fi

node scripts/local-callback-target.mjs release
docker compose --env-file .env.local down
