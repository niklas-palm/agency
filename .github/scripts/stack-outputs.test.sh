#!/usr/bin/env bash
# Tests for stack-outputs.sh. Run: bash .github/scripts/stack-outputs.test.sh
#
# Every deploy path starts by resolving stack outputs, so a wrong answer here is either a
# dead pipeline or - worse - a bundle published against the wrong API. The cases that matter
# are the ones where a stack is ABSENT: `describe-stacks` exits non-zero for a stack that
# doesn't exist, which under `set -e` killed the whole script (this is what failed the
# AgencyWebPreview deploy) - while a genuine failure must still stop the step.
#
# `aws` is stubbed on PATH: no credentials, no network, nothing real to resolve. The stub
# implements just enough of `describe-stacks --query --output text` to be faithful - exact
# `OutputKey=='K'` matching, the `contains(OutputKey,…)` fallbacks, the literal `None` for a
# key that isn't there, and the real CLI's exit code and message for an absent stack.
set -uo pipefail
cd "$(dirname "$0")"

pass=0
fail=0
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# --- the aws stub -------------------------------------------------------------------------
mkdir -p "$TMP/bin"
cat >"$TMP/bin/aws" <<'STUB'
#!/usr/bin/env bash
# Minimal `aws cloudformation describe-stacks` stand-in, driven by two env vars:
#   STUB_STACKS  - space-separated names of the stacks that exist
#   STUB_OUTPUTS - lines of "<stack> <OutputKey> <value>"
#   STUB_BROKEN  - a stack name whose lookup fails for a NON-absence reason
stack=""; query=""
while [ $# -gt 0 ]; do
  case "$1" in
    --stack-name) stack="$2"; shift 2 ;;
    --query) query="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [ "$stack" = "${STUB_BROKEN:-}" ]; then
  echo "An error occurred (ThrottlingException) when calling the DescribeStacks operation: Rate exceeded" >&2
  exit 254
fi
case " ${STUB_STACKS:-} " in
  *" $stack "*) ;;
  *)
    # Byte-for-byte the real CLI's behaviour for an absent stack.
    echo "An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id $stack does not exist" >&2
    exit 254
    ;;
esac

# Exact match: Outputs[?OutputKey=='Key']
exact=$(printf '%s' "$query" | sed -n "s/.*OutputKey=='\([^']*\)'.*/\1/p")
# Substring match: every contains(OutputKey,'Frag') in the query must appear in the key.
frags=$(printf '%s' "$query" | grep -o "contains(OutputKey,'[^']*'" \
  | sed "s/^contains(OutputKey,'//; s/'$//")

while read -r s k v; do
  [ -n "${s:-}" ] || continue
  [ "$s" = "$stack" ] || continue
  if [ -n "$exact" ]; then
    [ "$k" = "$exact" ] || continue
  else
    ok=1
    for f in $frags; do case "$k" in *"$f"*) ;; *) ok=0 ;; esac; done
    [ "$ok" = "1" ] || continue
  fi
  printf '%s\n' "$v"
  exit 0
done <<<"${STUB_OUTPUTS:-}"

# JMESPath `| [0]` over an empty list renders as the literal "None" in text output.
echo None
STUB
chmod +x "$TMP/bin/aws"

# The five outputs a real, fully deployed account has.
PROD_OUTPUTS='AgencyControlPlane ApiUrl https://api-id.execute-api.eu-north-1.amazonaws.com
AgencyWeb SiteBucketName site-bucket-000000
AgencyWeb DistributionId E000000000000
AgencyAuth UserPoolId eu-north-1_000000000
AgencyAuth WebClientId client000000000000000'
PREVIEW_OUTPUTS='AgencyWebPreview PreviewBucketName preview-bucket-000000
AgencyWebPreview PreviewDistributionId E111111111111
AgencyWebPreview PreviewHostSuffix preview.example.com'
PROD_STACKS='AgencyControlPlane AgencyWeb AgencyAuth AgencyData'

# run <label> - resolve outputs with the stub. Env in: STUB_*, REQUIRE_*, CONTEXT_FILE.
# Out: $status, and $TMP/out holding the key=value lines the step would export.
run() {
  : >"$TMP/out"
  PATH="$TMP/bin:$PATH" GITHUB_OUTPUT="$TMP/out" bash stack-outputs.sh >"$TMP/log" 2>&1
  status=$?
}

