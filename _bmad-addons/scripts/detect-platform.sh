#!/bin/bash
# Detect git platform (github|gitlab|bitbucket|gitea|git_only)
# Priority: explicit config > CLI detection > remote URL regex
#
# Usage: detect-platform.sh [--provider <auto|github|gitlab|bitbucket|gitea|git_only>]
# Output: single line — github, gitlab, bitbucket, gitea, or git_only
set -e

PROVIDER="auto"
while [ "$#" -gt 0 ]; do
  case $1 in
    --provider) PROVIDER="$2"; shift 2 ;;
    -h|--help) echo "Usage: detect-platform.sh [--provider <auto|github|gitlab|bitbucket|gitea|git_only>]"; exit 0 ;;
  esac
done

# 1. Explicit provider
if [ "$PROVIDER" != "auto" ]; then
  echo "$PROVIDER"
  exit 0
fi

# 2. CLI detection
HAS_GH=false
HAS_GLAB=false
HAS_BB=false
HAS_TEA=false
gh --version &>/dev/null && HAS_GH=true
glab --version &>/dev/null && HAS_GLAB=true
bb --version &>/dev/null && HAS_BB=true
tea --version &>/dev/null && HAS_TEA=true

# Count detected CLIs
DETECTED=0
SINGLE=""
[ "$HAS_GH" = true ] && DETECTED=$((DETECTED + 1)) && SINGLE="github"
[ "$HAS_GLAB" = true ] && DETECTED=$((DETECTED + 1)) && SINGLE="gitlab"
[ "$HAS_BB" = true ] && DETECTED=$((DETECTED + 1)) && SINGLE="bitbucket"
[ "$HAS_TEA" = true ] && DETECTED=$((DETECTED + 1)) && SINGLE="gitea"

# If exactly one CLI found, use it
if [ "$DETECTED" -eq 1 ]; then
  echo "$SINGLE"
  exit 0
fi

# 3. Remote URL regex (also used as tiebreaker when multiple CLIs present)
REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo "")

if echo "$REMOTE_URL" | grep -qiE 'github\.com[:/]'; then
  echo "github"
  exit 0
fi

if echo "$REMOTE_URL" | grep -qiE 'gitlab\.'; then
  echo "gitlab"
  exit 0
fi

if echo "$REMOTE_URL" | grep -qiE 'bitbucket\.org[:/]'; then
  echo "bitbucket"
  exit 0
fi

# Gitea has no standard domain — can only be detected via explicit config or tea CLI
if [ "$HAS_TEA" = true ]; then
  echo "gitea"
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

if [ "$HAS_BB" = true ]; then
  echo "bitbucket"
  exit 0
fi

# 5. No CLI, no match
echo "WARN: no platform CLI found (gh, glab, bb, tea) and remote URL didn't match known platforms" >&2
echo "git_only"
