#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repository_root"

if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  if [[ -x /opt/homebrew/bin/node ]]; then
    export PATH="/opt/homebrew/bin:$PATH"
  fi
fi

portless_binary="$repository_root/node_modules/.bin/portless"
if [[ ! -x "$portless_binary" ]]; then
  echo "Run pnpm install before configuring Portless." >&2
  exit 1
fi

routes="$($portless_binary list 2>&1 || true)"
if [[ "$routes" == *"Active routes:"* ]]; then
  echo "Portless still has active routes. Stop all local workspaces first:" >&2
  echo "$routes" >&2
  exit 1
fi

"$portless_binary" proxy stop >/dev/null 2>&1 || true
"$portless_binary" proxy start --lan -p 443
"$portless_binary" trust

echo
echo "Portless is ready for https://responder.<city>.local URLs."
