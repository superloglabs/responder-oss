#!/usr/bin/env bash

# This file is sourced by local commands. Keep all variables function-local.
responder_load_runtime_environment() {
  local responder_repository_root="$1"
  local responder_shared_repository_root="${CONDUCTOR_ROOT_PATH:-}"
  local responder_provider_environment_file="${RESPONDER_PROVIDER_ENV_FILE:-}"
  local responder_public_origin

  if [[ ! -s "$responder_repository_root/.env.local" ]]; then
    echo "Missing .env.local. Run pnpm local:setup first." >&2
    return 1
  fi

  set -a
  # shellcheck disable=SC1091
  source "$responder_repository_root/.env.local"

  if [[ -z "$responder_shared_repository_root" ]]; then
    responder_shared_repository_root="$(
      dirname "$(git -C "$responder_repository_root" rev-parse --path-format=absolute --git-common-dir)"
    )"
  fi

  if [[ -n "$responder_provider_environment_file" ]]; then
    # shellcheck disable=SC1090
    source "$responder_provider_environment_file"
  else
    if [[
      -n "$responder_shared_repository_root" &&
      "$responder_shared_repository_root" != "$responder_repository_root" &&
      -s "$responder_shared_repository_root/.env.providers.local"
    ]]; then
      # shellcheck disable=SC1091
      source "$responder_shared_repository_root/.env.providers.local"
    fi
    if [[ -s "$responder_repository_root/.env.providers.local" ]]; then
      # shellcheck disable=SC1091
      source "$responder_repository_root/.env.providers.local"
    fi
  fi

  if [[
    -n "$responder_shared_repository_root" &&
    "$responder_shared_repository_root" != "$responder_repository_root" &&
    -s "$responder_shared_repository_root/.env.tunnel.local"
  ]]; then
    # shellcheck disable=SC1091
    source "$responder_shared_repository_root/.env.tunnel.local"
  fi
  if [[ -s "$responder_repository_root/.env.tunnel.local" ]]; then
    # shellcheck disable=SC1091
    source "$responder_repository_root/.env.tunnel.local"
  fi

  if [[ -n "${RESPONDER_NGROK_URL:-}" ]]; then
    export RESPONDER_PUBLIC_URL="${RESPONDER_NGROK_URL%/}"
  fi

  if [[ -n "${RESPONDER_PUBLIC_URL:-}" ]]; then
    responder_public_origin="${RESPONDER_PUBLIC_URL%/}"
    if [[ ! "$responder_public_origin" =~ ^https://[^/]+$ ]]; then
      echo "RESPONDER_PUBLIC_URL must be an HTTPS origin without a path." >&2
      set +a
      return 1
    fi
    export RESPONDER_PUBLIC_URL="$responder_public_origin"
  fi
  set +a
}

# Self-hosted Grafana context runs the pinned grafana/mcp-grafana binary in the
# worker for investigations and in the control plane for automations. The
# first start downloads and verifies it into .tools/.
responder_use_mcp_grafana() {
  local responder_repository_root="$1"
  local responder_mcp_grafana_binary

  if [[ -n "${MCP_GRAFANA_BINARY:-}" ]]; then
    return 0
  fi
  if responder_mcp_grafana_binary="$(node "$responder_repository_root/scripts/install-mcp-grafana.mjs")"; then
    export MCP_GRAFANA_BINARY="$responder_mcp_grafana_binary"
  else
    echo "Note: mcp-grafana could not be installed. Self-hosted Grafana context" >&2
    echo "      is unavailable until scripts/install-mcp-grafana.mjs succeeds." >&2
  fi
}
