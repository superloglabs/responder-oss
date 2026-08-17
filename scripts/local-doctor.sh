#!/usr/bin/env bash

set -uo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repository_root" || exit 1

failures=0

ok() {
  echo "ok    $1"
}

info() {
  echo "info  $1"
}

fail() {
  echo "fail  $1" >&2
  failures=$((failures + 1))
}

if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; then
  if [[ -x /opt/homebrew/bin/node ]] &&
    /opt/homebrew/bin/node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
    export PATH="/opt/homebrew/bin:$PATH"
  fi
fi

if node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; then
  ok "Node.js $(node --version)"
else
  fail "Responder requires Node.js 24 or newer."
fi

for command_name in pnpm docker ngrok lsof pgrep; do
  if command -v "$command_name" >/dev/null 2>&1; then
    ok "$command_name is installed"
  else
    fail "$command_name is not installed"
  fi
done

if docker info >/dev/null 2>&1; then
  ok "Docker is running"
else
  fail "Docker is not running"
fi

if [[ ! -s .env.local ]]; then
  fail ".env.local is missing; run pnpm local:setup"
else
  # shellcheck disable=SC1091
  source scripts/local-runtime-environment.sh
  if responder_load_runtime_environment "$repository_root"; then
    ok "local, provider, and tunnel environment files load"
  else
    fail "local environment files are invalid"
  fi
fi

if [[ "${RESPONDER_WORKSPACE_PATH:-}" == "$repository_root" ]]; then
  ok ".env.local belongs to this worktree"
else
  fail ".env.local belongs to another worktree; run pnpm local:setup"
fi

ports=(
  "${CONTROL_PLANE_WEB_PORT:-}"
  "${CONTROL_PLANE_API_PORT:-}"
  "${LOCAL_DATABASE_PORT:-}"
)
valid_ports=1
for port in "${ports[@]}"; do
  if [[ ! "$port" =~ ^[0-9]+$ ]] || ((port < 1 || port > 65535)); then
    valid_ports=0
  fi
done
if [[ "$valid_ports" == "1" ]] &&
  [[ "$(printf '%s\n' "${ports[@]}" | sort -u | wc -l | tr -d ' ')" == "3" ]]; then
  ok "web, API, and Postgres ports are distinct"
else
  fail "local service ports are missing, invalid, or duplicated"
fi

check_group() {
  local label="$1"
  shift
  local missing=()
  local key
  for key in "$@"; do
    if [[ -z "${!key:-}" ]]; then
      missing+=("$key")
    fi
  done
  if [[ "${#missing[@]}" == "0" ]]; then
    ok "$label configuration is present"
  else
    fail "$label is missing: ${missing[*]}"
  fi
}

check_group "GitHub App" \
  GITHUB_APP_ID GITHUB_APP_SLUG GITHUB_APP_PRIVATE_KEY \
  GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET
check_group "Slack App" SLACK_CLIENT_ID SLACK_CLIENT_SECRET SLACK_SIGNING_SECRET
check_group "Sentry App" \
  SENTRY_APP_SLUG SENTRY_CLIENT_ID SENTRY_CLIENT_SECRET
check_group "Linear App" LINEAR_CLIENT_ID LINEAR_CLIENT_SECRET
check_group "model execution" OPENAI_API_KEY DAYTONA_API_KEY

if [[ -n "${DATADOG_WEBHOOK_SECRET:-}" ]]; then
  ok "Datadog webhook verification is configured"
else
  info "DATADOG_WEBHOOK_SECRET is unset; API-key connections still work"
fi

if [[ -n "${RESPONDER_PUBLIC_URL:-}" ]]; then
  ok "shared public origin is ${RESPONDER_PUBLIC_URL}"
else
  fail "RESPONDER_NGROK_URL or RESPONDER_PUBLIC_URL is missing"
fi

if ngrok config check >/dev/null 2>&1; then
  ok "ngrok is authenticated"
else
  fail "ngrok is not authenticated"
fi

portless_binary="$repository_root/node_modules/.bin/portless"
if [[ ! -x "$portless_binary" ]]; then
  fail "Portless is not installed; run pnpm local:setup"
else
  local_url="$($portless_binary get "${RESPONDER_PORTLESS_NAME:-responder.local}" --no-worktree 2>/dev/null || true)"
  expected_url="https://${RESPONDER_PORTLESS_NAME:-responder.local}.${RESPONDER_LOCAL_TLD:-local}"
  if [[ "$local_url" == "$expected_url" ]]; then
    ok "Portless is configured for $expected_url"
  else
    fail "Portless reports ${local_url:-no URL}; run pnpm local:trust for $expected_url"
  fi
fi

# The expression is JavaScript, not shell interpolation.
# shellcheck disable=SC2016
if node --input-type=module -e '
  const response = await fetch(`http://127.0.0.1:${process.argv[1]}/api/health`, {
    signal: AbortSignal.timeout(1000),
  }).catch(() => null);
  process.exit(response?.ok ? 0 : 1);
' "${CONTROL_PLANE_WEB_PORT:-0}"; then
  ok "this worktree is running and healthy"
else
  info "this worktree is configured but not currently running"
fi

echo
if [[ "$failures" == "0" ]]; then
  echo "Responder local development is fully configured."
else
  echo "$failures local development check(s) failed." >&2
  exit 1
fi
