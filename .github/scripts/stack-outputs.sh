#!/usr/bin/env bash
# Resolve the deployed stack outputs a web build and a fast UI sync need, and write them to
# $GITHUB_OUTPUT.
#
# Read from CloudFormation rather than repo variables on purpose: these values change when a
# stack is recreated, and a stale repo variable produces an SPA silently pointed at the wrong
# API. The source of truth is the deployment.
#
# A missing stack is NOT an error - on a first-ever deploy nothing exists yet, so every value
# is empty and the caller skips the web build (see deploy.yml). That's what makes the
# first run work without a special case.
set -euo pipefail

out() { echo "$1=$2" >>"${GITHUB_OUTPUT:-/dev/stdout}"; }

# One value from one stack, or "" if the stack or key is absent.
get() {
  aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue | [0]" \
    --output text 2>/dev/null | sed 's/^None$//'
}

API_URL=$(get AgencyControlPlane ApiUrl)
SITE_BUCKET=$(get AgencyWeb SiteBucketName)
DISTRIBUTION_ID=$(get AgencyWeb DistributionId)
USER_POOL_ID=$(get AgencyAuth UserPoolId)
WEB_CLIENT_ID=$(get AgencyAuth WebClientId)

# The Cognito output keys have drifted before; fall back to a contains-match so a rename
# doesn't silently produce an SPA that can't sign in.
if [ -z "$USER_POOL_ID" ]; then
  USER_POOL_ID=$(aws cloudformation describe-stacks --stack-name AgencyAuth \
    --query "Stacks[0].Outputs[?contains(OutputKey,'UserPoolId')].OutputValue | [0]" \
    --output text 2>/dev/null | sed 's/^None$//')
fi
if [ -z "$WEB_CLIENT_ID" ]; then
  WEB_CLIENT_ID=$(aws cloudformation describe-stacks --stack-name AgencyAuth \
    --query "Stacks[0].Outputs[?contains(OutputKey,'Web') && contains(OutputKey,'Client')].OutputValue | [0]" \
    --output text 2>/dev/null | sed 's/^None$//')
fi

out api_url "$API_URL"
out site_bucket "$SITE_BUCKET"
out distribution_id "$DISTRIBUTION_ID"
out user_pool_id "$USER_POOL_ID"
out web_client_id "$WEB_CLIENT_ID"

echo "resolved: api=${API_URL:-<none>} bucket=${SITE_BUCKET:-<none>} dist=${DISTRIBUTION_ID:-<none>} pool=${USER_POOL_ID:-<none>} client=${WEB_CLIENT_ID:-<none>}"

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
