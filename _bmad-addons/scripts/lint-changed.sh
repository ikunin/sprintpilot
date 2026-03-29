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
    --limit) LIMIT="$2"; shift 2 ;;
    --output-file) OUTPUT_FILE="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: lint-changed.sh [--limit 100] [--output-file path]"
      exit 0
      ;;
  esac
done

# Get changed files
CHANGED=$(git diff --name-only HEAD 2>/dev/null || true)
UNTRACKED=$(git ls-files --others --exclude-standard 2>/dev/null || true)
ALL_CHANGED=$(printf '%s\n%s' "$CHANGED" "$UNTRACKED" | sort -u | grep -v '^$' || true)

if [ -z "$ALL_CHANGED" ]; then
  echo "No changed files to lint"
  exit 0
fi

# Run a single linter and collect output
run_linter() {
  local linter_name="$1"
  local lint_cmd="$2"
  local lint_files="$3"

  echo "LINTER:$linter_name" >&2
  local output=""
  local exit_code=0
  if [ -n "$lint_files" ]; then
    # Build file list as arguments (handles spaces in filenames)
    local file_args=""
    while IFS= read -r f; do
      [ -n "$f" ] && file_args="$file_args \"$f\""
    done <<< "$lint_files"
    output=$(eval $lint_cmd $file_args 2>&1) || exit_code=$?
  else
    output=$($lint_cmd 2>&1) || exit_code=$?
  fi
  # exit_code > 2 typically means linter crashed (not just "found issues")
  if [ "$exit_code" -gt 2 ]; then
    echo "WARN: $linter_name exited with code $exit_code (may have crashed)" >&2
  fi
  echo "$output"
}

