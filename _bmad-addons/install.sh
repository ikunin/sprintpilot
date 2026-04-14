#!/bin/bash
set -e

ADDON_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="${BMAD_PROJECT_ROOT:-$(dirname "$ADDON_DIR")}"
MANIFEST="$PROJECT_ROOT/_bmad/_config/manifest.yaml"
ADDON_MANIFEST="$ADDON_DIR/manifest.yaml"
MAX_BACKUPS=3
DRY_RUN=false
FORCE=false
TOOLS=""
YES=false

# --- Supported tools and their base directories ---
# Skills go to {base_dir}/skills/
# Compatible with Bash 3.2+ (no associative arrays)
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

# System prompt file per tool (for BMAD workflow enforcement)
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

# "claude-code" = special CLAUDE.md + AGENTS.md pattern
# "own-file"    = tool has rules directory, BMAD gets its own file (overwrite ok)
# "append"      = shared file, use marker-based append/replace
get_system_prompt_mode() {
  case "$1" in
    claude-code)                      echo "claude-code" ;;
    cursor|roo|kiro|trae)             echo "own-file" ;;
    windsurf|cline|gemini-cli|github-copilot) echo "append" ;;
    *)                                echo "" ;;
  esac
}

# Install system prompt for a tool (marker-based, idempotent)
install_system_prompt() {
  local tool="$1"
  local mode
  mode=$(get_system_prompt_mode "$tool")
  local rules_content
  rules_content=$(cat "$ADDON_DIR/templates/agent-rules.md")
  local prompt_file="$PROJECT_ROOT/$(get_system_prompt_file "$tool")"

  if [ "$DRY_RUN" = true ]; then
    echo "  [DRY RUN] Would install system prompt for $tool ($mode)"
    return
  fi

  case "$mode" in
    claude-code)
      # 1. AGENTS.md: marker-based append/replace
      local agents_file="$PROJECT_ROOT/AGENTS.md"
      if [ -f "$agents_file" ] && grep -q '<!-- BEGIN:bmad-workflow-rules -->' "$agents_file" 2>/dev/null; then
        # Replace existing BMAD section
        local tmp
        tmp=$(mktemp "${prompt_file}.XXXXXX" 2>/dev/null || mktemp)
        awk '/<!-- BEGIN:bmad-workflow-rules -->/{skip=1; next} /<!-- END:bmad-workflow-rules -->/{skip=0; next} !skip{print}' "$agents_file" > "$tmp"
        printf '\n%s\n' "$rules_content" >> "$tmp"
        mv "$tmp" "$agents_file"
        echo "  System prompt: AGENTS.md (updated BMAD section)"
      elif [ -f "$agents_file" ]; then
        # Append to existing
        printf '\n%s\n' "$rules_content" >> "$agents_file"
        echo "  System prompt: AGENTS.md (appended BMAD section)"
      else
        # Create new
        printf '%s\n' "$rules_content" > "$agents_file"
        echo "  System prompt: AGENTS.md (created)"
      fi

      # 2. CLAUDE.md: ensure @AGENTS.md line exists
      local claude_file="$PROJECT_ROOT/CLAUDE.md"
      if [ -f "$claude_file" ] && grep -q '@AGENTS.md' "$claude_file" 2>/dev/null; then
        echo "  System prompt: CLAUDE.md (already has @AGENTS.md)"
      elif [ -f "$claude_file" ]; then
        printf '\n@AGENTS.md\n' >> "$claude_file"
        echo "  System prompt: CLAUDE.md (appended @AGENTS.md)"
      else
        printf '@AGENTS.md\n' > "$claude_file"
        echo "  System prompt: CLAUDE.md (created with @AGENTS.md)"
      fi
      ;;

    own-file)
      # Write directly — this file is fully owned by the addon
      local dir
      dir=$(dirname "$prompt_file")
      mkdir -p "$dir"
      printf '%s\n' "$rules_content" > "$prompt_file"
      echo "  System prompt: $(get_system_prompt_file "$tool") (created)"
      ;;

    append)
      # Marker-based append/replace in shared file
      if [ -f "$prompt_file" ] && grep -q '<!-- BEGIN:bmad-workflow-rules -->' "$prompt_file" 2>/dev/null; then
        local tmp
        tmp=$(mktemp "${prompt_file}.XXXXXX" 2>/dev/null || mktemp)
        awk '/<!-- BEGIN:bmad-workflow-rules -->/{skip=1; next} /<!-- END:bmad-workflow-rules -->/{skip=0; next} !skip{print}' "$prompt_file" > "$tmp"
        printf '\n%s\n' "$rules_content" >> "$tmp"
        mv "$tmp" "$prompt_file"
        echo "  System prompt: $(get_system_prompt_file "$tool") (updated BMAD section)"
      elif [ -f "$prompt_file" ]; then
        printf '\n%s\n' "$rules_content" >> "$prompt_file"
        echo "  System prompt: $(get_system_prompt_file "$tool") (appended BMAD section)"
      else
        local dir
        dir=$(dirname "$prompt_file")
        mkdir -p "$dir"
        printf '%s\n' "$rules_content" > "$prompt_file"
        echo "  System prompt: $(get_system_prompt_file "$tool") (created)"
      fi
      ;;
  esac
}

