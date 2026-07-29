#!/usr/bin/env bash
#
# Deploy from a developer machine using the SAME configuration source as CI: the repo variables.
#
# There is deliberately no local copy of the domain config. It used to live in a gitignored
# infra/cdk.context.json, which meant two independent sources - and a deploy from a machine that
# never set it would silently tear the live domain down. `npm run deploy` passes the variables
# straight through, so there is one place to change and nothing to keep in sync.
set -euo pipefail
cd "$(dirname "$0")/../infra"

bash ../.github/scripts/assert-domain-context.sh

ctx=()
if [ -n "${AGENCY_DOMAIN_NAME:-}" ] || [ -n "${AGENCY_HOSTED_ZONE_ID:-}" ]; then
  ctx=(-c "domainName=${AGENCY_DOMAIN_NAME:-}" -c "hostedZoneId=${AGENCY_HOSTED_ZONE_ID:-}")
fi
npx cdk deploy "${@:-'--all'}" --require-approval never "${ctx[@]}"
