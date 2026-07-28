#!/usr/bin/env bash
# Assert the built SPA was compiled against the real API, and carries no dev-only flag.
#
# Vite inlines env at BUILD time, so a missing VITE_API_URL doesn't fail the build - it
# produces a bundle that falls back to `/api` (wrong origin, every request 404s) and, if
# VITE_AUTH_DISABLED ever leaked in, one that skips login entirely. Both are invisible until
# a user opens the page, which is far too late. One grep here closes both.
set -euo pipefail

API_URL="${1:?usage: assert-bundle.sh <api-url>}"
DIST="${2:-apps/web/dist}"

[ -d "$DIST" ] || { echo "::error::$DIST does not exist - the build didn't run" >&2; exit 1; }

# The API host must appear in some emitted asset.
HOST=$(printf '%s' "$API_URL" | sed -E 's#^https?://##; s#/.*$##')
if ! grep -rqF "$HOST" "$DIST"; then
  echo "::error::the built bundle does not contain the API host '$HOST' - VITE_API_URL was not baked in" >&2
  exit 1
fi

# The auth opt-out must never reach a deployed bundle. vite.config.ts already refuses a
# production build with it set; this is the belt-and-braces check on the artifact itself.
if grep -rqF "VITE_AUTH_DISABLED" "$DIST" 2>/dev/null; then
  echo "::error::the built bundle references VITE_AUTH_DISABLED - refusing to publish a login-free console" >&2
  exit 1
fi

echo "bundle OK: contains $HOST, no dev auth flag"
