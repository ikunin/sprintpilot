#!/bin/bash
# Write git metadata to git-status.yaml (addon-owned file).
# NEVER modifies sprint-status.yaml (BMAD-owned).
#
# Usage: sync-status.sh --story <key> --git-status-file <path> \
#          [--branch <name>] [--commit <sha>] [--patch-commits <sha,...>] \
#          [--push-status <status>] [--pr-url <url>] [--lint-result <text>] \
#          [--worktree <path>] [--platform <name>] [--base-branch <name>]
#
# Reads existing git-status.yaml and updates the story entry.
# Creates the file if it doesn't exist.
# Uses atomic write (same-dir tmp + mv).
set -e

STORY=""
GIT_STATUS_FILE=""
BRANCH=""
WORKTREE=""
STORY_COMMIT=""
PATCH_COMMITS=""
PUSH_STATUS="pending"
PR_URL=""
LINT_RESULT=""
PLATFORM=""
BASE_BRANCH="main"
WORKTREE_CLEANED="false"

while [ "$#" -gt 0 ]; do
  case $1 in
    --story) STORY="$2"; shift 2 ;;
    --git-status-file) GIT_STATUS_FILE="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --worktree) WORKTREE="$2"; shift 2 ;;
    --commit) STORY_COMMIT="$2"; shift 2 ;;
    --patch-commits) PATCH_COMMITS="$2"; shift 2 ;;
    --push-status) PUSH_STATUS="$2"; shift 2 ;;
    --pr-url) PR_URL="$2"; shift 2 ;;
    --lint-result) LINT_RESULT="$2"; shift 2 ;;
    --platform) PLATFORM="$2"; shift 2 ;;
    --base-branch) BASE_BRANCH="$2"; shift 2 ;;
    --worktree-cleaned) WORKTREE_CLEANED="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: sync-status.sh --story <key> --git-status-file <path> [git fields...]"
      exit 0
      ;;
    *) shift ;;
  esac
done

if [ -z "$STORY" ] || [ -z "$GIT_STATUS_FILE" ]; then
  echo "ERROR: --story and --git-status-file required" >&2
  exit 1
fi

# Ensure parent directory exists
mkdir -p "$(dirname "$GIT_STATUS_FILE")"

# Read existing file or start fresh
if [ -f "$GIT_STATUS_FILE" ]; then
  EXISTING=$(cat "$GIT_STATUS_FILE")
else
  EXISTING=""
fi

# YAML-safe quoting: wrap values that may contain special chars
yaml_safe() {
  local val="$1"
  # Quote if contains : { } [ ] , & * # ? | - < > = ! % @ ` or newlines
  case "$val" in
    *[:\{\}\[\],\&\*\#\?\|\-\<\>\=\!\%\@\`]*|*"
"*) printf '"%s"' "$(echo "$val" | sed 's/"/\\"/g')" ;;
    *) printf '%s' "$val" ;;
  esac
}

# Build the story entry
STORY_BLOCK="  ${STORY}:"
[ -n "$BRANCH" ] && STORY_BLOCK="$STORY_BLOCK
    branch: $(yaml_safe "$BRANCH")"
[ -n "$WORKTREE" ] && STORY_BLOCK="$STORY_BLOCK
    worktree: $(yaml_safe "$WORKTREE")"
[ -n "$STORY_COMMIT" ] && STORY_BLOCK="$STORY_BLOCK
    story_commit: $(yaml_safe "$STORY_COMMIT")"
[ -n "$PATCH_COMMITS" ] && STORY_BLOCK="$STORY_BLOCK
    patch_commits: [${PATCH_COMMITS}]"
[ -n "$LINT_RESULT" ] && STORY_BLOCK="$STORY_BLOCK
    lint_result: $(yaml_safe "$LINT_RESULT")"
STORY_BLOCK="$STORY_BLOCK
    push_status: $(yaml_safe "$PUSH_STATUS")"
[ -n "$PR_URL" ] && STORY_BLOCK="$STORY_BLOCK
    pr_url: $(yaml_safe "$PR_URL")"
STORY_BLOCK="$STORY_BLOCK
    worktree_cleaned: ${WORKTREE_CLEANED}"

# If file exists and has this story, replace that story's block
# If file exists without this story, append under stories:
# If file doesn't exist, create fresh
TMP_FILE="${GIT_STATUS_FILE}.tmp"

if [ -z "$EXISTING" ]; then
  # Create new file
  cat > "$TMP_FILE" <<EOF
# BMAD Autopilot Add-On — Git Status
# Tracks git metadata per story. Do not edit manually.
git_integration:
  enabled: true
  base_branch: ${BASE_BRANCH}
  platform: ${PLATFORM}

stories:
${STORY_BLOCK}
EOF
elif echo "$EXISTING" | grep -q "^  ${STORY}:"; then
  # Replace existing story block
  awk -v story="  ${STORY}:" -v block="$STORY_BLOCK" '
    $0 == story { skip=1; print block; next }
    skip && /^  [^ ]/ { skip=0 }
    skip { next }
    { print }
  ' "$GIT_STATUS_FILE" > "$TMP_FILE"
else
  # Append new story
  printf '%s\n%s\n' "$EXISTING" "$STORY_BLOCK" > "$TMP_FILE"
fi

# Atomic rename
mv "$TMP_FILE" "$GIT_STATUS_FILE"

echo "OK:${STORY}:push=${PUSH_STATUS}"