# --- Parse flags ---
while [ "$#" -gt 0 ]; do
  case $1 in
    --tools) TOOLS="$2"; shift ;;
    --dry-run) DRY_RUN=true ;;
    --force) FORCE=true ;;
    --yes|-y) YES=true ;;
    -h|--help)
      cat <<'HELPEOF'
BMAD Autopilot Add-On Installer

Usage: install.sh [OPTIONS]

Options:
  --tools <list>   Comma-separated list of target tools (e.g., claude-code,cursor)
  --dry-run        Show what would be done without making changes
  --force          Skip backup of existing skills before overwrite
  --yes, -y        Non-interactive mode (use detected/specified tools without prompting)
  -h, --help       Show this help

Supported tools:
  claude-code      Claude Code CLI, desktop, web, IDE extensions
  cursor           Cursor IDE
  windsurf         Windsurf IDE
  cline            Cline (VS Code extension)
  roo              Roo Code (VS Code extension)
  trae             Trae IDE
  kiro             Kiro IDE
  gemini-cli       Gemini CLI (Google)
  github-copilot   GitHub Copilot

Examples:
  install.sh                                  # Interactive tool selection
  install.sh --tools claude-code              # Install for Claude Code only
  install.sh --tools claude-code,cursor       # Install for multiple tools
  install.sh --tools all                      # Install for all supported tools
  install.sh --tools all --yes                # Non-interactive, all tools
  install.sh --dry-run --tools cursor         # Preview Cursor installation
HELPEOF
      exit 0
      ;;
    *) echo "Unknown option: $1. Use --help for usage."; exit 1 ;;
  esac
  shift
done

ADDON_VERSION=$(grep 'version:' "$ADDON_MANIFEST" | head -1 | awk '{print $2}')

# Non-blocking update check (runs in background, result used in post-install summary)
LATEST_VERSION=""
if command -v npm >/dev/null 2>&1; then
  LATEST_VERSION=$(npm view bmad-autopilot-addon@latest version 2>/dev/null || true)
fi

cat << BANNER
 ____  __  __    _    ____       _         _              _ _       _
| __ )|  \/  |  / \  |  _ \     / \  _   _| |_ ___  _ __ (_) | ___ | |_
|  _ \| |\/| | / _ \ | | | |   / _ \| | | | __/ _ \| '_ \| | |/ _ \| __|
| |_) | |  | |/ ___ \| |_| |  / ___ \ |_| | || (_) | |_) | | | (_) | |_
|____/|_|  |_/_/   \_\____/  /_/   \_\__,_|\__\___/| .__/|_|_|\___/ \__| v$ADDON_VERSION
                                                   |_|
BANNER
echo ""

# --- 1. Verify BMAD is installed ---
if [ ! -f "$MANIFEST" ]; then
  echo "ERROR: BMAD not found at $PROJECT_ROOT"
  echo "Install BMAD first: npx bmad-method install"
  exit 1
fi

BMAD_VERSION=$(grep 'version:' "$MANIFEST" | head -1 | awk '{print $2}')
echo "BMAD version: $BMAD_VERSION"
echo ""

# --- 2. Detect or select tools ---

# Auto-detect which tools have BMAD installed (have a skills directory)
detect_installed_tools() {
  local detected=""
  for tool in $ALL_TOOLS; do
    local dir
    dir=$(get_tool_dir "$tool")
    if [ -d "$PROJECT_ROOT/$dir/skills" ]; then
      if [ -n "$detected" ]; then
        detected="$detected,$tool"
      else
        detected="$tool"
      fi
    fi
  done
  echo "$detected"
}

