#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repository_root"

: "${PORT:?Portless did not provide an application port}"
: "${PORTLESS_URL:?Portless did not provide a local URL}"

export CONTROL_PLANE_WEB_PORT="$PORT"
export BETTER_AUTH_URL="${PORTLESS_URL%/}"
export CONTROL_PLANE_URL="${PORTLESS_URL%/}"
export RESPONDER_APP_URL="${PORTLESS_URL%/}"

echo "Dashboard: ${PORTLESS_URL%/}"
echo "API:       ${PORTLESS_URL%/}/api"
echo "Worker:    queue consumer (no HTTP port)"
if [[ -n "${RESPONDER_PUBLIC_URL:-}" ]]; then
  echo "Webhooks:  ${RESPONDER_PUBLIC_URL%/}"
  echo "Tunnel:    claiming this worktree on startup"
fi

if [[ -z "${OPENAI_API_KEY:-}" || -z "${DAYTONA_API_KEY:-}" ]]; then
  echo "Note: set OPENAI_API_KEY and DAYTONA_API_KEY before running an investigation."
fi

if [[ -n "${RESPONDER_NGROK_URL:-}" ]]; then
  exec pnpm dev:local:ngrok
fi
exec pnpm dev:local
