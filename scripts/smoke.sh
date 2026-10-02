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
headers=$(mktemp)
trap 'rm -f "$headers"' EXIT
failed=0
for path in / /api/health; do
  for method in GET HEAD; do
    url="$origin$path"
    args=()
    if [[ "$method" == HEAD ]]; then args+=(--head); fi
    status=$(curl -q --silent --max-time 20 --connect-timeout 10 \
      --proto '=https' --cookie '' --dump-header "$headers" --output /dev/null \
      --write-out '%{http_code}' "${args[@]}" "$url") || status=000
    signature=unmatched
    if [[ "$status" == 302 ]]; then
      if python3 - "$headers" <<'PY'
import sys
from urllib.parse import urlsplit
headers = open(sys.argv[1]).read().splitlines()
locations = [line.split(':', 1)[1].strip() for line in headers if line.lower().startswith('location:')]
if len(locations) != 1:
    sys.exit(1)
u = urlsplit(locations[0])
sys.exit(0 if u.scheme == 'https' and u.netloc == 'vercel.com' and u.path == '/sso-api' else 1)
PY
      then signature='redirect:vercel.com/sso-api'; fi
    fi
    printf '%s %s %s %s\n' "$url" "$method" "$status" "$signature"
    if [[ "$signature" == unmatched ]]; then failed=1; fi
  done
done
exit "$failed"
