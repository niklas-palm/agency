#!/usr/bin/env bash
#
# Pull this deployment's domain config from the repo variables into infra/cdk.context.json.
#
# The domain can't be tracked in git: it is THIS deployment's identity, and a fork that inherited
# it would request an ACM certificate for a domain it doesn't control, then hang on DNS validation
# for hours (see rule 20 / infra/cdk.json's placeholders). But it also can't live in two
# independent places, because CDK reads only the local context file - so a local deploy from a
# machine that never set it silently tears the domain down.
#
# The resolution: the GitHub repo variables are the SINGLE SOURCE OF TRUTH, and this script copies
# them locally. To change the domain you edit one place:
#
#   gh variable set AGENCY_DOMAIN_NAME    --body your.domain
#   gh variable set AGENCY_HOSTED_ZONE_ID --body <its hosted zone id>
#
# then re-run this. CI reads the variables directly, so it needs no local state at all.
set -euo pipefail

cd "$(dirname "$0")/../.."
context="infra/cdk.context.json"

command -v gh >/dev/null || {
  echo "sync-domain-context: needs the gh CLI (brew install gh)" >&2
  exit 1
}

domain=$(gh variable get AGENCY_DOMAIN_NAME 2>/dev/null || true)
zone=$(gh variable get AGENCY_HOSTED_ZONE_ID 2>/dev/null || true)

if [ -z "$domain" ] && [ -z "$zone" ]; then
  echo "sync-domain-context: no domain variables set on this repo - nothing to sync."
  echo "  This deployment serves on the CloudFront + execute-api hostnames."
  exit 0
fi

if [ -z "$domain" ] || [ -z "$zone" ]; then
  echo "sync-domain-context: only one of the pair is set on the repo." >&2
  echo "  AGENCY_DOMAIN_NAME=${domain:-<unset>} AGENCY_HOSTED_ZONE_ID=${zone:-<unset>}" >&2
  echo "  Both or neither - a domain with no zone can't be DNS-validated." >&2
  exit 1
fi

# Merge rather than overwrite: the same file holds other local context (sampleApi, and any
# per-machine overrides), and clobbering it would be its own surprise.
python3 - "$context" "$domain" "$zone" <<'PY'
import json, os, sys
path, domain, zone = sys.argv[1], sys.argv[2], sys.argv[3]
ctx = {}
if os.path.exists(path):
    with open(path) as f:
        ctx = json.load(f)
ctx["domainName"] = domain
ctx["hostedZoneId"] = zone
# webCallbackUrl is derived from the domain when one is set (auth-stack.ts), and an explicit value
# TAKES PRECEDENCE - so a stale one silently keeps emailing invite links to the old origin.
stale = ctx.pop("webCallbackUrl", None)
with open(path, "w") as f:
    json.dump(ctx, f, indent=2)
    f.write("\n")
print(f"  domainName    = {domain}")
print(f"  hostedZoneId  = <set>")
if stale:
    print(f"  dropped a stale webCallbackUrl ({stale}) - the domain supplies it")
PY

echo "sync-domain-context: $context updated from the repo variables."
