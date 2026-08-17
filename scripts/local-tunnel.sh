#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

# shellcheck disable=SC1091
source scripts/local-runtime-environment.sh
responder_load_runtime_environment "$repository_root"

command="${1:-status}"
shift || true
exec node scripts/local-callback-target.mjs "$command" "$@"
