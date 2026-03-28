#!/bin/bash
# Explicit file staging and commit. NEVER uses git add -A.
#
# Usage: stage-and-commit.sh --message "commit msg" [--allowlist path] [--max-size-mb 1] [--file-list path]
#
# Stages all uncommitted changes (tracked modifications + untracked non-ignored files).
# Runs pre-commit checks: secrets scan (WARN), file size check, binary detection.
# Optionally cross-references with a story File List for unexpected file warnings.
# Commits with the given message.
#
# Output: commit SHA on success, warnings on stderr
# Exit: 0 = committed, 1 = nothing to commit, 2 = error
set -e

MESSAGE=""
ALLOWLIST=""
MAX_SIZE_MB=1
FILE_LIST=""
DRY_RUN=false

while [[ "$#" -gt 0 ]]; do
  case $1 in
    --message|-m) MESSAGE="$2"; shift ;;
    --allowlist) ALLOWLIST="$2"; shift ;;
    --max-size-mb) MAX_SIZE_MB="$2"; shift ;;
    --file-list) FILE_LIST="$2"; shift ;;
    --dry-run) DRY_RUN=true ;;
    -h|--help)
      echo "Usage: stage-and-commit.sh --message 'msg' [--allowlist path] [--max-size-mb 1] [--file-list path]"
      exit 0
      ;;
  esac
  shift
done

if [ -z "$MESSAGE" ]; then
  echo "ERROR: --message required" >&2
  exit 2
fi

# 1. Collect all changed/new files
MODIFIED=$(git diff --name-only HEAD 2>/dev/null || true)
UNTRACKED=$(git ls-files --others --exclude-standard 2>/dev/null || true)
DELETED=$(git diff --name-only --diff-filter=D HEAD 2>/dev/null || true)

ALL_FILES=$(printf '%s\n%s' "$MODIFIED" "$UNTRACKED" | sort -u | grep -v '^$' || true)

if [ -z "$ALL_FILES" ] && [ -z "$DELETED" ]; then
  echo "Nothing to commit" >&2
  exit 1
fi

# 2. Pre-commit checks
WARNINGS=""
MAX_SIZE_BYTES=$(( MAX_SIZE_MB * 1024 * 1024 ))

# Build allowlist patterns for grep -v
ALLOWLIST_FILTER=""
if [ -n "$ALLOWLIST" ] && [ -f "$ALLOWLIST" ]; then
  # Convert glob patterns to grep-compatible patterns (basic)
  ALLOWLIST_FILTER=$(grep -v '^#' "$ALLOWLIST" | grep -v '^$' | sed 's/\*\*/.*/' | sed 's/\*/[^\/]*/' || true)
fi

is_allowed() {
  local file="$1"
  if [ -z "$ALLOWLIST_FILTER" ]; then
    return 1 # not allowed (no allowlist)
  fi
  echo "$ALLOWLIST_FILTER" | while IFS= read -r pattern; do
    if echo "$file" | grep -qE "$pattern"; then
      return 0
    fi
  done
  return 1
}

# 2a. Secrets scan (WARN only)
SECRET_PATTERNS='API_KEY|SECRET_KEY|SECRET=|TOKEN=|PASSWORD=|aws_access|private_key|PRIVATE_KEY'
while IFS= read -r file; do
  [ -z "$file" ] && continue
  [ -f "$file" ] || continue

  # Skip if in allowlist
  if [ -n "$ALLOWLIST_FILTER" ]; then
    SKIP=false
    while IFS= read -r pattern; do
      [ -z "$pattern" ] && continue
      if echo "$file" | grep -qE "$pattern"; then
        SKIP=true
        break
      fi
    done <<< "$ALLOWLIST_FILTER"
    [ "$SKIP" = true ] && continue
  fi

  HITS=$(grep -nE "$SECRET_PATTERNS" "$file" 2>/dev/null | head -3 || true)
  if [ -n "$HITS" ]; then
    WARNINGS="${WARNINGS}WARN: possible secret in $file:\n$(echo "$HITS" | head -3)\n\n"
  fi
done <<< "$ALL_FILES"

# 2b. File size check
while IFS= read -r file; do
  [ -z "$file" ] && continue
  [ -f "$file" ] || continue
  SIZE=$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null || echo "0")
  if [ "$SIZE" -gt "$MAX_SIZE_BYTES" ]; then
    SIZE_MB=$(( SIZE / 1024 / 1024 ))
    WARNINGS="${WARNINGS}WARN: large file $file (${SIZE_MB}MB > ${MAX_SIZE_MB}MB limit)\n"
  fi
done <<< "$ALL_FILES"

# 2c. Binary file detection
while IFS= read -r file; do
  [ -z "$file" ] && continue
  [ -f "$file" ] || continue
  if file --mime-encoding "$file" 2>/dev/null | grep -q 'binary'; then
    WARNINGS="${WARNINGS}WARN: binary file detected: $file (will be staged but verify it's intended)\n"
  fi
done <<< "$ALL_FILES"

# 2d. Verify .gitignore covers addon artifacts
if [ -f .gitignore ]; then
  for entry in ".autopilot.lock" ".claude/.addon-backups/"; do
    if ! grep -qF "$entry" .gitignore 2>/dev/null; then
      WARNINGS="${WARNINGS}WARN: .gitignore missing entry '$entry' — run install.sh to fix\n"
    fi
  done
else
  WARNINGS="${WARNINGS}WARN: no .gitignore found — addon artifacts may be committed\n"
fi

# 2e. File List cross-reference (if --file-list provided)
if [ -n "$FILE_LIST" ] && [ -f "$FILE_LIST" ]; then
  # Extract file paths from the File List (lines starting with - or *)
  EXPECTED_FILES=$(grep -E '^\s*[-*]\s+' "$FILE_LIST" | sed 's/^[[:space:]]*[-*][[:space:]]*//' | sed 's/[[:space:]]*$//' || true)
  if [ -n "$EXPECTED_FILES" ]; then
    # Files in git diff but NOT in File List
    while IFS= read -r file; do
      [ -z "$file" ] && continue
      if ! echo "$EXPECTED_FILES" | grep -qF "$file"; then
        WARNINGS="${WARNINGS}WARN: unexpected file not in story File List: $file\n"
      fi
    done <<< "$ALL_FILES"
  fi
fi

# Print warnings
if [ -n "$WARNINGS" ]; then
  printf '%b' "$WARNINGS" >&2
fi

if [ "$DRY_RUN" = true ]; then
  echo "DRY RUN — would stage and commit:"
  echo "$ALL_FILES"
  [ -n "$DELETED" ] && echo "Deleted: $DELETED"
  exit 0
fi

# 3. Stage files with quoted paths
while IFS= read -r file; do
  [ -z "$file" ] && continue
  [ -f "$file" ] || continue
  git add -- "$file"
done <<< "$ALL_FILES"

# 3b. Stage deletions
while IFS= read -r file; do
  [ -z "$file" ] && continue
  git rm --quiet -- "$file" 2>/dev/null || true
done <<< "$DELETED"

# 4. Commit
COMMIT_OUTPUT=$(git commit -m "$MESSAGE" 2>&1) || {
  echo "ERROR: commit failed: $COMMIT_OUTPUT" >&2
  exit 2
}

# 5. Output commit SHA
git rev-parse HEAD
