#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
portless_binary="$repository_root/node_modules/.bin/portless"

: "${CONTROL_PLANE_WEB_PORT:?Missing CONTROL_PLANE_WEB_PORT}"
: "${RESPONDER_PORTLESS_NAME:?Missing RESPONDER_PORTLESS_NAME}"
: "${RESPONDER_LOCAL_TLD:=local}"

if [[ ! -x "$portless_binary" ]]; then
  echo "Portless is not installed. Run pnpm local:setup first." >&2
  exit 1
fi

export PORTLESS_TLD="$RESPONDER_LOCAL_TLD"
if [[ "$RESPONDER_LOCAL_TLD" == "local" ]]; then
  export PORTLESS_LAN=1
fi

# Run Portless outside the Git worktree so it uses the explicit city-keyed name
# instead of deriving a hostname from the branch name.
cd /
# $1 is expanded by the child shell.
# shellcheck disable=SC2016
exec "$portless_binary" run \
  --name "$RESPONDER_PORTLESS_NAME" \
  --force \
  --app-port "$CONTROL_PLANE_WEB_PORT" \
  bash -c 'cd "$1" && exec bash scripts/local-portless-services.sh' \
  responder-local-services \
  "$repository_root"
