#!/bin/bash
set -e

ADDON_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$ADDON_DIR")"
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

echo "=== BMAD Autopilot Add-On Installer ==="
echo ""

# --- 1. Verify BMAD is installed ---
if [ ! -f "$MANIFEST" ]; then
  echo "ERROR: BMAD not found at $PROJECT_ROOT"
  echo "Install BMAD first: npx bmad-method install"
  exit 1
fi

BMAD_VERSION=$(grep 'version:' "$MANIFEST" | head -1 | awk '{print $2}')
ADDON_VERSION=$(grep 'version:' "$ADDON_MANIFEST" | head -1 | awk '{print $2}')
echo "BMAD version:  $BMAD_VERSION"
echo "Add-on version: $ADDON_VERSION"
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
  echo ""
done

# Verify ignore is effective
if [ "$DRY_RUN" = false ] && command -v git >/dev/null 2>&1 && [ -d "$PROJECT_ROOT/.git" ]; then
  if ! git -C "$PROJECT_ROOT" check-ignore -q .autopilot.lock 2>/dev/null; then
    echo "WARNING: .autopilot.lock may not be effectively ignored by git"
  fi
fi

# --- 5. Report ---
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
  echo "Backups: kept in each tool's .addon-backups/ (last $MAX_BACKUPS per skill)"
  echo ""
  echo "Next: invoke /bmad-autopilot-on in your IDE to start using git workflow."
fi
