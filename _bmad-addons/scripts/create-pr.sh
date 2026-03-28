#!/bin/bash
# Create PR/MR via detected platform CLI.
# Uses HEREDOC for body to handle special characters safely.
#
# Usage: create-pr.sh --platform <github|gitlab|git_only> --branch <name> \
#          --base <branch> --title "title" --body "body text"
#
# Output: PR/MR URL on stdout, or "SKIPPED" if git_only/no CLI
# Exit: 0 = created, 1 = failed, 2 = skipped (git_only)
set -e

PLATFORM=""
BRANCH=""
BASE_BRANCH="main"
TITLE=""
BODY=""

while [[ "$#" -gt 0 ]]; do
  case $1 in
    --platform) PLATFORM="$2"; shift ;;
    --branch) BRANCH="$2"; shift ;;
    --base) BASE_BRANCH="$2"; shift ;;
    --title) TITLE="$2"; shift ;;
    --body) BODY="$2"; shift ;;
    -h|--help)
      echo "Usage: create-pr.sh --platform <github|gitlab|git_only> --branch <name> --base <branch> --title 'title' --body 'body'"
      exit 0
      ;;
  esac
  shift
done

if [ -z "$PLATFORM" ] || [ -z "$BRANCH" ] || [ -z "$TITLE" ]; then
  echo "ERROR: --platform, --branch, and --title are required" >&2
  exit 1
fi

case "$PLATFORM" in
  github)
    if ! command -v gh &>/dev/null; then
      echo "WARN: gh CLI not found, skipping PR creation" >&2
      echo "SKIPPED"
      exit 2
    fi
    # Use --body with the text directly (gh handles escaping)
    PR_URL=$(gh pr create \
      --base "$BASE_BRANCH" \
      --head "$BRANCH" \
      --title "$TITLE" \
      --body "$BODY" \
      2>&1) || {
      echo "ERROR: gh pr create failed: $PR_URL" >&2
      exit 1
    }
    echo "$PR_URL"
    ;;

  gitlab)
    if ! command -v glab &>/dev/null; then
      echo "WARN: glab CLI not found, skipping MR creation" >&2
      echo "SKIPPED"
      exit 2
    fi
    MR_URL=$(glab mr create \
      --source-branch "$BRANCH" \
      --target-branch "$BASE_BRANCH" \
      --title "$TITLE" \
      --description "$BODY" \
      --remove-source-branch \
      --yes \
      2>&1) || {
      echo "ERROR: glab mr create failed: $MR_URL" >&2
      exit 1
    }
    # Extract URL from glab output
    echo "$MR_URL" | grep -oE 'https?://[^ ]+' | head -1 || echo "$MR_URL"
    ;;

  git_only)
    echo "SKIPPED"
    echo "INFO: No platform CLI available. Push completed. Create PR manually:" >&2
    echo "  Branch: $BRANCH → $BASE_BRANCH" >&2
    exit 2
    ;;

  *)
    echo "ERROR: unknown platform '$PLATFORM'" >&2
    exit 1
    ;;
esac