DETECTED_TOOLS=$(detect_installed_tools)

if [ "$TOOLS" = "all" ]; then
  TOOLS=$(echo "$ALL_TOOLS" | tr ' ' ',')
elif [ -z "$TOOLS" ]; then
  if [ "$YES" = true ]; then
    # Non-interactive: use detected tools
    if [ -n "$DETECTED_TOOLS" ]; then
      TOOLS="$DETECTED_TOOLS"
      echo "Auto-detected tools: $TOOLS"
    else
      echo "ERROR: No tools detected. Specify with --tools" >&2
      exit 1
    fi
  else
    # Interactive tool selection
    echo "Select target tools for add-on installation."
    echo "Skills will be installed to each tool's skills directory."
    echo ""
    if [ -n "$DETECTED_TOOLS" ]; then
      echo "Detected (BMAD already installed for these):"
      OLD_IFS="$IFS"; IFS=','
      for t in $DETECTED_TOOLS; do
        echo "  * $t -> $(get_tool_dir "$t")/skills/"
      done
      IFS="$OLD_IFS"
      echo ""
    fi
    echo "Available tools:"
    i=1
    TOOL_BY_NUM=""
    for tool in $ALL_TOOLS; do
      dir=$(get_tool_dir "$tool")
      marker=""
      case ",$DETECTED_TOOLS," in
        *",$tool,"*) marker=" [detected]" ;;
      esac
      echo "  $i) $tool -> $dir/skills/$marker"
      TOOL_BY_NUM="$TOOL_BY_NUM $i:$tool"
      i=$((i + 1))
    done
    echo ""
    echo "Enter tool numbers (comma-separated), tool names, or 'all':"
    echo "  Example: 1,2  or  claude-code,cursor  or  all"
    if [ -n "$DETECTED_TOOLS" ]; then
      echo "  Press Enter to use detected tools: $DETECTED_TOOLS"
    fi
    read -r SELECTION

    if [ -z "$SELECTION" ] && [ -n "$DETECTED_TOOLS" ]; then
      TOOLS="$DETECTED_TOOLS"
    elif [ "$SELECTION" = "all" ]; then
      TOOLS=$(echo "$ALL_TOOLS" | tr ' ' ',')
    else
      # Parse selection (numbers or names)
      TOOLS=""
      OLD_IFS="$IFS"; IFS=','
      for item in $SELECTION; do
        item=$(echo "$item" | tr -d ' ')
        IFS="$OLD_IFS"
        # Check if numeric
        case "$item" in
          [0-9]|[0-9][0-9])
            # Find tool by number
            selected=$(echo "$TOOL_BY_NUM" | tr ' ' '\n' | grep "^$item:" | cut -d: -f2)
            if [ -n "$selected" ]; then
              [ -n "$TOOLS" ] && TOOLS="$TOOLS,"
              TOOLS="${TOOLS}${selected}"
            else
              echo "WARNING: invalid number $item, skipping"
            fi
            ;;
          *)
            # Validate tool name
            dir=$(get_tool_dir "$item")
            if [ -n "$dir" ]; then
              [ -n "$TOOLS" ] && TOOLS="$TOOLS,"
              TOOLS="${TOOLS}${item}"
            else
              echo "WARNING: unknown tool '$item', skipping"
            fi
            ;;
        esac
        IFS=','
      done
      IFS="$OLD_IFS"
    fi
  fi
fi

if [ -z "$TOOLS" ]; then
  echo "ERROR: No tools selected." >&2
  exit 1
fi

# Split tools into array-like variable
SELECTED_TOOLS=$(echo "$TOOLS" | tr ',' ' ')
TOOL_COUNT=$(echo "$SELECTED_TOOLS" | wc -w | tr -d ' ')

echo ""
echo "Installing for: $SELECTED_TOOLS"
echo ""

# --- 3. Ensure .gitignore covers addon artifacts ---
add_ignore_entry() {
  local entry="$1"
  local target_file="$2"

  if [ -f "$target_file" ]; then
    if ! grep -qF "$entry" "$target_file" 2>/dev/null; then
      if [ "$DRY_RUN" = true ]; then
        echo "[DRY RUN] Would add '$entry' to $(basename "$target_file")"
      else
        echo "$entry" >> "$target_file"
        echo "Added '$entry' to $(basename "$target_file")"
      fi
    fi
  else
    if [ "$DRY_RUN" = true ]; then
      echo "[DRY RUN] Would create $(basename "$target_file") with '$entry'"
    else
      echo "$entry" > "$target_file"
      echo "Created $(basename "$target_file") with '$entry'"
    fi
  fi
}

