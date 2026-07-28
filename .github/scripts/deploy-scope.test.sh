#!/usr/bin/env bash
# Tests for deploy-scope.sh. Run: bash .github/scripts/deploy-scope.test.sh
#
# This logic decides whether a backend change gets deployed at all, so it is worth pinning.
# The cases below are the ones that actually bit during development.
set -uo pipefail
cd "$(dirname "$0")"

pass=0
fail=0

expect() { # expect <want> <label> <paths...>
  local want="$1" label="$2"
  shift 2
  local got
  got=$(printf '%s\n' "$@" | bash deploy-scope.sh)
  if [ "$got" = "$want" ]; then
    printf '  ok   %-52s %s\n' "$label" "$got"
    pass=$((pass + 1))
  else
    printf '  FAIL %-52s got %s, want %s\n' "$label" "$got" "$want"
    fail=$((fail + 1))
  fi
}

echo "deploy-scope:"

# --- the fast path ---
expect true "one web component" apps/web/src/views/AgentDetail.tsx
expect true "several web files" apps/web/src/App.tsx apps/web/src/components.tsx
expect true "web index.html" apps/web/index.html
expect true "a public asset" apps/web/public/favicon.svg

# --- must be FULL: mixed changes. An inline `! grep -qv` version got these WRONG,
#     silently skipping the backend deploy. ---
expect false "web + packages/shared" apps/web/src/App.tsx packages/shared/src/index.ts
expect false "web + control-plane" apps/web/src/App.tsx apps/control-plane/src/routes.ts
expect false "web + infra" apps/web/src/App.tsx infra/lib/web-stack.ts
expect false "web + runtime" apps/web/src/App.tsx apps/agent-runtime/src/run.ts

# --- must be FULL: web BUILD inputs, not web source ---
expect false "apps/web/package.json (dep bump)" apps/web/package.json
expect false "apps/web/vite.config.ts (prod auth guard)" apps/web/vite.config.ts
expect false "apps/web/tsconfig.json" apps/web/tsconfig.json
expect false "apps/web/.env.development" apps/web/.env.development

# --- must be FULL: everything else ---
expect false "backend only" apps/control-plane/src/routes.ts
expect false "runtime only" apps/agent-runtime/src/config.ts
expect false "infra only" infra/lib/data-stack.ts
expect false "shared only" packages/shared/src/openapi.ts
expect false "docs only" README.md docs/deployment.md
expect false "the workflow itself" .github/workflows/deploy.yml
expect false "root lockfile" package-lock.json
expect false "no changes at all" ""

# --- adjacent-prefix traps: a directory that merely STARTS like a web path ---
expect false "apps/web-experiment/src/x.tsx" apps/web-experiment/src/x.tsx
expect false "apps/web/srcfoo.ts" apps/web/srcfoo.ts

echo "  $pass passed, $fail failed"
[ "$fail" = "0" ]
