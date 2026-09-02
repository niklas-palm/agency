#!/usr/bin/env bash
# One preview comment per PR, updated in place. Body on STDIN.
#
#   bash .github/scripts/pr-comment.sh <pr-number> <<'EOF'
#   **Preview:** https://…
#   EOF
#
# Sticky rather than a new comment per push: the preview URL never changes, so a comment per
# push would be pure noise on a busy PR. The marker is an HTML comment, invisible when
# rendered, and is how the existing comment is found. No third-party action for this - a
# workflow with a deploy identity shouldn't grow a supply chain for ten lines of `gh api`.
set -euo pipefail

PR="${1:?usage: pr-comment.sh <pr-number>}"
MARKER="<!-- agency:preview -->"
BODY="$MARKER"$'\n'"$(cat)"

# `gh` needs a repo when it runs outside a checkout; in Actions GITHUB_REPOSITORY is set.
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}"

EXISTING=$(gh api "repos/${REPO}/issues/${PR}/comments" --paginate \
  --jq "map(select(.body | startswith(\"${MARKER}\"))) | .[0].id // empty")

if [ -n "$EXISTING" ]; then
  gh api -X PATCH "repos/${REPO}/issues/comments/${EXISTING}" -f body="$BODY" >/dev/null
  echo "updated comment ${EXISTING}"
else
  gh api -X POST "repos/${REPO}/issues/${PR}/comments" -f body="$BODY" >/dev/null
  echo "posted a new comment"
fi
