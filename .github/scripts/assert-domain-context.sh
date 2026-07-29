#!/usr/bin/env bash
#
# Refuse a deploy that would tear down a custom domain already in use.
#
# The domain lives in TWO untracked places - repo variables for CI, a gitignored
# infra/cdk.context.json locally - and CDK reads only the second. So a deploy from a machine whose
# context file lacks the pair silently reverts PUBLIC_API_URL to the raw execute-api host, removes
# the API domain mapping and deletes the Route53 records. The SPA then points at a host it no
# longer serves. Nothing about that deploy looks wrong while it happens.
#
# `resolveDomain` (infra/lib/domain.ts) already refuses a HALF-set pair at synth. This covers the
# case it structurally cannot: BOTH unset is a legitimate configuration - it's how a fork deploys -
# so only the DEPLOYED state can tell you it's wrong here.
#
# Usage: assert-domain-context.sh [domainName]   (falls back to $AGENCY_DOMAIN_NAME)
# Exits 0 when consistent, 1 when this deploy would remove or change a live domain. Never blocks
# a first deploy. ALLOW_DOMAIN_REMOVAL=1 overrides, for genuinely retiring or moving a domain.
set -euo pipefail

domain="${1:-${AGENCY_DOMAIN_NAME:-}}"
region="${AWS_REGION:-eu-north-1}"

deployed_api_url=$(
  aws cloudformation describe-stacks \
    --stack-name AgencyControlPlane \
    --region "$region" \
    --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue | [0]" \
    --output text 2>/dev/null || true
)

# No stack or no output yet: a first deploy, nothing to protect.
if [ -z "$deployed_api_url" ] || [ "$deployed_api_url" = "None" ]; then
  echo "assert-domain-context: no deployed ApiUrl yet (first deploy) - nothing to check"
  exit 0
fi

# A deployed custom domain is always api.<something>; the raw endpoint always contains execute-api.
case "$deployed_api_url" in
  *.execute-api.*)
    echo "assert-domain-context: no custom domain deployed - ok"
    exit 0
    ;;
esac

# https://api.example.com -> example.com
deployed_domain="${deployed_api_url#https://}"
deployed_domain="${deployed_domain#api.}"
deployed_domain="${deployed_domain%%/*}"

fail() {
  echo "$1" >&2
  if [ "${ALLOW_DOMAIN_REMOVAL:-}" = "1" ]; then
    echo "assert-domain-context: ALLOW_DOMAIN_REMOVAL=1 - proceeding anyway" >&2
    exit 0
  fi
  exit 1
}

if [ -z "$domain" ]; then
  fail "assert-domain-context: REFUSING to deploy.

  Deployed:  $deployed_domain (serving $deployed_api_url)
  This run:  no domain configured

Deploying would remove the API domain mapping, delete the Route53 records, and revert
PUBLIC_API_URL to the raw execute-api host - so the SPA would point at a host it no longer
serves. The domain isn't tracked in git, so an unset value is silence, not intent.

  In CI:   set the AGENCY_DOMAIN_NAME + AGENCY_HOSTED_ZONE_ID repo variables.
  Locally: put domainName + hostedZoneId in infra/cdk.context.json.

To genuinely retire the domain, pass ALLOW_DOMAIN_REMOVAL=1."
fi

if [ "$domain" != "$deployed_domain" ]; then
  fail "assert-domain-context: REFUSING to deploy.

  Deployed:  $deployed_domain
  This run:  $domain

Changing the domain replaces certificates and DNS records. If that's intended, pass
ALLOW_DOMAIN_REMOVAL=1; otherwise fix the value so the two agree."
fi

echo "assert-domain-context: $domain matches the deployed domain - ok"
