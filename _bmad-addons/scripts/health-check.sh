#!/bin/bash
# Worktree health check for autopilot session recovery.
# Detects orphaned worktrees from crashed sessions and classifies them.
#
# Usage: health-check.sh [--worktrees-dir .claude/worktrees] [--base-branch main] [--status-file path]
#
# Output (one line per worktree):
#   CLEAN_DONE:<name>     — story done, worktree clean → safe to remove
#   COMMITTED:<name>      — has commits beyond base branch → recoverable
#   STALE:<name>          — no commits beyond base → work was lost, safe to remove
#   DIRTY:<name>          — has uncommitted changes → needs user decision
#   ORPHAN:<name>         — worktree exists but branch was deleted
#
# Summary line at end: SUMMARY:<total>:<clean_done>:<committed>:<stale>:<dirty>:<orphan>
set -e

WORKTREES_DIR=".claude/worktrees"
BASE_BRANCH="main"
STATUS_FILE=""

while [[ "$#" -gt 0 ]]; do
  case $1 in
    --worktrees-dir) WORKTREES_DIR="$2"; shift ;;
    --base-branch) BASE_BRANCH="$2"; shift ;;
    --status-file) STATUS_FILE="$2"; shift ;;
    -h|--help)
      echo "Usage: health-check.sh [--worktrees-dir path] [--base-branch main] [--status-file path]"
      exit 0
      ;;
  esac
  shift
done

if [ ! -d "$WORKTREES_DIR" ]; then
  echo "SUMMARY:0:0:0:0:0:0"
  exit 0
fi

# Fetch remote refs to ensure accurate commit comparison
git fetch origin 2>/dev/null || echo "WARN: git fetch failed (no remote?)" >&2

TOTAL=0
CLEAN_DONE=0
COMMITTED=0
STALE=0
DIRTY=0
ORPHAN=0

for wt in "$WORKTREES_DIR"/*/; do
  [ -d "$wt" ] || continue
  NAME=$(basename "$wt")
  TOTAL=$((TOTAL + 1))

  # Check if it's a valid git worktree
  if ! git -C "$wt" rev-parse --git-dir &>/dev/null; then
    echo "ORPHAN:$NAME"
    ORPHAN=$((ORPHAN + 1))
    continue
  fi

  # Get the branch name
  BRANCH=$(git -C "$wt" branch --show-current 2>/dev/null || echo "")

  if [ -z "$BRANCH" ]; then
    # Detached HEAD or no branch — check if branch was deleted
    echo "ORPHAN:$NAME"
    ORPHAN=$((ORPHAN + 1))
    continue
  fi

  # Check if worktree has uncommitted changes
  DIRTY_FILES=$(git -C "$wt" status --porcelain 2>/dev/null || true)
  if [ -n "$DIRTY_FILES" ]; then
    echo "DIRTY:$NAME"
    DIRTY=$((DIRTY + 1))
    continue
  fi

  # Check story status in sprint-status.yaml
  STORY_STATUS=""
  if [ -n "$STATUS_FILE" ] && [ -f "$STATUS_FILE" ]; then
    STORY_STATUS=$(grep -A1 "^  ${NAME}:" "$STATUS_FILE" 2>/dev/null | grep 'status:' | awk '{print $2}' || true)
  fi

  if [ "$STORY_STATUS" = "done" ]; then
    echo "CLEAN_DONE:$NAME"
    CLEAN_DONE=$((CLEAN_DONE + 1))
    continue
  fi

  # Check if branch has commits beyond base
  # Fetch to ensure we have remote refs
  COMMITS_AHEAD=$(git log --oneline "origin/${BASE_BRANCH}..${BRANCH}" 2>/dev/null | wc -l | tr -d ' ' || echo "0")

  if [ "$COMMITS_AHEAD" -gt 0 ]; then
    echo "COMMITTED:$NAME:${COMMITS_AHEAD}_commits"
    COMMITTED=$((COMMITTED + 1))
  else
    echo "STALE:$NAME"
    STALE=$((STALE + 1))
  fi
done

echo "SUMMARY:$TOTAL:$CLEAN_DONE:$COMMITTED:$STALE:$DIRTY:$ORPHAN"