IGNORE_FILE="$PROJECT_ROOT/.gitignore"
if [ ! -f "$IGNORE_FILE" ]; then
  EXCLUDE_FILE="$PROJECT_ROOT/.git/info/exclude"
  if [ -f "$EXCLUDE_FILE" ] && [ -s "$EXCLUDE_FILE" ]; then
    IGNORE_FILE="$EXCLUDE_FILE"
    echo "Using .git/info/exclude (no .gitignore found)"
  fi
fi

add_ignore_entry ".autopilot.lock" "$IGNORE_FILE"

# --- 4. Install skills to each selected tool ---
TOTAL_INSTALLED=0
SKILL_COUNT=$(ls -d "$ADDON_DIR/skills"/*/ 2>/dev/null | wc -l | tr -d ' ')

for tool in $SELECTED_TOOLS; do
  TOOL_DIR=$(get_tool_dir "$tool")

  if [ -z "$TOOL_DIR" ]; then
    echo "WARNING: Unknown tool '$tool', skipping"
    continue
  fi

  SKILLS_DIR="$PROJECT_ROOT/$TOOL_DIR/skills"
  BACKUP_DIR="$PROJECT_ROOT/$TOOL_DIR/.addon-backups"

  # Add backup dir to gitignore
  add_ignore_entry "$TOOL_DIR/.addon-backups/" "$IGNORE_FILE"

  echo "--- $tool -> $TOOL_DIR/skills/ ---"

  # Create skills directory if it doesn't exist
  if [ ! -d "$SKILLS_DIR" ]; then
    if [ "$DRY_RUN" = true ]; then
      echo "  [DRY RUN] Would create $SKILLS_DIR"
    else
      mkdir -p "$SKILLS_DIR"
      echo "  Created: $SKILLS_DIR"
    fi
  fi

  # Create backup directory
  if [ "$DRY_RUN" = false ]; then
    mkdir -p "$BACKUP_DIR" 2>/dev/null || true
  fi
  BACKUP_TS="$(date +%Y%m%d%H%M%S)"

  TOOL_INSTALLED=0
  for skill in "$ADDON_DIR/skills"/*/; do
    [ -d "$skill" ] || continue
    skill_name=$(basename "$skill")
    target="$SKILLS_DIR/$skill_name"

    # Backup existing skill if present
    if [ -d "$target" ] && [ "$FORCE" = false ]; then
      backup="$BACKUP_DIR/${skill_name}.${BACKUP_TS}"
      if [ "$DRY_RUN" = true ]; then
        echo "  [DRY RUN] Would backup $skill_name"
      else
        cp -r "$target" "$backup"
      fi
    fi

    # Install skill
    if [ "$DRY_RUN" = true ]; then
      echo "  [DRY RUN] Would install $skill_name"
    else
      rm -rf "$target"
      cp -r "$skill" "$target/"
      TOOL_INSTALLED=$((TOOL_INSTALLED + 1))
    fi
  done

  # Prune old backups (keep MAX_BACKUPS per skill)
  if [ "$DRY_RUN" = false ] && [ -d "$BACKUP_DIR" ]; then
    for skill in "$ADDON_DIR/skills"/*/; do
      [ -d "$skill" ] || continue
      skill_name=$(basename "$skill")
      count=0
      remove_list=""
      for backup in $(ls -d "$BACKUP_DIR/${skill_name}."* 2>/dev/null | sort); do
        count=$((count + 1))
      done
      if [ "$count" -gt "$MAX_BACKUPS" ]; then
        remove=$((count - MAX_BACKUPS))
        removed=0
        for backup in $(ls -d "$BACKUP_DIR/${skill_name}."* 2>/dev/null | sort); do
          if [ "$removed" -lt "$remove" ]; then
            rm -rf "$backup"
            removed=$((removed + 1))
          fi
        done
      fi
    done
  fi

  if [ "$DRY_RUN" = false ]; then
    echo "  Installed $TOOL_INSTALLED skills"
    TOTAL_INSTALLED=$((TOTAL_INSTALLED + TOOL_INSTALLED))
  fi

  # Install system prompt for BMAD workflow enforcement
  install_system_prompt "$tool"

  echo ""
done

# --- 5. Copy runtime resources to project _bmad-addons/ ---
TARGET_ADDON_DIR="$PROJECT_ROOT/_bmad-addons"

if [ "$DRY_RUN" = true ]; then
  echo "[DRY RUN] Would copy runtime resources to $TARGET_ADDON_DIR"
else
  mkdir -p "$TARGET_ADDON_DIR"
  for item in BMAD.md manifest.yaml .secrets-allowlist modules scripts templates; do
    src="$ADDON_DIR/$item"
    if [ -e "$src" ]; then
      cp -r "$src" "$TARGET_ADDON_DIR/"
    fi
  done
  echo "Runtime resources installed to _bmad-addons/"
fi

# Verify ignore is effective
if [ "$DRY_RUN" = false ] && command -v git >/dev/null 2>&1 && [ -d "$PROJECT_ROOT/.git" ]; then
  if ! git -C "$PROJECT_ROOT" check-ignore -q .autopilot.lock 2>/dev/null; then
    echo "WARNING: .autopilot.lock may not be effectively ignored by git"
  fi
fi

# --- 6. Report ---
echo ""
if [ "$DRY_RUN" = true ]; then
  echo "Dry run complete. No changes made."
else
  echo "=== Add-on v$ADDON_VERSION installed ==="
  echo ""
  echo "Tools configured: $SELECTED_TOOLS"
  echo "Total skills installed: $TOTAL_INSTALLED ($SKILL_COUNT skills x $TOOL_COUNT tools)"
  echo ""
  echo "Skills:"
  for skill in "$ADDON_DIR/skills"/*/; do
    [ -d "$skill" ] || continue
    echo "  - $(basename "$skill")"
  done
  echo ""
  echo "Locations:"
  for tool in $SELECTED_TOOLS; do
    echo "  $tool -> $(get_tool_dir "$tool")/skills/"
  done
  echo ""
  echo "Getting started:"
  echo "  /bmad-autopilot-on   Engage autonomous story execution"
  echo "  /bmad-autopilot-off  Disengage and show status"
  echo "  /bmad-help           Orientation and next-step guidance"
  echo ""
  echo "Configuration (edit these files to customize behavior):"
  echo ""
  echo "  _bmad-addons/modules/git/config.yaml"
  echo "    git.base_branch       main        Branch PRs target"
  echo "    git.branch_prefix     story/      Story branch naming"
  echo "    git.lint.enabled      true        Lint changed files"
  echo "    git.lint.blocking     false       true = lint errors halt autopilot"
  echo "    git.push.auto         true        Auto-push after commit"
  echo "    git.push.create_pr    true        Create PR (false = direct merge)"
  echo "    git.platform.provider auto        auto|github|gitlab|bitbucket|gitea"
  echo ""
  echo "  _bmad-addons/modules/ma/config.yaml"
  echo "    multi_agent.enabled               true   Enable parallel agents"
  echo "    multi_agent.max_parallel_analysis  5      Codebase analysis agents"
  echo ""
  echo "Multi-agent (ma) skills — run parallel subagents for faster analysis:"
  echo "  /bmad-ma-code-review       Parallel 3-layer adversarial review"
  echo "  /bmad-ma-codebase-map      5-stream brownfield codebase analysis"
  echo "  /bmad-ma-assess            Tech debt and dependency audit"
  echo "  /bmad-ma-reverse-architect Extract architecture from existing code"
  echo "  /bmad-ma-migrate           Legacy migration planning"
  echo "  /bmad-ma-research          Parallel web research"
  echo "  /bmad-ma-party-mode        Multi-persona agent discussions"
  # Update notice (only if a newer version exists on npm)
  if [ -n "$LATEST_VERSION" ] && [ "$LATEST_VERSION" != "$ADDON_VERSION" ]; then
    echo "┌─────────────────────────────────────────────────────────┐"
    echo "│  Update available: $ADDON_VERSION → $LATEST_VERSION"
    echo "│  Run: npx bmad-autopilot-addon@latest"
    echo "└─────────────────────────────────────────────────────────┘"
    echo ""
  fi
  echo "MIT License — Igor Kunin — https://github.com/ikunin/bmad-autopilot-addon"
fi
