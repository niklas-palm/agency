#!/usr/bin/env bash
# Post-deploy smoke test: cheap, credential-free assertions that the deployment is actually
# serving. Not the E2E - that invokes real models and costs money (run it on demand).
#
# What each check is for:
#   /health 200          - the Lambda is wired to the API and starts (a bad env var 500s here)
#   /agents 401          - auth is ON. A 200 would mean an AUTH_DISABLED bundle reached prod.
#   /openapi.json 200    - the public contract is served
#   SPA 200 + real API   - CloudFront serves the bundle, and it points at this deployment
set -euo pipefail

api() {
  aws cloudformation describe-stacks --stack-name AgencyControlPlane \
    --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue | [0]" --output text
}
site() {
  aws cloudformation describe-stacks --stack-name AgencyWeb \
    --query "Stacks[0].Outputs[?OutputKey=='SiteUrl'].OutputValue | [0]" --output text
}

API=$(api)
SITE=$(site)
fail=0

check() { # check <label> <expected-code> <url>
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 --retry 3 --retry-delay 5 "$3" || echo "000")
  if [ "$code" = "$2" ]; then
    printf '  ok   %-24s %s\n' "$1" "$code"
  else
    printf '  FAIL %-24s got %s, want %s\n' "$1" "$code" "$2"
    fail=1
  fi
}

echo "smoke-testing $API"
check "GET /health" 200 "$API/health"
check "GET /openapi.json" 200 "$API/openapi.json"
# The important one: unauthenticated management access must be refused.
check "GET /agents (no auth)" 401 "$API/agents"

echo "smoke-testing $SITE"
check "GET / (SPA)" 200 "$SITE/"

# The served bundle must reference THIS deployment's API, not a stale one.
HOST=$(printf '%s' "$API" | sed -E 's#^https?://##; s#/.*$##')
# Downloaded to a file, not piped: `grep -q` exits on first match and closes the pipe,
# which makes curl fail with "Failure writing output to destination" and turns a PASSING
# check into a failure.
ASSET=$(curl -sS --max-time 20 "$SITE/" | grep -oE '/assets/[A-Za-z0-9._-]+\.js' | head -1 || true)
BUNDLE=$(mktemp)
trap 'rm -f "$BUNDLE"' EXIT
if [ -n "$ASSET" ] && curl -sS --max-time 30 -o "$BUNDLE" "$SITE$ASSET" && grep -qF "$HOST" "$BUNDLE"; then
  echo "  ok   served bundle targets $HOST"
else
  echo "  FAIL served bundle does not reference $HOST (stale or misbuilt SPA)"
  fail=1
fi

[ "$fail" = "0" ] || { echo "::error::smoke test failed" >&2; exit 1; }
echo "smoke test passed"
