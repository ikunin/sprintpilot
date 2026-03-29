#!/bin/bash
# Sanitize a story key into a valid git branch name.
#
# Usage: sanitize-branch.sh <story-key> [--prefix story/] [--max-length 60]
# Output: sanitized branch name (without prefix) on stdout
#         Full branch name (with prefix) validated via git check-ref-format
# Exit 0 = valid, exit 1 = could not produce valid name
set -e

STORY_KEY=""
PREFIX="story/"
MAX_LENGTH=60

while [[ "$#" -gt 0 ]]; do
  case $1 in
    --prefix) PREFIX="$2"; shift 2 ;;
    --max-length) MAX_LENGTH="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: sanitize-branch.sh <story-key> [--prefix story/] [--max-length 60]"
      exit 0
      ;;
    *) STORY_KEY="$1"; shift ;;
  esac
done

if [ -z "$STORY_KEY" ]; then
  echo "ERROR: story key required" >&2
  exit 1
fi

# 1. Lowercase
NAME=$(echo "$STORY_KEY" | tr '[:upper:]' '[:lower:]')

# 2. Strip invalid git ref chars and other special chars
NAME=$(echo "$NAME" | sed 's/[~^:?*\[\\@{}"'"'"'!#$%+;=,<>|`]//g' | tr -d '[:cntrl:]' | sed 's/]//g' | tr ' ' '-')

# 3. Replace & ( ) with hyphens
NAME=$(echo "$NAME" | sed 's/[&()]/-/g')

# 4. Collapse consecutive hyphens
NAME=$(echo "$NAME" | sed 's/-\{2,\}/-/g')

# 5. Strip leading/trailing hyphens and dots
NAME=$(echo "$NAME" | sed 's/^[-.]*//' | sed 's/[-.]*$//')

# 6. Truncate + hash if too long
if [ "${#NAME}" -gt "$MAX_LENGTH" ]; then
  # Hash of the FULL pre-truncation name (6 chars)
  HASH=$(echo -n "$NAME" | sha256sum 2>/dev/null | cut -c1-6 || echo -n "$NAME" | shasum -a 256 2>/dev/null | cut -c1-6 || echo -n "$NAME" | openssl dgst -sha256 2>/dev/null | sed 's/.*= //' | cut -c1-6 || echo "000000")
  TRUNC_LEN=$(( MAX_LENGTH - 7 )) # -6 for hash, -1 for separator
  NAME="${NAME:0:$TRUNC_LEN}-${HASH}"
fi

# 7. Check for branch collision and append counter if needed
FULL_NAME="${PREFIX}${NAME}"
if git rev-parse --verify "$FULL_NAME" &>/dev/null; then
  COUNTER=2
  while git rev-parse --verify "${PREFIX}${NAME}-${COUNTER}" &>/dev/null; do
    COUNTER=$((COUNTER + 1))
  done
  NAME="${NAME}-${COUNTER}"
  FULL_NAME="${PREFIX}${NAME}"
fi

# 8. Validate
if git check-ref-format --branch "$FULL_NAME" &>/dev/null; then
  echo "$NAME"
  exit 0
else
  echo "ERROR: could not produce valid branch name from '$STORY_KEY'" >&2
  exit 1
fi