check() { # check <want> <label>  - compares against $status / $TMP/out
  local want="$1" label="$2" got="$3"
  if [ "$got" = "$want" ]; then
    printf '  ok   %-56s %s\n' "$label" "$want"
    pass=$((pass + 1))
  else
    printf '  FAIL %-56s got %s, want %s\n' "$label" "${got:-<empty>}" "${want:-<empty>}"
    fail=$((fail + 1))
  fi
}

value_of() { sed -n "s/^$1=//p" "$TMP/out" | tail -1; }

echo "stack-outputs:"

# A deployment WITHOUT a domain, so api_url comes from the stack output.
NO_DOMAIN="$TMP/no-domain.json"
echo '{"sampleApi":"false"}' >"$NO_DOMAIN"
DOMAIN_CTX="$TMP/domain.json"
echo '{"domainName":"example.com","hostedZoneId":"Z000000000000000000000"}' >"$DOMAIN_CTX"

# --- the regression: an absent OPTIONAL stack must not kill the script -------------------
# This is what failed the deploy - the previews stack can only be created by the deploy that
# the lookup for it was aborting.
STUB_STACKS="$PROD_STACKS" STUB_OUTPUTS="$PROD_OUTPUTS" CONTEXT_FILE="$NO_DOMAIN" run
check 0 "AgencyWebPreview absent: exits 0" "$status"
check "https://api-id.execute-api.eu-north-1.amazonaws.com" "  ...and still resolves api_url" "$(value_of api_url)"
check "client000000000000000" "  ...and still resolves web_client_id" "$(value_of web_client_id)"
check "" "  ...and reports an empty preview_bucket" "$(value_of preview_bucket)"

# --- a first-ever deploy: NOTHING exists yet ---------------------------------------------
# Every value empty and exit 0 is what lets deploy.yml skip the SPA build and create the
# stacks. Nobody had run this path since the script was written.
STUB_STACKS="" STUB_OUTPUTS="" CONTEXT_FILE="$NO_DOMAIN" run
check 0 "first-ever deploy (no stacks at all): exits 0" "$status"
check "" "  ...api_url empty" "$(value_of api_url)"
check "" "  ...site_bucket empty" "$(value_of site_bucket)"
check "" "  ...web_client_id empty, so the build is skipped" "$(value_of web_client_id)"

# --- previews deployed -------------------------------------------------------------------
STUB_STACKS="$PROD_STACKS AgencyWebPreview" \
  STUB_OUTPUTS="$PROD_OUTPUTS
$PREVIEW_OUTPUTS" CONTEXT_FILE="$NO_DOMAIN" run
check 0 "previews deployed: exits 0" "$status"
check "preview-bucket-000000" "  ...preview_bucket" "$(value_of preview_bucket)"
check "preview.example.com" "  ...preview_host_suffix" "$(value_of preview_host_suffix)"

# --- a custom domain overrides the deployed ApiUrl ---------------------------------------
STUB_STACKS="$PROD_STACKS" STUB_OUTPUTS="$PROD_OUTPUTS" CONTEXT_FILE="$DOMAIN_CTX" run
check "https://api.example.com" "custom domain derives api_url" "$(value_of api_url)"

# --- the Cognito fallbacks, which only run when a value is missing -----------------------
DRIFTED='AgencyControlPlane ApiUrl https://api-id.execute-api.eu-north-1.amazonaws.com
AgencyWeb SiteBucketName site-bucket-000000
AgencyWeb DistributionId E000000000000
AgencyAuth AgencyUserPoolIdOutput eu-north-1_111111111
AgencyAuth AgencyWebAppClientId client111111111111111'
STUB_STACKS="$PROD_STACKS" STUB_OUTPUTS="$DRIFTED" CONTEXT_FILE="$NO_DOMAIN" run
check "eu-north-1_111111111" "renamed output keys: user_pool_id via fallback" "$(value_of user_pool_id)"
check "client111111111111111" "renamed output keys: web_client_id via fallback" "$(value_of web_client_id)"

