#!/usr/bin/env bash
# Create (or update) the IAM role GitHub Actions assumes to deploy this project.
#
# Run ONCE, by hand, with admin credentials. It can't be CDK: the role can't deploy itself
# (nothing can assume it until it exists), and the GitHub OIDC provider is account-global
# infrastructure usually shared with other projects - a CDK-owned provider would try to
# create a duplicate, and `cdk destroy` would delete one other roles depend on.
#
#   bash .github/scripts/setup-oidc-role.sh niklas-palm/agency
#
# THE SUBJECT FORMAT IS THE WHOLE TRICK. The `sub` claim is documented as
# `repo:<owner>/<name>:ref:refs/heads/main`, but some GitHub accounts emit immutable
# numeric ids instead:
#
#   repo:<owner>@<owner_id>/<name>@<repo_id>:ref:refs/heads/main
#
# A policy written in the plain form then fails with "Not authorized to perform
# sts:AssumeRoleWithWebIdentity", which reads like a permissions problem and is actually a
# string mismatch. (Found the hard way; CloudTrail's `userIdentity.userName` is where the
# real subject is visible.) So we ASK the GitHub API for the ids and build the subject from
# what it returns - and refuse to write a policy if that lookup fails, rather than guessing
# and leaving a trust policy no token can ever match.
set -euo pipefail

REPO="${1:?usage: setup-oidc-role.sh <owner/repo>}"
ROLE="${ROLE:-agency-github-deploy}"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
ISSUER="token.actions.githubusercontent.com"
PROVIDER="arn:aws:iam::${ACCOUNT}:oidc-provider/${ISSUER}"

# Regions: the platform, plus us-east-1 for the web-search gateway stack.
REGIONS=(eu-north-1 us-east-1)

command -v gh >/dev/null || { echo "gh CLI is required (to resolve the repo's numeric ids)" >&2; exit 1; }

IDS=$(gh api "repos/${REPO}" --jq '"\(.owner.login)@\(.owner.id)/\(.name)@\(.id)"')
case "$IDS" in
  *message*|"" ) echo "could not resolve ${REPO} via the GitHub API - refusing to guess the subject" >&2; exit 1 ;;
esac
echo "▸ repo ids: ${IDS}"

# The provider must already exist. Creating one is a separate, account-wide decision.
aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER" >/dev/null 2>&1 || {
  cat >&2 <<EOF
The GitHub OIDC provider does not exist in this account. Create it once (account-wide):

  aws iam create-open-id-connect-provider \\
    --url https://${ISSUER} --client-id-list sts.amazonaws.com
EOF
  exit 1
}

# Two statements, each StringEquals on the FULL subject - no wildcard operator anywhere. A
# wildcard in the repo position would let any repository assume this role; a wildcard in the
# ref position would let any branch, including a PR branch, deploy.
TRUST=$(python3 - "$PROVIDER" "$ISSUER" "$IDS" <<'PY'
import json, sys
provider, issuer, ids = sys.argv[1], sys.argv[2], sys.argv[3]
def stmt(sid, sub):
    return {"Sid": sid, "Effect": "Allow",
            "Principal": {"Federated": provider},
            "Action": "sts:AssumeRoleWithWebIdentity",
            "Condition": {"StringEquals": {f"{issuer}:aud": "sts.amazonaws.com",
                                           f"{issuer}:sub": sub}}}
print(json.dumps({"Version": "2012-10-17", "Statement": [
    stmt("MainBranchPush", f"repo:{ids}:ref:refs/heads/main"),
    stmt("ProdEnvironment", f"repo:{ids}:environment:prod"),
]}))
PY
)

# Least privilege: the role holds NO deploy permission itself. It may only assume the CDK
# bootstrap roles - that's where the privilege lives, and it's how CDK is meant to be driven
# from CI - plus the narrow extras the fast UI-only path needs.
PERMS=$(python3 - "$ACCOUNT" "${REGIONS[@]}" <<'PY'
import json, sys
acct, regions = sys.argv[1], sys.argv[2:]
boot = [f"arn:aws:iam::{acct}:role/cdk-hnb659fds-{k}-role-{acct}-{r}"
        for k in ("deploy", "file-publishing", "image-publishing", "lookup") for r in regions]
print(json.dumps({"Version": "2012-10-17", "Statement": [
  {"Sid": "AssumeCdkBootstrapRoles", "Effect": "Allow", "Action": "sts:AssumeRole", "Resource": boot},
  {"Sid": "ReadStackOutputs", "Effect": "Allow", "Action": ["cloudformation:DescribeStacks"], "Resource": "*"},
  {"Sid": "SyncSiteBucket", "Effect": "Allow",
   "Action": ["s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:GetBucketLocation"],
   "Resource": ["arn:aws:s3:::agencyweb-sitebucket*", "arn:aws:s3:::agencyweb-sitebucket*/*"]},
  {"Sid": "InvalidateCdn", "Effect": "Allow",
   "Action": ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"], "Resource": "*"},
]}))
PY
)

if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  echo "▸ updating ${ROLE}'s trust policy (${REPO}: main + prod only)"
  aws iam update-assume-role-policy --role-name "$ROLE" --policy-document "$TRUST"
else
  echo "▸ creating ${ROLE} (${REPO}: main + prod only)"
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document "$TRUST" \
    --description "GitHub Actions OIDC deploy role for ${REPO} (main + prod only)" >/dev/null
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name agency-deploy --policy-document "$PERMS"

echo "▸ done. Set ROLE_ARN in .github/workflows/deploy.yml to:"
echo "    arn:aws:iam::${ACCOUNT}:role/${ROLE}"
