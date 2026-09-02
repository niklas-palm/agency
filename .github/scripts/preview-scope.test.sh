#!/usr/bin/env bash
# Tests for preview-scope.sh. Run: bash .github/scripts/preview-scope.test.sh
#
# A wrong "true" here publishes a preview that LOOKS like the change but is running against a
# backend that doesn't have the other half of it - the failure mode a preview exists to
# prevent. Kept separate from deploy-scope.test.sh because the two rules answer different
# questions and deliberately disagree about apps/web/package.json.
set -uo pipefail
cd "$(dirname "$0")"

pass=0
fail=0

expect() { # expect <want> <label> <paths...>
  local want="$1" label="$2"
  shift 2
  local got
  got=$(printf '%s\n' "$@" | bash preview-scope.sh)
  if [ "$got" = "$want" ]; then
    printf '  ok   %-52s %s\n' "$label" "$got"
    pass=$((pass + 1))
  else
    printf '  FAIL %-52s got %s, want %s\n' "$label" "$got" "$want"
    fail=$((fail + 1))
  fi
}

echo "preview-scope:"

# --- previewable: the whole change is the SPA ---
expect true "one web component" apps/web/src/views/AgentDetail.tsx
expect true "several web files" apps/web/src/App.tsx apps/web/src/styles.css
expect true "web index.html" apps/web/index.html
expect true "a public asset" apps/web/public/favicon.svg
# Unlike deploy-scope: a build input is still just an SPA rebuild for a preview.
expect true "apps/web/package.json (dep bump)" apps/web/package.json
expect true "apps/web/tailwind.config.js" apps/web/tailwind.config.js
expect true "apps/web/vite.config.ts" apps/web/vite.config.ts
# Rule 4 means a UI change normally arrives WITH its doc edits, so markdown rides along.
expect true "web + CLAUDE.md" apps/web/src/App.tsx CLAUDE.md
expect true "web + docs" apps/web/src/styles.css docs/architecture.md README.md

# --- nothing to look at: previewing this would publish an unchanged console ---
expect false "docs only" CLAUDE.md docs/deployment.md
expect false "README only" README.md

# --- NOT previewable: the change has a half the preview can't deploy ---
expect false "web + packages/shared" apps/web/src/App.tsx packages/shared/src/index.ts
expect false "web + control-plane" apps/web/src/App.tsx apps/control-plane/src/routes.ts
expect false "web + infra" apps/web/src/App.tsx infra/lib/web-stack.ts
expect false "web + runtime" apps/web/src/App.tsx apps/agent-runtime/src/run.ts
expect false "web + the preview workflow itself" apps/web/src/App.tsx .github/workflows/preview.yml
expect false "backend only" apps/control-plane/src/routes.ts
expect false "docs + backend" README.md apps/control-plane/src/routes.ts
expect false "root lockfile" package-lock.json
expect false "no changes at all" ""

# --- adjacent-prefix trap: a directory that merely STARTS like the web workspace ---
expect false "apps/web-experiment/src/x.tsx" apps/web-experiment/src/x.tsx

echo "  $pass passed, $fail failed"
[ "$fail" = "0" ]