# The stub must not match a key by accident, or the two cases above would pass for the wrong
# reason: 'Web' + 'Client' is a two-fragment query, and the pool id is the first row.
BOTH='AgencyAuth AgencyUserPoolIdOutput eu-north-1_111111111
AgencyAuth AgencyWebAppClientId client111111111111111'
STUB_STACKS=AgencyAuth STUB_OUTPUTS="$BOTH" CONTEXT_FILE="$NO_DOMAIN" run
check "client111111111111111" "  ...and the two-fragment query picks the CLIENT row" "$(value_of web_client_id)"

# A stack that exists but doesn't carry the key: `| [0]` renders "None", which is not a value.
STUB_STACKS="$PROD_STACKS AgencyWebPreview" STUB_OUTPUTS="$PROD_OUTPUTS" \
  CONTEXT_FILE="$NO_DOMAIN" run
check 0 "stack present but output key missing: exits 0" "$status"
check "" "  ...and the value is empty, not the string None" "$(value_of preview_bucket)"

# AgencyAuth itself absent (a partly-failed first deploy): the fallbacks carried the same
# landmine, because they only run when the first lookup came back empty.
STUB_STACKS="AgencyControlPlane AgencyWeb" STUB_OUTPUTS="$PROD_OUTPUTS" CONTEXT_FILE="$NO_DOMAIN" run
check 0 "AgencyAuth absent: fallbacks don't kill the script" "$status"
check "" "  ...user_pool_id empty" "$(value_of user_pool_id)"

# --- a REAL failure must still stop the step ---------------------------------------------
# Not absence - throttling, no credentials, a denied call. Resolving it to "" would publish
# against nothing, so this one has to stay fatal.
STUB_STACKS="$PROD_STACKS" STUB_OUTPUTS="$PROD_OUTPUTS" STUB_BROKEN=AgencyWeb \
  CONTEXT_FILE="$NO_DOMAIN" run
check 1 "a non-absence error is fatal" "$([ "$status" -ne 0 ] && echo 1 || echo 0)"
check 1 "  ...and the CLI's message reaches the log" \
  "$(grep -qi 'ThrottlingException' "$TMP/log" && echo 1 || echo 0)"

# --- REQUIRE_ALL: the fast path syncs straight to the bucket ------------------------------
STUB_STACKS="$PROD_STACKS" STUB_OUTPUTS="$PROD_OUTPUTS" CONTEXT_FILE="$NO_DOMAIN" \
  REQUIRE_ALL=1 run
check 0 "REQUIRE_ALL with everything deployed: exits 0" "$status"

STUB_STACKS="AgencyControlPlane AgencyAuth" STUB_OUTPUTS="$PROD_OUTPUTS" \
  CONTEXT_FILE="$NO_DOMAIN" REQUIRE_ALL=1 run
check 1 "REQUIRE_ALL with AgencyWeb absent: fails" "$([ "$status" -ne 0 ] && echo 1 || echo 0)"
check 1 "  ...naming the missing output" \
  "$(grep -q "missing stack output 'site_bucket'" "$TMP/log" && echo 1 || echo 0)"

# --- REQUIRE_PREVIEW: previews are opt-in, so absence is a clear message, not a crash ----
STUB_STACKS="$PROD_STACKS" STUB_OUTPUTS="$PROD_OUTPUTS" CONTEXT_FILE="$NO_DOMAIN" \
  REQUIRE_PREVIEW=1 run
check 1 "REQUIRE_PREVIEW without AgencyWebPreview: fails" "$([ "$status" -ne 0 ] && echo 1 || echo 0)"
check 1 "  ...saying previews aren't deployed" \
  "$(grep -q "AgencyWebPreview isn't deployed" "$TMP/log" && echo 1 || echo 0)"

STUB_STACKS="$PROD_STACKS AgencyWebPreview" \
  STUB_OUTPUTS="$PROD_OUTPUTS
$PREVIEW_OUTPUTS" CONTEXT_FILE="$NO_DOMAIN" REQUIRE_ALL=1 REQUIRE_PREVIEW=1 run
check 0 "REQUIRE_ALL + REQUIRE_PREVIEW, all deployed: exits 0" "$status"

echo "  $pass passed, $fail failed"
[ "$fail" = "0" ]
