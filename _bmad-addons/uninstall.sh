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
    gemini-cli)      echo ".gemini" ;;
    *)               echo "" ;;
  esac
}

ALL_TOOLS="claude-code cursor windsurf gemini-cli cline roo trae kiro github-copilot"

# System prompt file per tool (mirrors install.sh)
get_system_prompt_file() {
  case "$1" in
    claude-code)     echo "AGENTS.md" ;;
    cursor)          echo ".cursor/rules/bmad.md" ;;
    windsurf)        echo ".windsurfrules" ;;
    cline)           echo ".clinerules" ;;
    roo)             echo ".roo/rules/bmad.md" ;;
    gemini-cli)      echo "GEMINI.md" ;;
    github-copilot)  echo ".github/copilot-instructions.md" ;;
    kiro)            echo ".kiro/rules/bmad.md" ;;
    trae)            echo ".trae/rules/bmad.md" ;;
    *)               echo "" ;;
  esac
}

get_system_prompt_mode() {
  case "$1" in
    claude-code)                      echo "claude-code" ;;
    cursor|roo|kiro|trae)             echo "own-file" ;;
    windsurf|cline|gemini-cli|github-copilot) echo "append" ;;
    *)                                echo "" ;;
  esac
}

# Remove system prompt for a tool (preserves user content)
remove_system_prompt() {
  local tool="$1"
  local mode
  mode=$(get_system_prompt_mode "$tool")
  local prompt_file="$PROJECT_ROOT/$(get_system_prompt_file "$tool")"

  case "$mode" in
    claude-code)
      # Remove BMAD block from AGENTS.md
      local agents_file="$PROJECT_ROOT/AGENTS.md"
      if [ -f "$agents_file" ] && grep -q '<!-- BEGIN:bmad-workflow-rules -->' "$agents_file" 2>/dev/null; then
        local tmp
        tmp=$(mktemp)
        awk '/<!-- BEGIN:bmad-workflow-rules -->/{skip=1; next} /<!-- END:bmad-workflow-rules -->/{skip=0; next} !skip{print}' "$agents_file" > "$tmp"
        if [ -z "$(tr -d '[:space:]' < "$tmp")" ]; then
          rm -f "$agents_file" "$tmp"
          echo "$tool: removed AGENTS.md (was BMAD-only)"
        else
          mv "$tmp" "$agents_file"
          echo "$tool: removed BMAD section from AGENTS.md"
        fi
      fi

      # Remove @AGENTS.md line from CLAUDE.md
      local claude_file="$PROJECT_ROOT/CLAUDE.md"
      if [ -f "$claude_file" ] && grep -q '@AGENTS.md' "$claude_file" 2>/dev/null; then
        local tmp
        tmp=$(mktemp)
        grep -v '@AGENTS.md' "$claude_file" > "$tmp" || true
        if [ -z "$(tr -d '[:space:]' < "$tmp")" ]; then
          rm -f "$claude_file" "$tmp"
          echo "$tool: removed CLAUDE.md (was BMAD-only)"
        else
          mv "$tmp" "$claude_file"
          echo "$tool: removed @AGENTS.md from CLAUDE.md"
        fi
      fi
      ;;

    own-file)
      if [ -f "$prompt_file" ]; then
        rm -f "$prompt_file"
        echo "$tool: removed $(get_system_prompt_file "$tool")"
      fi
      ;;

    append)
      if [ -f "$prompt_file" ] && grep -q '<!-- BEGIN:bmad-workflow-rules -->' "$prompt_file" 2>/dev/null; then
        local tmp
        tmp=$(mktemp)
        awk '/<!-- BEGIN:bmad-workflow-rules -->/{skip=1; next} /<!-- END:bmad-workflow-rules -->/{skip=0; next} !skip{print}' "$prompt_file" > "$tmp"
        if [ -z "$(tr -d '[:space:]' < "$tmp")" ]; then
          rm -f "$prompt_file" "$tmp"
          echo "$tool: removed $(get_system_prompt_file "$tool") (was BMAD-only)"
        else
          mv "$tmp" "$prompt_file"
          echo "$tool: removed BMAD section from $(get_system_prompt_file "$tool")"
        fi
      fi
      ;;
  esac
}

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

  # Remove system prompt
  remove_system_prompt "$tool"
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
