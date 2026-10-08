#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'Usage: scripts/smoke.sh <https-origin>\n' >&2
  exit 2
fi
origin=$(python3 - "$1" <<'PY'
import sys
from urllib.parse import urlsplit
u = urlsplit(sys.argv[1])
if u.scheme != 'https' or not u.hostname or u.username or u.password or u.query or u.fragment or u.path not in ('', '/'):
    sys.exit(2)
print(sys.argv[1].rstrip('/'))
PY
)
failed=0
# Anonymous requests without cookies or redirects: journal data must be refused by the app's own
# session guard, health stays open for probes, and login must be configured.
check() {
  local method=$1 path=$2 want=$3 status
  local args=()
  if [[ "$method" == HEAD ]]; then args+=(--head); fi
  if [[ "$method" == POST ]]; then
    args+=(--request POST --header 'Content-Type: application/json' --data "$4")
  fi
  status=$(curl -q --silent --max-time 20 --connect-timeout 10 \
    --proto '=https' --cookie '' --output /dev/null \
    --write-out '%{http_code}' "${args[@]}" "$origin$path") || status=000
  printf '%s %s %s (want %s)\n' "$origin$path" "$method" "$status" "$want"
  if [[ "$status" != "$want" ]]; then failed=1; fi
}
for method in GET HEAD; do
  check "$method" '/api/positions?status=open' 401
  check "$method" '/api/export' 401
  check "$method" '/api/health' 200
done
check GET '/api/auth/session' 401
# A wrong password must be refused with 401: a 500 means AUTH_PASSWORD_HASH is missing on the deployment.
check POST '/api/auth/login' 401 '{"password":"smoke-check-wrong-password"}'
exit "$failed"
