#!/usr/bin/env bash
set -e

# Resolve symlinks so PKG_ROOT points to the actual package directory
SOURCE="$0"
while [ -L "$SOURCE" ]; do
  DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  # Handle relative symlinks
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
PKG_ROOT="$(cd "$(dirname "$SOURCE")/.." && pwd)"
export BMAD_PROJECT_ROOT="${BMAD_PROJECT_ROOT:-$(pwd)}"

COMMAND="${1:-install}"
shift 2>/dev/null || true

case "$COMMAND" in
  install)
    exec "$BASH" "$PKG_ROOT/_bmad-addons/install.sh" "$@"
    ;;
  uninstall)
    exec "$BASH" "$PKG_ROOT/_bmad-addons/uninstall.sh" "$@"
    ;;
  --version|-v)
    # Prefer project's installed version over npx-cached package version
    if [ -f "$BMAD_PROJECT_ROOT/_bmad-addons/manifest.yaml" ]; then
      grep 'version:' "$BMAD_PROJECT_ROOT/_bmad-addons/manifest.yaml" | head -1 | awk '{print $2}'
    else
      grep 'version:' "$PKG_ROOT/_bmad-addons/manifest.yaml" | head -1 | awk '{print $2}'
    fi
    ;;
  check-update)
    # Read version from the PROJECT's installed manifest (not the npx-cached package)
    PROJECT_MANIFEST="$BMAD_PROJECT_ROOT/_bmad-addons/manifest.yaml"
    if [ -f "$PROJECT_MANIFEST" ]; then
      CURRENT=$(grep 'version:' "$PROJECT_MANIFEST" | head -1 | awk '{print $2}')
    else
      # Fallback: no project manifest — show the package version
      CURRENT=$(grep 'version:' "$PKG_ROOT/_bmad-addons/manifest.yaml" | head -1 | awk '{print $2}')
      echo "(No project installation found — showing package version)"
    fi
    echo "Installed: $CURRENT"
    if ! command -v npm >/dev/null 2>&1; then
      echo "Latest:    unknown (npm not found)"
      exit 0
    fi
    LATEST=$(npm view bmad-autopilot-addon@latest version 2>/dev/null || echo "unknown")
    echo "Latest:    $LATEST"
    if [ "$LATEST" = "unknown" ]; then
      echo ""
      echo "Could not reach npm registry."
    elif [ "$CURRENT" != "$LATEST" ]; then
      echo ""
      echo "Update available! Run: npx bmad-autopilot-addon@latest"
    else
      echo ""
      echo "Up to date."
    fi
    ;;
  -h|--help|help)
    cat <<'EOF'
BMAD Autopilot Add-On

Usage: npx bmad-autopilot-addon <command> [options]

Commands:
  install        Install add-on into current BMAD project (default)
  uninstall      Remove add-on from current project
  check-update   Check if a newer version is available on npm
  help           Show this help
  --version      Show version

Install options:
  --tools <list>   Comma-separated tools (claude-code,cursor,windsurf,cline,roo,trae,kiro,gemini-cli,github-copilot,all)
  --dry-run        Preview without making changes
  --force          Skip backup of existing skills
  --yes, -y        Non-interactive mode

Examples:
  npx bmad-autopilot-addon install
  npx bmad-autopilot-addon install --tools claude-code,cursor --yes
  npx bmad-autopilot-addon check-update
  npx bmad-autopilot-addon uninstall --force
EOF
    ;;
  *)
    echo "Unknown command: $COMMAND (use 'help' for usage)"
    exit 1
    ;;
esac
