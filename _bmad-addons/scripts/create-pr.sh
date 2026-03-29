#!/bin/bash
# Create PR/MR via detected platform CLI.
#
# Usage: create-pr.sh --platform <github|gitlab|bitbucket|gitea|git_only> \
#          --branch <name> --base <branch> --title "title" --body "body text" \
#          [--base-url <url>]
#
# Output: PR/MR URL on stdout, or "SKIPPED" if git_only/no CLI
# Exit: 0 = created, 1 = failed, 2 = skipped (git_only)
set -e

PLATFORM=""
BRANCH=""
BASE_BRANCH="main"
TITLE=""
BODY=""
BASE_URL=""

while [ "$#" -gt 0 ]; do
  case $1 in
    --platform) PLATFORM="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --base) BASE_BRANCH="$2"; shift 2 ;;
    --title) TITLE="$2"; shift 2 ;;
    --body) BODY="$2"; shift 2 ;;
    --base-url) BASE_URL="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: create-pr.sh --platform <github|gitlab|bitbucket|gitea|git_only> --branch <name> --base <branch> --title 'title' --body 'body' [--base-url <url>]"
      exit 0
      ;;
    *) shift ;;
  esac
done

if [ -z "$PLATFORM" ] || [ -z "$BRANCH" ] || [ -z "$TITLE" ]; then
  echo "ERROR: --platform, --branch, and --title are required" >&2
  exit 1
fi

# Pre-check: verify remote exists
if ! git remote get-url origin &>/dev/null; then
  echo "SKIPPED"
  echo "INFO: No git remote configured. Push and create PR manually:" >&2
  echo "  git remote add origin <url>" >&2
  echo "  git push -u origin $BRANCH" >&2
  exit 2
fi

# Extract owner/repo from remote URL for API fallbacks
extract_owner_repo() {
  local url
  url=$(git remote get-url origin 2>/dev/null || echo "")
  # Handle SSH: git@host:owner/repo.git
  # Handle HTTPS: https://host/owner/repo.git
  echo "$url" | sed -E 's|.*[:/]([^/]+)/([^/]+?)(\.git)?$|\1/\2|'
}

case "$PLATFORM" in
  github)
    if ! command -v gh &>/dev/null; then
      echo "WARN: gh CLI not found, skipping PR creation" >&2
      echo "SKIPPED"
      exit 2
    fi
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
    echo "$MR_URL" | grep -oE 'https?://[^ ]+' | head -1 || echo "$MR_URL"
    ;;

  bitbucket)
    if command -v bb &>/dev/null; then
      # Bitbucket CLI
      PR_URL=$(bb pr create \
        --source "$BRANCH" \
        --destination "$BASE_BRANCH" \
        --title "$TITLE" \
        --description "$BODY" \
        2>&1) || {
        echo "ERROR: bb pr create failed: $PR_URL" >&2
        exit 1
      }
      echo "$PR_URL" | grep -oE 'https?://[^ ]+' | head -1 || echo "$PR_URL"
    elif [ -n "$BITBUCKET_TOKEN" ]; then
      # API fallback
      OWNER_REPO=$(extract_owner_repo)
      ESCAPED_BODY=$(echo "$BODY" | sed 's/"/\\"/g' | tr '\n' ' ')
      RESULT=$(curl -s -w "\n%{http_code}" -X POST \
        "https://api.bitbucket.org/2.0/repositories/${OWNER_REPO}/pullrequests" \
        -H "Authorization: Bearer $BITBUCKET_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"title\":\"$TITLE\",\"source\":{\"branch\":{\"name\":\"$BRANCH\"}},\"destination\":{\"branch\":{\"name\":\"$BASE_BRANCH\"}},\"description\":\"$ESCAPED_BODY\"}" \
        2>&1)
      HTTP_CODE=$(echo "$RESULT" | tail -1)
      RESPONSE=$(echo "$RESULT" | sed '$d')
      if [ "$HTTP_CODE" = "201" ]; then
        echo "$RESPONSE" | grep -oE '"html"[[:space:]]*:[[:space:]]*\{[^}]*"href"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE 'https?://[^"]+' | head -1 || echo "CREATED"
      else
        echo "ERROR: Bitbucket API returned $HTTP_CODE: $RESPONSE" >&2
        exit 1
      fi
    else
      echo "SKIPPED"
      echo "INFO: Neither bb CLI nor BITBUCKET_TOKEN found. Create PR manually:" >&2
      echo "  Branch: $BRANCH → $BASE_BRANCH" >&2
      exit 2
    fi
    ;;

  gitea)
    if command -v tea &>/dev/null; then
      # tea CLI (https://gitea.com/gitea/tea)
      PR_URL=$(tea pr create \
        --base "$BASE_BRANCH" \
        --head "$BRANCH" \
        --title "$TITLE" \
        --description "$BODY" \
        2>&1) || {
        echo "ERROR: tea pr create failed: $PR_URL" >&2
        exit 1
      }
      echo "$PR_URL" | grep -oE 'https?://[^ ]+' | head -1 || echo "$PR_URL"
    elif [ -n "$GITEA_TOKEN" ] && [ -n "$BASE_URL" ]; then
      # API fallback
      OWNER_REPO=$(extract_owner_repo)
      ESCAPED_BODY=$(echo "$BODY" | sed 's/"/\\"/g' | tr '\n' ' ')
      RESULT=$(curl -s -w "\n%{http_code}" -X POST \
        "${BASE_URL}/api/v1/repos/${OWNER_REPO}/pulls" \
        -H "Authorization: token $GITEA_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"base\":\"$BASE_BRANCH\",\"head\":\"$BRANCH\",\"title\":\"$TITLE\",\"body\":\"$ESCAPED_BODY\"}" \
        2>&1)
      HTTP_CODE=$(echo "$RESULT" | tail -1)
      RESPONSE=$(echo "$RESULT" | sed '$d')
      if [ "$HTTP_CODE" = "201" ]; then
        echo "$RESPONSE" | grep -oE '"html_url"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE 'https?://[^"]+' | head -1 || echo "CREATED"
      else
        echo "ERROR: Gitea API returned $HTTP_CODE: $RESPONSE" >&2
        exit 1
      fi
    else
      echo "SKIPPED"
      echo "INFO: Neither tea CLI nor GITEA_TOKEN+base_url found. Create PR manually:" >&2
      echo "  Branch: $BRANCH → $BASE_BRANCH" >&2
      exit 2
    fi
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
