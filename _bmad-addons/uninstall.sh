#!/bin/bash
set -e

ADDON_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$ADDON_DIR")"
SKILLS_DIR="$PROJECT_ROOT/.claude/skills"
WORKTREES_DIR="$PROJECT_ROOT/.claude/worktrees"

echo "=== BMAD Autopilot Add-On Uninstaller ==="
echo ""

# --- 1. Remove add-on skills ---
removed=0
for skill in "$ADDON_DIR/skills"/*/; do
  [ -d "$skill" ] || continue
  skill_name=$(basename "$skill")
  target="$SKILLS_DIR/$skill_name"
  if [ -d "$target" ]; then
    rm -rf "$target"
    echo "Removed: $skill_name"
    removed=$((removed + 1))
  fi
done

if [ "$removed" -eq 0 ]; then
  echo "No add-on skills found to remove."
fi

# --- 2. Clean up worktrees (check dirty first) ---
if [ -d "$WORKTREES_DIR" ]; then
  echo ""
  echo "Cleaning worktrees..."
  skipped=0
  cleaned=0
  for wt in "$WORKTREES_DIR"/*/; do
    [ -d "$wt" ] || continue
    wt_name=$(basename "$wt")
    # Normalize path for git worktree remove
    wt_abs="$(cd "$wt" 2>/dev/null && pwd)" || wt_abs="$wt"

    # Check for uncommitted changes
    if git -C "$wt" status --porcelain 2>/dev/null | grep -q .; then
      echo "  SKIPPED: $wt_name (has uncommitted changes)"
      skipped=$((skipped + 1))
    else
      git worktree remove "$wt_abs" 2>/dev/null || rm -rf "$wt"
      echo "  Removed: $wt_name"
      cleaned=$((cleaned + 1))
    fi
  done
  git worktree prune 2>/dev/null || true

  if [ "$skipped" -gt 0 ]; then
    echo ""
    echo "WARNING: $skipped worktree(s) skipped due to uncommitted changes."
    echo "Remove manually after saving your work."
  fi
fi

# --- 3. Remove lock file ---
if [ -f "$PROJECT_ROOT/.autopilot.lock" ]; then
  rm -f "$PROJECT_ROOT/.autopilot.lock"
  echo ""
  echo "Removed .autopilot.lock"
fi

# --- 4. Remove backups ---
if [ -d "$PROJECT_ROOT/.claude/.addon-backups" ]; then
  rm -rf "$PROJECT_ROOT/.claude/.addon-backups"
  echo "Removed backup directory"
fi

echo ""
echo "Add-on uninstalled. BMAD skills are unaffected."
