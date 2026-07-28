#!/usr/bin/env bash
# Decide whether a change is UI-ONLY (fast path: build + s3 sync + CDN invalidate) or needs a
# full `cdk deploy --all`.
#
# Reads changed paths on STDIN, one per line. Prints "true" or "false".
#
# The rule is deliberately CONSERVATIVE: UI-only requires that EVERY changed path is web
# source. Anything else - one file - forces the full path. Getting this wrong in the safe
# direction costs a few minutes; getting it wrong the other way silently fails to deploy a
# backend change, which is much worse to debug.
#
# Notably NOT ui-only:
#   packages/shared/**   - feeds the runtime image and the Lambdas as well as the SPA
#   apps/web/package.json, vite.config.ts, tsconfig*  - build inputs; a dep bump can change
#                          what the bundle needs, and vite.config carries the prod auth guard
#   infra/**             - CloudFormation has to run
#
# This lives in a script, not inline in the YAML, because it needs tests: an earlier inline
# `! grep -qv` version silently classified a mixed web+shared change as UI-only.
set -euo pipefail

ui_only=true
any=false

while IFS= read -r path; do
  [ -n "$path" ] || continue
  any=true
  case "$path" in
    # Web SOURCE only. Trailing-slash patterns so `apps/web/src-other` can't sneak through.
    apps/web/src/* | apps/web/public/* | apps/web/index.html) ;;
    *) ui_only=false ;;
  esac
done

# No changed paths at all (an empty push, a merge commit with no diff): take the full path
# rather than guess. Cheap, and it can't under-deploy.
if [ "$any" = false ]; then ui_only=false; fi

echo "$ui_only"
