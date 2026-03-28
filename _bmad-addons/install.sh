#!/bin/bash
set -e

ADDON_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$ADDON_DIR")"
SKILLS_DIR="$PROJECT_ROOT/.claude/skills"
MANIFEST="$PROJECT_ROOT/_bmad/_config/manifest.yaml"
ADDON_MANIFEST="$ADDON_DIR/manifest.yaml"
BACKUP_DIR="$PROJECT_ROOT/.claude/.addon-backups"
MAX_BACKUPS=3
DRY_RUN=false
FORCE=false

# --- Parse flags ---
while [[ "$#" -gt 0 ]]; do
  case $1 in
    --dry-run) DRY_RUN=true ;;
    --force) FORCE=true ;;
    -h|--help)
      echo "Usage: install.sh [--dry-run] [--force]"
      echo "  --dry-run  Show what would be done without making changes"
      echo "  --force    Skip backup of existing skills before overwrite"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
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

# --- 2. Verify skills directory exists ---
if [ ! -d "$SKILLS_DIR" ]; then
  echo "ERROR: Skills directory not found at $SKILLS_DIR"
  echo "Run BMAD installer first to create the skills directory."
  exit 1
fi

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

# Determine which ignore file to use
IGNORE_FILE="$PROJECT_ROOT/.gitignore"
if [ ! -f "$IGNORE_FILE" ]; then
  EXCLUDE_FILE="$PROJECT_ROOT/.git/info/exclude"
  if [ -f "$EXCLUDE_FILE" ] && [ -s "$EXCLUDE_FILE" ]; then
    IGNORE_FILE="$EXCLUDE_FILE"
    echo "Using .git/info/exclude (no .gitignore found)"
  fi
fi

add_ignore_entry ".autopilot.lock" "$IGNORE_FILE"
add_ignore_entry ".claude/.addon-backups/" "$IGNORE_FILE"

# Verify ignore is effective
if [ "$DRY_RUN" = false ] && command -v git &>/dev/null && [ -d "$PROJECT_ROOT/.git" ]; then
  # Create a temporary test file to check ignore
  if ! git -C "$PROJECT_ROOT" check-ignore -q .autopilot.lock 2>/dev/null; then
    echo "WARNING: .autopilot.lock may not be effectively ignored by git"
  fi
fi

echo ""

# --- 4. Copy skills (with backup + retention) ---
mkdir -p "$BACKUP_DIR" 2>/dev/null || true
BACKUP_TS="$(date +%Y%m%d%H%M%S)"
INSTALLED=()

for skill in "$ADDON_DIR/skills"/*/; do
  [ -d "$skill" ] || continue
  skill_name=$(basename "$skill")
  target="$SKILLS_DIR/$skill_name"

  # Backup existing skill if present
  if [ -d "$target" ] && [ "$FORCE" = false ]; then
    backup="$BACKUP_DIR/${skill_name}.${BACKUP_TS}"
    if [ "$DRY_RUN" = true ]; then
      echo "[DRY RUN] Would backup $skill_name"
    else
      cp -r "$target" "$backup"
      echo "Backed up: $skill_name"
    fi
  fi

  # Install skill
  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would install $skill_name"
  else
    rm -rf "$target"
    cp -r "$skill" "$target/"
    echo "Installed: $skill_name"
    INSTALLED+=("$skill_name")
  fi
done

# --- 5. Prune old backups (keep MAX_BACKUPS per skill) ---
if [ "$DRY_RUN" = false ]; then
  for skill in "$ADDON_DIR/skills"/*/; do
    [ -d "$skill" ] || continue
    skill_name=$(basename "$skill")
    backups=($(ls -d "$BACKUP_DIR/${skill_name}."* 2>/dev/null | sort))
    count=${#backups[@]}
    if [ "$count" -gt "$MAX_BACKUPS" ]; then
      remove=$(( count - MAX_BACKUPS ))
      for ((i=0; i<remove; i++)); do
        rm -rf "${backups[$i]}"
        echo "Pruned old backup: $(basename "${backups[$i]}")"
      done
    fi
  done
fi

# --- 6. Report ---
echo ""
if [ "$DRY_RUN" = true ]; then
  echo "Dry run complete. No changes made."
else
  echo "=== Add-on v$ADDON_VERSION installed ==="
  echo ""
  echo "Installed skills:"
  for s in "${INSTALLED[@]}"; do
    echo "  - $s"
  done
  echo ""
  echo "Backups: $BACKUP_DIR (keeping last $MAX_BACKUPS per skill)"
  echo ""
  echo "Next: invoke bmad-autopilot-on in Claude Code to start using git workflow."
fi
