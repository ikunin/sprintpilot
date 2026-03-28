#!/bin/bash
# Detect git platform (github|gitlab|git_only)
# Priority: explicit config > CLI detection > remote URL regex
#
# Usage: detect-platform.sh [--provider <auto|github|gitlab|git_only>]
# Output: single line — github, gitlab, or git_only
set -e

PROVIDER="auto"
while [[ "$#" -gt 0 ]]; do
  case $1 in
    --provider) PROVIDER="$2"; shift ;;
    -h|--help) echo "Usage: detect-platform.sh [--provider <auto|github|gitlab|git_only>]"; exit 0 ;;
  esac
  shift
done

# 1. Explicit provider
if [ "$PROVIDER" != "auto" ]; then
  echo "$PROVIDER"
  exit 0
fi

# 2. CLI detection
HAS_GH=false
HAS_GLAB=false
gh --version &>/dev/null && HAS_GH=true
glab --version &>/dev/null && HAS_GLAB=true

if [ "$HAS_GH" = true ] && [ "$HAS_GLAB" = false ]; then
  echo "github"
  exit 0
fi

if [ "$HAS_GLAB" = true ] && [ "$HAS_GH" = false ]; then
  echo "gitlab"
  exit 0
fi

# 3. Remote URL regex (also used as tiebreaker when both CLIs present)
REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo "")

if echo "$REMOTE_URL" | grep -qE 'github\.com[:/]'; then
  echo "github"
  exit 0
fi

if echo "$REMOTE_URL" | grep -qE 'gitlab\.'; then
  echo "gitlab"
  exit 0
fi

# 4. If we have a CLI but URL didn't match, still use the CLI
if [ "$HAS_GH" = true ]; then
  echo "github"
  exit 0
fi

if [ "$HAS_GLAB" = true ]; then
  echo "gitlab"
  exit 0
fi

# 5. No CLI, no match
echo "git_only"
