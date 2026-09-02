#!/usr/bin/env bash
# Resolve the deployed stack outputs a web build and a fast UI sync need, and write them to
# $GITHUB_OUTPUT.
#
# Read from CloudFormation rather than repo variables on purpose: these values change when a
# stack is recreated, and a stale repo variable produces an SPA silently pointed at the wrong
# API. The source of truth is the deployment. (One exception, below: with a custom domain the
# API host is `api.<domain>` by construction, and on the deploy that introduces it the stack
# output still names the old host.)
#
# A missing stack is NOT an error - on a first-ever deploy nothing exists yet, so every value
# is empty and the caller skips the web build (see deploy.yml). That's what makes the
# first run work without a special case. Anything ELSE going wrong IS an error: see cfn().
set -euo pipefail

out() { echo "$1=$2" >>"${GITHUB_OUTPUT:-/dev/stdout}"; }

# One CloudFormation query against one stack, or "" when that stack doesn't exist yet.
#
# `describe-stacks` EXITS NON-ZERO for an absent stack, and under `set -e` + `pipefail` that
# status escapes the command substitution and kills the whole script - so "a missing stack is
# not an error" was never actually true. It took down the deploy that introduced
# AgencyWebPreview: the outputs step died looking for the stack that same deploy would have
# created, so the deploy was self-blocking, and `2>/dev/null` meant the only evidence left in
# the log was a bare `exit 254`.
#
# ONLY "does not exist" becomes an empty value. A real failure - no credentials, a denied
# call, throttling - still fails the step loudly, because resolving it to "" would hand the
# caller a bundle built against nothing (or, on the fast path, a sync to nowhere).
cfn() {
  local stack="$1" query="$2" value status=0 err
  err=$(mktemp)
  value=$(aws cloudformation describe-stacks --stack-name "$stack" \
    --query "$query" --output text 2>"$err") || status=$?
  if [ "$status" -ne 0 ]; then
    if grep -qi 'does not exist' "$err"; then
      rm -f "$err"
      return 0
    fi
    cat "$err" >&2
    rm -f "$err"
    echo "::error::describe-stacks $stack failed (exit $status) - see the error above." >&2
    return "$status"
  fi
  rm -f "$err"
  # `| [0]` on a key that isn't in the stack's outputs prints the literal "None".
  [ "$value" = "None" ] || printf '%s\n' "$value"
}

# One value from one stack, or "" if the stack or key is absent.
get() {
  cfn "$1" "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue | [0]"
}

API_URL=$(get AgencyControlPlane ApiUrl)
SITE_BUCKET=$(get AgencyWeb SiteBucketName)
DISTRIBUTION_ID=$(get AgencyWeb DistributionId)
USER_POOL_ID=$(get AgencyAuth UserPoolId)
WEB_CLIENT_ID=$(get AgencyAuth WebClientId)

# With a custom domain configured, the API host is `api.<domain>` by construction, so prefer it
# over the output. On the deploy that FIRST introduces the domain the deployed output still names
# the execute-api endpoint, and a bundle built against that host would be stale the moment the
# deploy lands - smoke.sh compares the served bundle against the post-deploy ApiUrl and would
# rightly fail it.
#
# The domain is read from infra/cdk.context.json, which is the single source of truth for
# per-deployment config (CI materializes it from AGENCY_CDK_CONTEXT before this runs).
CONTEXT_FILE="${CONTEXT_FILE:-infra/cdk.context.json}"
if [ -f "$CONTEXT_FILE" ]; then
  DOMAIN=$(python3 -c "
import json,sys
try:
    print(json.load(open('$CONTEXT_FILE')).get('domainName') or '')
except Exception:
    print('')
")
  [ -n "$DOMAIN" ] && API_URL="https://api.${DOMAIN}"
fi

# The Cognito output keys have drifted before; fall back to a contains-match so a rename
# doesn't silently produce an SPA that can't sign in.
if [ -z "$USER_POOL_ID" ]; then
  USER_POOL_ID=$(cfn AgencyAuth \
    "Stacks[0].Outputs[?contains(OutputKey,'UserPoolId')].OutputValue | [0]")
fi
if [ -z "$WEB_CLIENT_ID" ]; then
  WEB_CLIENT_ID=$(cfn AgencyAuth \
    "Stacks[0].Outputs[?contains(OutputKey,'Web') && contains(OutputKey,'Client')].OutputValue | [0]")
fi

out api_url "$API_URL"
out site_bucket "$SITE_BUCKET"
out distribution_id "$DISTRIBUTION_ID"
out user_pool_id "$USER_POOL_ID"
out web_client_id "$WEB_CLIENT_ID"

echo "resolved: api=${API_URL:-<none>} bucket=${SITE_BUCKET:-<none>} dist=${DISTRIBUTION_ID:-<none>} pool=${USER_POOL_ID:-<none>} client=${WEB_CLIENT_ID:-<none>}"

# PR previews (AgencyWebPreview, opt-in `-c previews=true`). Read here rather than in the
# preview workflow so there is ONE place that knows how CI finds deployed values - and so the
# deployment's hostname reaches CI from the stack, never from a tracked workflow file.
# Absent when previews aren't deployed, which is why they're outside REQUIRE_ALL.
PREVIEW_BUCKET=$(get AgencyWebPreview PreviewBucketName)
PREVIEW_DISTRIBUTION_ID=$(get AgencyWebPreview PreviewDistributionId)
PREVIEW_HOST_SUFFIX=$(get AgencyWebPreview PreviewHostSuffix)

out preview_bucket "$PREVIEW_BUCKET"
out preview_distribution_id "$PREVIEW_DISTRIBUTION_ID"
out preview_host_suffix "$PREVIEW_HOST_SUFFIX"

# On the FAST path these four must all exist - it syncs straight to the bucket, so an empty
# value would mean syncing nowhere or building against the wrong origin. The caller sets
# REQUIRE_ALL=1 there.
if [ "${REQUIRE_ALL:-0}" = "1" ]; then
  for pair in "api_url:$API_URL" "site_bucket:$SITE_BUCKET" "distribution_id:$DISTRIBUTION_ID" \
    "user_pool_id:$USER_POOL_ID" "web_client_id:$WEB_CLIENT_ID"; do
    if [ -z "${pair#*:}" ]; then
      echo "::error::missing stack output '${pair%%:*}' - is the stack deployed? Run the full deploy first." >&2
      exit 1
    fi
  done
fi

# The preview workflow needs the preview trio as well as the build inputs. A missing one
# means AgencyWebPreview isn't deployed (previews are opt-in), and syncing "nowhere" would
# otherwise look like a successful publish.
if [ "${REQUIRE_PREVIEW:-0}" = "1" ]; then
  for pair in "preview_bucket:$PREVIEW_BUCKET" "preview_distribution_id:$PREVIEW_DISTRIBUTION_ID" \
    "preview_host_suffix:$PREVIEW_HOST_SUFFIX"; do
    if [ -z "${pair#*:}" ]; then
      echo "::error::missing stack output '${pair%%:*}' - AgencyWebPreview isn't deployed. Set previews=true in infra/cdk.context.json and deploy (docs/deployment.md)." >&2
      exit 1
    fi
  done
fi
