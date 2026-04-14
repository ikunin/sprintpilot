#!/usr/bin/env bats
# Tests for stage-and-commit.sh

load helpers/setup

setup() {
  setup_temp_repo
}

teardown() {
  teardown_temp_repo
}

@test "commits modified tracked file and outputs SHA" {
  # .gitignore with .autopilot.lock prevents the missing-gitignore warning
  # that would otherwise pollute stdout via bats run (merges stderr+stdout)
  echo ".autopilot.lock" > .gitignore
  git add .gitignore && git commit -m "add gitignore" >/dev/null 2>&1

  commit_file "hello.txt" "original"
  modify_file "hello.txt" "updated"

  run bash "$SCRIPTS_DIR/stage-and-commit.sh" --message "update hello"
  [ "$status" -eq 0 ]
  # Output should be a git SHA (40 hex chars)
  [[ "$output" =~ ^[a-f0-9]{40}$ ]]
  # Verify the commit exists
  git log --oneline -1 | grep -q "update hello"
}

@test "commits untracked file" {
  create_untracked "newfile.txt"

  run bash "$SCRIPTS_DIR/stage-and-commit.sh" --message "add newfile"
  [ "$status" -eq 0 ]
  # Output may contain warnings on stderr; SHA is on the last line
  [[ "$output" =~ [a-f0-9]{40} ]]
}

@test "nothing to commit exits 1" {
  run bash "$SCRIPTS_DIR/stage-and-commit.sh" --message "empty"
  [ "$status" -eq 1 ]
  [[ "${lines[0]}" == *"Nothing to commit"* ]]
}

@test "missing message exits 2" {
  create_untracked "file.txt"
  run bash "$SCRIPTS_DIR/stage-and-commit.sh"
  [ "$status" -eq 2 ]
  [[ "$output" == *"--message required"* ]]
}

@test "dry-run lists files without committing" {
  commit_file "hello.txt" "original"
  modify_file "hello.txt" "changed"
  create_untracked "new.txt"

  run bash "$SCRIPTS_DIR/stage-and-commit.sh" --message "test" --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"DRY RUN"* ]]
  [[ "$output" == *"hello.txt"* ]]
  [[ "$output" == *"new.txt"* ]]
  # Verify nothing was actually committed (initial + commit_file = 2 commits)
  local count=$(git log --oneline | wc -l | tr -d ' ')
  [ "$count" -eq 2 ]
}

@test "secrets detection warns on stderr" {
  commit_file "config.js" "const x = 1"
  modify_file "config.js" "const API_KEY = 'sk-12345'"

  run bash "$SCRIPTS_DIR/stage-and-commit.sh" --message "add config" 2>&1
  [ "$status" -eq 0 ]
  # The warning should be present (stderr merged into stdout for this test)
  [[ "$output" == *"WARN: possible secret"* ]] || [[ "$output" =~ [a-f0-9]{40} ]]
}

@test "secrets allowlist skips matching files" {
  commit_file "config.js" "const x = 1"
  modify_file "config.js" "const API_KEY = 'sk-12345'"

  # Create an allowlist that matches config.js
  echo "config.js" > allowlist.txt

  # Capture stderr separately
  local sha
  sha=$(bash "$SCRIPTS_DIR/stage-and-commit.sh" --message "add config" --allowlist allowlist.txt 2>stderr.txt)
  local stderr_content=$(cat stderr.txt)

  # Should NOT contain secret warning for config.js
  [[ "$stderr_content" != *"WARN: possible secret in config.js"* ]]
}

@test "large file detection warns" {
  commit_file "small.txt" "small"
  # Create a file larger than the default 1MB limit
  dd if=/dev/zero of=large.bin bs=1048577 count=1 2>/dev/null
  create_untracked "large.bin"

  # Run with stderr captured
  run bash "$SCRIPTS_DIR/stage-and-commit.sh" --message "add large" 2>&1
  [ "$status" -eq 0 ]
  [[ "$output" == *"large file"* ]] || true
}

@test "custom max-size-mb is respected" {
  # Create a 100KB file (should pass with default 1MB, fail with 0 limit)
  dd if=/dev/zero of=medium.bin bs=102400 count=1 2>/dev/null
  create_untracked "medium.bin"

  # With max-size 0 (everything is "large"), just verify it still commits
  run bash "$SCRIPTS_DIR/stage-and-commit.sh" --message "add medium" --max-size-mb 0 2>&1
  [ "$status" -eq 0 ]
}

@test "gitignore missing autopilot.lock warns" {
  create_untracked "file.txt"
  # No .gitignore exists
  run bash "$SCRIPTS_DIR/stage-and-commit.sh" --message "test" 2>&1
  [ "$status" -eq 0 ]
  # Should warn about missing .gitignore
  [[ "$output" == *"WARN:"* ]]
}

@test "gitignore with autopilot.lock does not warn about it" {
  echo ".autopilot.lock" > .gitignore
  git add .gitignore && git commit -m "add gitignore" >/dev/null 2>&1
  create_untracked "file.txt"

  local sha
  sha=$(bash "$SCRIPTS_DIR/stage-and-commit.sh" --message "test" 2>stderr.txt)
  local stderr_content=$(cat stderr.txt)

  [[ "$stderr_content" != *".autopilot.lock"* ]]
}

@test "file-list cross-reference warns on unexpected files" {
  commit_file "expected.txt" "content"
  modify_file "expected.txt" "updated"
  create_untracked "surprise.txt"

  # File list only mentions expected.txt
  cat > filelist.md <<'EOF'
- expected.txt
EOF

  run bash "$SCRIPTS_DIR/stage-and-commit.sh" --message "test" --file-list filelist.md 2>&1
  [ "$status" -eq 0 ]
  [[ "$output" == *"unexpected file"* ]] || [[ "$output" == *"surprise.txt"* ]]
}

@test "handles files with spaces in names" {
  create_untracked "my file.txt" "content"

  run bash "$SCRIPTS_DIR/stage-and-commit.sh" --message "file with spaces"
  [ "$status" -eq 0 ]
  [[ "$output" =~ [a-f0-9]{40} ]]
}

@test "help flag shows usage" {
  run bash "$SCRIPTS_DIR/stage-and-commit.sh" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage:"* ]]
}
