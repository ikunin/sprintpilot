#!/bin/bash
set -e

ADDON_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$ADDON_DIR")"

# Same tool registry as install.sh (Bash 3.2 compatible)
get_tool_dir() {
  case "$1" in
    claude-code)     echo ".claude" ;;
    cursor)          echo ".cursor" ;;
    windsurf)        echo ".windsurf" ;;
    cline)           echo ".cline" ;;
    roo)             echo ".roo" ;;
    trae)            echo ".trae" ;;
    kiro)            echo ".kiro" ;;
    github-copilot)  echo ".github/copilot" ;;
    *)               echo "" ;;
  esac
}

ALL_TOOLS="claude-code cursor windsurf cline roo trae kiro github-copilot"

echo "=== BMAD Autopilot Add-On Uninstaller ==="
echo ""

# --- 1. Find and remove add-on skills from ALL tool directories ---
total_removed=0

for tool in $ALL_TOOLS; do
  TOOL_DIR=$(get_tool_dir "$tool")
  SKILLS_DIR="$PROJECT_ROOT/$TOOL_DIR/skills"

  [ -d "$SKILLS_DIR" ] || continue

  removed=0
  for skill in "$ADDON_DIR/skills"/*/; do
    [ -d "$skill" ] || continue
    skill_name=$(basename "$skill")
    target="$SKILLS_DIR/$skill_name"
    if [ -d "$target" ]; then
      rm -rf "$target"
      removed=$((removed + 1))
    fi
  done

  if [ "$removed" -gt 0 ]; then
    echo "$tool: removed $removed skills from $TOOL_DIR/skills/"
    total_removed=$((total_removed + removed))
  fi

  # Remove backups for this tool
  BACKUP_DIR="$PROJECT_ROOT/$TOOL_DIR/.addon-backups"
  if [ -d "$BACKUP_DIR" ]; then
    rm -rf "$BACKUP_DIR"
    echo "$tool: removed backup directory"
  fi
done

if [ "$total_removed" -eq 0 ]; then
  echo "No add-on skills found in any tool directory."
fi

# --- 2. Clean up worktrees (check dirty first) ---
WORKTREES_DIR="$PROJECT_ROOT/.claude/worktrees"
if [ -d "$WORKTREES_DIR" ]; then
  echo ""
  echo "Cleaning worktrees..."
  skipped=0
  cleaned=0
  for wt in "$WORKTREES_DIR"/*/; do
    [ -d "$wt" ] || continue
    wt_name=$(basename "$wt")
    wt_abs="$(cd "$wt" 2>/dev/null && pwd)" || wt_abs="$wt"

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

echo ""
echo "Add-on uninstalled ($total_removed skills removed). BMAD skills are unaffected."
