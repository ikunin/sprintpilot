#!/bin/bash
# Language-aware linting of changed files only.
# Auto-detects project language, finds first available linter, runs on changed files.
# Errors-first output, truncated to limit.
#
# Usage: lint-changed.sh [--limit 100] [--output-file lint-output.txt]
# Output: truncated lint output (errors first) on stdout, full output to file
# Exit: 0 = no errors (warnings ok), 1 = errors found, 2 = no linter found
set -e

LIMIT=100
OUTPUT_FILE=""

while [[ "$#" -gt 0 ]]; do
  case $1 in
    --limit) LIMIT="$2"; shift ;;
    --output-file) OUTPUT_FILE="$2"; shift ;;
    -h|--help)
      echo "Usage: lint-changed.sh [--limit 100] [--output-file path]"
      exit 0
      ;;
  esac
  shift
done

# Get changed files
CHANGED=$(git diff --name-only HEAD 2>/dev/null || true)
UNTRACKED=$(git ls-files --others --exclude-standard 2>/dev/null || true)
ALL_CHANGED=$(printf '%s\n%s' "$CHANGED" "$UNTRACKED" | sort -u | grep -v '^$' || true)

if [ -z "$ALL_CHANGED" ]; then
  echo "No changed files to lint"
  exit 0
fi

# Detect language and find linter
detect_and_lint() {
  local files="$1"
  local lang=""
  local linter=""
  local lint_cmd=""
  local lint_files=""

  # Check for Python files
  PY_FILES=$(echo "$files" | grep -E '\.py$' || true)
  if [ -n "$PY_FILES" ]; then
    if command -v ruff &>/dev/null; then
      linter="ruff"
      lint_cmd="ruff check"
      lint_files="$PY_FILES"
    elif command -v flake8 &>/dev/null; then
      linter="flake8"
      lint_cmd="flake8"
      lint_files="$PY_FILES"
    elif command -v pylint &>/dev/null; then
      linter="pylint"
      lint_cmd="pylint --output-format=text"
      lint_files="$PY_FILES"
    fi
  fi

  # Check for JS/TS files
  JSTS_FILES=$(echo "$files" | grep -E '\.(js|jsx|ts|tsx)$' || true)
  if [ -n "$JSTS_FILES" ] && [ -z "$linter" ]; then
    if command -v eslint &>/dev/null || [ -f node_modules/.bin/eslint ]; then
      linter="eslint"
      lint_cmd="${node_modules/.bin/eslint:-eslint}"
      [ -f node_modules/.bin/eslint ] && lint_cmd="node_modules/.bin/eslint"
      lint_files="$JSTS_FILES"
    elif command -v biome &>/dev/null; then
      linter="biome"
      lint_cmd="biome check"
      lint_files="$JSTS_FILES"
    fi
  fi

  # Check for Rust files
  RS_FILES=$(echo "$files" | grep -E '\.rs$' || true)
  if [ -n "$RS_FILES" ] && [ -z "$linter" ]; then
    if command -v cargo &>/dev/null; then
      linter="cargo-clippy"
      lint_cmd="cargo clippy --message-format=short"
      lint_files="" # cargo clippy doesn't take individual files
    fi
  fi

  # Check for Go files
  GO_FILES=$(echo "$files" | grep -E '\.go$' || true)
  if [ -n "$GO_FILES" ] && [ -z "$linter" ]; then
    if command -v golangci-lint &>/dev/null; then
      linter="golangci-lint"
      lint_cmd="golangci-lint run"
      lint_files="" # runs on package
    fi
  fi

  # Check for Ruby files
  RB_FILES=$(echo "$files" | grep -E '\.rb$' || true)
  if [ -n "$RB_FILES" ] && [ -z "$linter" ]; then
    if command -v rubocop &>/dev/null; then
      linter="rubocop"
      lint_cmd="rubocop --format simple"
      lint_files="$RB_FILES"
    fi
  fi

  if [ -z "$linter" ]; then
    return 1
  fi

  echo "LINTER:$linter" >&2

  # Run linter
  local full_output=""
  if [ -n "$lint_files" ]; then
    # Pass files as arguments
    full_output=$(echo "$lint_files" | xargs $lint_cmd 2>&1 || true)
  else
    # Run without file args (cargo, golangci-lint)
    full_output=$($lint_cmd 2>&1 || true)
  fi

  echo "$full_output"
  return 0
}

FULL_OUTPUT=$(detect_and_lint "$ALL_CHANGED") || {
  echo "No linter found for changed files"
  exit 2
}

# Save full output to file if requested
if [ -n "$OUTPUT_FILE" ]; then
  echo "$FULL_OUTPUT" > "$OUTPUT_FILE"
  echo "Full output saved to: $OUTPUT_FILE" >&2
fi

# Errors-first truncation
ERRORS=$(echo "$FULL_OUTPUT" | grep -iE '(error|E[0-9]{3,}|fatal)' || true)
WARNINGS=$(echo "$FULL_OUTPUT" | grep -ivE '(error|E[0-9]{3,}|fatal)' | grep -ivE '^$' || true)

ERROR_COUNT=$(echo "$ERRORS" | grep -c . 2>/dev/null || echo "0")
WARN_COUNT=$(echo "$WARNINGS" | grep -c . 2>/dev/null || echo "0")
TOTAL_LINES=$(echo "$FULL_OUTPUT" | wc -l | tr -d ' ')

# Output: errors first, then fill remaining limit with warnings
OUTPUT=""
REMAINING=$LIMIT

if [ -n "$ERRORS" ]; then
  ERROR_LINES=$(echo "$ERRORS" | head -n "$REMAINING")
  OUTPUT="$ERROR_LINES"
  USED=$(echo "$ERROR_LINES" | wc -l | tr -d ' ')
  REMAINING=$(( REMAINING - USED ))
fi

if [ "$REMAINING" -gt 0 ] && [ -n "$WARNINGS" ]; then
  WARN_LINES=$(echo "$WARNINGS" | head -n "$REMAINING")
  if [ -n "$OUTPUT" ]; then
    OUTPUT="${OUTPUT}\n${WARN_LINES}"
  else
    OUTPUT="$WARN_LINES"
  fi
fi

# Print truncated output
printf '%b\n' "$OUTPUT"

if [ "$TOTAL_LINES" -gt "$LIMIT" ]; then
  echo "... truncated ($TOTAL_LINES total lines, showing $LIMIT)" >&2
fi

echo "Summary: $ERROR_COUNT errors, $WARN_COUNT warnings" >&2

# Exit code: 0 if no errors, 1 if errors found
if [ "$ERROR_COUNT" -gt 0 ]; then
  exit 1
else
  exit 0
fi
