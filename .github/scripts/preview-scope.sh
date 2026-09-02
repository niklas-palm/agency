#!/usr/bin/env bash
# Decide whether a PR can be represented by a FRONTEND-ONLY preview.
#
# Reads changed paths on STDIN, one per line. Prints "true" or "false".
#
# A preview deploys nothing but a fresh SPA bundle against the ALREADY-DEPLOYED backend, so
# it can only tell the truth about a change that lives entirely in apps/web. A PR that also
# touches the control plane, the runtime, shared wire types or infra would render a console
# whose backend half isn't there yet - which is worse than no preview, because it looks like
# a real one.
#
# Markdown anywhere is allowed alongside it: a doc is not a build input for anything, and
# rule 4 of CLAUDE.md means a UI change normally ARRIVES with doc edits - a rule that refused
# those would refuse most real frontend PRs.
#
# This is a DIFFERENT question from deploy-scope.sh, which asks "can prod skip
# CloudFormation?" and therefore excludes apps/web/package.json and vite.config.ts (a dep
# bump or a build-config change may alter what the bundle needs). For a preview those are
# fine: the whole app is rebuilt from source either way. Hence a separate rule, and separate
# tests - the two are easy to conflate and answer differently.
set -euo pipefail

web_only=true
has_web=false

while IFS= read -r path; do
  [ -n "$path" ] || continue
  case "$path" in
    # Anything under apps/web - source, build config, deps, index.html. The trailing slash
    # matters: `apps/web-something/…` is not this workspace.
    apps/web/*) has_web=true ;;
    # Documentation, wherever it lives. Only ever read by humans.
    *.md) ;;
    *) web_only=false ;;
  esac
done

# A preview needs something to LOOK at, so at least one web file must have changed. This also
# covers the empty case (a PR with no diff at all).
if [ "$has_web" = false ]; then web_only=false; fi

echo "$web_only"
