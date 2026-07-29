#!/usr/bin/env bash
#
# Refuse a deploy that would silently remove a live custom domain.
#
# The domain can't be tracked in git - it's this deployment's identity, and a fork that inherited
# it would request an ACM certificate for a domain it doesn't control, then hang on DNS validation.
# So `-c domainName=` comes from the AGENCY_DOMAIN_NAME repo variable (see deploy.yml; locally,
# `npm run deploy` reads the same variable). An UNSET value therefore means "nobody told me",
# which is indistinguishable from "serve no domain" - except by what's already deployed.
#
# That's this check, and it's the only case worth automating: `resolveDomain` already refuses a
# half-set pair at synth, and adding or changing a domain is visible in `cdk diff`. Silently
# deleting one is not.
set -euo pipefail

deployed=$(
  aws cloudformation describe-stacks --stack-name AgencyControlPlane \
    --region "${AWS_REGION:-eu-north-1}" \
    --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue | [0]" --output text 2>/dev/null || true
)

# A custom domain is always api.<something>; the raw endpoint always contains execute-api. No
# stack yet, no output, or no domain deployed: nothing to protect.
case "${deployed:-None}" in
  None | "" | *.execute-api.*) exit 0 ;;
esac

if [ -z "${AGENCY_DOMAIN_NAME:-}" ]; then
  cat >&2 <<EOF
REFUSING to deploy: $deployed is live, but no domain is configured for this run.

Deploying would delete the DNS records and the API domain mapping, and point the SPA at a host
it no longer serves. Set the AGENCY_DOMAIN_NAME + AGENCY_HOSTED_ZONE_ID repo variables
(\`gh variable set\`), or pass ALLOW_DOMAIN_REMOVAL=1 to retire the domain deliberately.
EOF
  [ "${ALLOW_DOMAIN_REMOVAL:-}" = "1" ] || exit 1
fi