# Detect all languages in changed files and lint each (multi-language support)
detect_and_lint() {
  local files="$1"
  local found_any=false
  local combined_output=""

  # Python
  PY_FILES=$(echo "$files" | grep -E '\.py$' || true)
  if [ -n "$PY_FILES" ]; then
    if command -v ruff &>/dev/null; then
      combined_output="${combined_output}$(run_linter "ruff" "ruff check" "$PY_FILES")\n"
      found_any=true
    elif command -v flake8 &>/dev/null; then
      combined_output="${combined_output}$(run_linter "flake8" "flake8" "$PY_FILES")\n"
      found_any=true
    elif command -v pylint &>/dev/null; then
      combined_output="${combined_output}$(run_linter "pylint" "pylint --output-format=text" "$PY_FILES")\n"
      found_any=true
    fi
  fi

  # JavaScript / TypeScript
  JSTS_FILES=$(echo "$files" | grep -E '\.(js|jsx|ts|tsx)$' || true)
  if [ -n "$JSTS_FILES" ]; then
    if [ -f node_modules/.bin/eslint ]; then
      combined_output="${combined_output}$(run_linter "eslint" "node_modules/.bin/eslint" "$JSTS_FILES")\n"
      found_any=true
    elif command -v eslint &>/dev/null; then
      combined_output="${combined_output}$(run_linter "eslint" "eslint" "$JSTS_FILES")\n"
      found_any=true
    elif command -v biome &>/dev/null; then
      combined_output="${combined_output}$(run_linter "biome" "biome check" "$JSTS_FILES")\n"
      found_any=true
    fi
  fi

  # Rust
  RS_FILES=$(echo "$files" | grep -E '\.rs$' || true)
  if [ -n "$RS_FILES" ]; then
    if command -v cargo &>/dev/null; then
      combined_output="${combined_output}$(run_linter "cargo-clippy" "cargo clippy --message-format=short" "")\n"
      found_any=true
    fi
  fi

  # Go
  GO_FILES=$(echo "$files" | grep -E '\.go$' || true)
  if [ -n "$GO_FILES" ]; then
    if command -v golangci-lint &>/dev/null; then
      combined_output="${combined_output}$(run_linter "golangci-lint" "golangci-lint run" "")\n"
      found_any=true
    fi
  fi

  # Ruby
  RB_FILES=$(echo "$files" | grep -E '\.rb$' || true)
  if [ -n "$RB_FILES" ]; then
    if command -v rubocop &>/dev/null; then
      combined_output="${combined_output}$(run_linter "rubocop" "rubocop --format simple" "$RB_FILES")\n"
      found_any=true
    fi
  fi

  # Java
  JAVA_FILES=$(echo "$files" | grep -E '\.java$' || true)
  if [ -n "$JAVA_FILES" ]; then
    if command -v checkstyle &>/dev/null; then
      local cs_config="/google_checks.xml"
      [ -f "checkstyle.xml" ] && cs_config="checkstyle.xml"
      combined_output="${combined_output}$(run_linter "checkstyle" "checkstyle -c $cs_config" "$JAVA_FILES")\n"
      found_any=true
    elif command -v pmd &>/dev/null; then
      combined_output="${combined_output}$(run_linter "pmd" "pmd check -d" "$JAVA_FILES")\n"
      found_any=true
    fi
  fi

  # C
  C_FILES=$(echo "$files" | grep -E '\.[ch]$' || true)
  if [ -n "$C_FILES" ]; then
    if command -v cppcheck &>/dev/null; then
      combined_output="${combined_output}$(run_linter "cppcheck" "cppcheck --enable=warning,style" "$C_FILES")\n"
      found_any=true
    elif command -v clang-tidy &>/dev/null; then
      combined_output="${combined_output}$(run_linter "clang-tidy" "clang-tidy" "$C_FILES")\n"
      found_any=true
    fi
  fi

  # C++
  CPP_FILES=$(echo "$files" | grep -E '\.(cpp|cc|cxx|hpp|hxx)$' || true)
  if [ -n "$CPP_FILES" ]; then
    if command -v cppcheck &>/dev/null; then
      combined_output="${combined_output}$(run_linter "cppcheck" "cppcheck --enable=warning,style --language=c++" "$CPP_FILES")\n"
      found_any=true
    elif command -v clang-tidy &>/dev/null; then
      combined_output="${combined_output}$(run_linter "clang-tidy" "clang-tidy" "$CPP_FILES")\n"
      found_any=true
    fi
  fi

  # C# (.NET)
  CS_FILES=$(echo "$files" | grep -E '\.cs$' || true)
  if [ -n "$CS_FILES" ]; then
    if command -v dotnet &>/dev/null; then
      combined_output="${combined_output}$(run_linter "dotnet-format" "dotnet format --verify-no-changes --diagnostics" "")\n"
      found_any=true
    fi
  fi

  # Swift
  SWIFT_FILES=$(echo "$files" | grep -E '\.swift$' || true)
  if [ -n "$SWIFT_FILES" ]; then
    if command -v swiftlint &>/dev/null; then
      combined_output="${combined_output}$(run_linter "swiftlint" "swiftlint lint --quiet" "$SWIFT_FILES")\n"
      found_any=true
    fi
  fi

  # PL/SQL and SQL
  SQL_FILES=$(echo "$files" | grep -E '\.(sql|pls|plb|pks|pkb|trg|fnc|prc)$' || true)
  if [ -n "$SQL_FILES" ]; then
    if command -v sqlfluff &>/dev/null; then
      combined_output="${combined_output}$(run_linter "sqlfluff" "sqlfluff lint --dialect oracle" "$SQL_FILES")\n"
      found_any=true
    fi
  fi

  # Kotlin
  KT_FILES=$(echo "$files" | grep -E '\.kt$' || true)
  if [ -n "$KT_FILES" ]; then
    if command -v ktlint &>/dev/null; then
      combined_output="${combined_output}$(run_linter "ktlint" "ktlint" "$KT_FILES")\n"
      found_any=true
    elif command -v detekt &>/dev/null; then
      combined_output="${combined_output}$(run_linter "detekt" "detekt --input" "$KT_FILES")\n"
      found_any=true
    fi
  fi

  # PHP
  PHP_FILES=$(echo "$files" | grep -E '\.php$' || true)
  if [ -n "$PHP_FILES" ]; then
    if command -v phpstan &>/dev/null; then
      combined_output="${combined_output}$(run_linter "phpstan" "phpstan analyse --no-progress" "$PHP_FILES")\n"
      found_any=true
    elif command -v phpcs &>/dev/null; then
      combined_output="${combined_output}$(run_linter "phpcs" "phpcs" "$PHP_FILES")\n"
      found_any=true
    fi
  fi

  if [ "$found_any" = false ]; then
    return 1
  fi

  printf '%b' "$combined_output"
  return 0
}

FULL_OUTPUT=$(detect_and_lint "$ALL_CHANGED") || {
  echo "No linter found for changed files"
  exit 2
}

# Save full output to file if requested
if [ -n "$OUTPUT_FILE" ]; then
  if echo "$FULL_OUTPUT" > "$OUTPUT_FILE"; then
    echo "Full output saved to: $OUTPUT_FILE" >&2
  else
    echo "WARN: could not write lint output to $OUTPUT_FILE" >&2
  fi
fi

# Errors-first truncation
ERRORS=$(echo "$FULL_OUTPUT" | grep -E '(: error|: fatal|^ERROR|^FATAL|error:| E[0-9]{3,})' || true)
WARNINGS=$(echo "$FULL_OUTPUT" | grep -vE '(: error|: fatal|^ERROR|^FATAL|error:| E[0-9]{3,})' | grep -vE '^$' || true)

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
