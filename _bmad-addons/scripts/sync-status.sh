#!/bin/bash
# Sync sprint-status.yaml git fields from worktree to project root.
# Reads story status from worktree copy, merges git fields into project root copy.
# Uses atomic write (same-dir tmp + mv).
#
# Usage: sync-status.sh --story <key> --worktree <path> --status-file <path> \
#          [--branch <name>] [--commit <sha>] [--patch-commits <sha,...>] \
#          [--push-status <status>] [--pr-url <url>] [--lint-result <text>]
#
# This script uses simple text manipulation (not a YAML parser) to inject fields.
# It appends git fields under the story's entry in development_status.
set -e

STORY=""
WORKTREE=""
STATUS_FILE=""
BRANCH=""
STORY_COMMIT=""
PATCH_COMMITS=""
PUSH_STATUS="pending"
PR_URL=""
LINT_RESULT=""

while [[ "$#" -gt 0 ]]; do
  case $1 in
    --story) STORY="$2"; shift ;;
    --worktree) WORKTREE="$2"; shift ;;
    --status-file) STATUS_FILE="$2"; shift ;;
    --branch) BRANCH="$2"; shift ;;
    --commit) STORY_COMMIT="$2"; shift ;;
    --patch-commits) PATCH_COMMITS="$2"; shift ;;
    --push-status) PUSH_STATUS="$2"; shift ;;
    --pr-url) PR_URL="$2"; shift ;;
    --lint-result) LINT_RESULT="$2"; shift ;;
    -h|--help)
      echo "Usage: sync-status.sh --story <key> --worktree <path> --status-file <path> [git fields...]"
      exit 0
      ;;
  esac
  shift
done

if [ -z "$STORY" ] || [ -z "$STATUS_FILE" ]; then
  echo "ERROR: --story and --status-file required" >&2
  exit 1
fi

if [ ! -f "$STATUS_FILE" ]; then
  echo "ERROR: status file not found: $STATUS_FILE" >&2
  exit 1
fi

# Try to read story status from worktree copy if worktree provided
WORKTREE_STATUS=""
if [ -n "$WORKTREE" ]; then
  # Find the status file in the worktree (search common locations)
  for candidate in \
    "$WORKTREE/_bmad-output/implementation-artifacts/sprint-status.yaml" \
    "$WORKTREE/_bmad-output/sprint-status.yaml"; do
    if [ -f "$candidate" ]; then
      # Extract status value for this story using grep + awk
      WORKTREE_STATUS=$(grep -A1 "^  ${STORY}:" "$candidate" 2>/dev/null | grep 'status:' | awk '{print $2}' || true)
      break
    fi
  done
fi

# Build the git fields block to inject
GIT_FIELDS=""
[ -n "$BRANCH" ] && GIT_FIELDS="${GIT_FIELDS}    branch: ${BRANCH}\n"
[ -n "$WORKTREE" ] && GIT_FIELDS="${GIT_FIELDS}    worktree: ${WORKTREE}\n"
[ -n "$STORY_COMMIT" ] && GIT_FIELDS="${GIT_FIELDS}    story_commit: ${STORY_COMMIT}\n"
[ -n "$PATCH_COMMITS" ] && GIT_FIELDS="${GIT_FIELDS}    patch_commits: [${PATCH_COMMITS}]\n"
[ -n "$LINT_RESULT" ] && GIT_FIELDS="${GIT_FIELDS}    lint_result: \"${LINT_RESULT}\"\n"
GIT_FIELDS="${GIT_FIELDS}    push_status: ${PUSH_STATUS}\n"
[ -n "$PR_URL" ] && GIT_FIELDS="${GIT_FIELDS}    pr_url: ${PR_URL}\n"
GIT_FIELDS="${GIT_FIELDS}    worktree_cleaned: false\n"

# Read current status file
CONTENT=$(cat "$STATUS_FILE")

# Update story status if we got it from worktree
if [ -n "$WORKTREE_STATUS" ]; then
  # Replace the status line for this story
  CONTENT=$(echo "$CONTENT" | sed "/^  ${STORY}:/,/^  [^ ]/{s/    status: .*/    status: ${WORKTREE_STATUS}/;}")
fi

# Check if git fields already exist for this story (look for branch: under the story key)
if echo "$CONTENT" | grep -A5 "^  ${STORY}:" | grep -q "branch:"; then
  # Update existing git fields — remove old ones and re-inject
  # This is a simplified approach: we remove lines between status and the next story key
  TMP_CONTENT=$(echo "$CONTENT" | awk -v story="  ${STORY}:" -v fields="$(printf '%b' "$GIT_FIELDS")" '
    BEGIN { in_story=0; printed_fields=0 }
    $0 ~ "^" story { in_story=1; print; next }
    in_story && /^    status:/ { print; printf "%s", fields; printed_fields=1; next }
    in_story && /^    (branch|worktree|story_commit|patch_commits|lint_result|push_status|pr_url|worktree_cleaned):/ { next }
    in_story && /^  [^ ]/ { in_story=0 }
    { print }
  ')
  CONTENT="$TMP_CONTENT"
else
  # Inject git fields after the status line for this story
  CONTENT=$(echo "$CONTENT" | awk -v story="  ${STORY}:" -v fields="$(printf '%b' "$GIT_FIELDS")" '
    BEGIN { in_story=0 }
    $0 ~ "^" story { in_story=1; print; next }
    in_story && /^    status:/ { print; printf "%s", fields; in_story=0; next }
    { print }
  ')
fi

# Atomic write: same-directory temp file + mv
TMP_FILE="${STATUS_FILE}.tmp"
echo "$CONTENT" > "$TMP_FILE"
mv "$TMP_FILE" "$STATUS_FILE"

echo "OK:${STORY}:status=${WORKTREE_STATUS:-unchanged}:push=${PUSH_STATUS}"
