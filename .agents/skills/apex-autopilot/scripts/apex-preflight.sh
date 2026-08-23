#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${APEX_BASE_URL:-https://apex.donmatthews.live}"
TOKEN="${APEX_ADMIN_TOKEN:-}"

pretty() {
  if command -v jq >/dev/null 2>&1; then jq .; else cat; fi
}

get_public() {
  local path="$1"
  printf '\n== GET %s%s ==\n' "$BASE_URL" "$path"
  curl -fsS --connect-timeout 10 --max-time 30 "$BASE_URL$path" | pretty
}

get_auth() {
  local path="$1"
  if [[ -z "$TOKEN" ]]; then
    printf '\n== SKIP %s (APEX_ADMIN_TOKEN not set) ==\n' "$path"
    return 0
  fi
  printf '\n== GET %s%s ==\n' "$BASE_URL" "$path"
  curl -fsS --connect-timeout 10 --max-time 30 \
    -H "Authorization: Bearer $TOKEN" \
    "$BASE_URL$path" | pretty
}

echo "APEX read-only preflight"
echo "Base URL: $BASE_URL"

get_public "/health"
get_auth "/api/agents"
get_auth "/api/tokens"

cat <<'EOF'

Preflight complete.
Next: compare /health build.sha with the intended source commit, then inspect
only the routes/logs relevant to any observed failure. This script performs
no writes and does not print the admin token.
EOF
