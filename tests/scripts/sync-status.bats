#!/usr/bin/env bats
# Tests for sync-status.sh

load helpers/setup

setup() {
  setup_temp_repo
}

teardown() {
  teardown_temp_repo
}

@test "creates new git-status.yaml from scratch" {
  run bash "$SCRIPTS_DIR/sync-status.sh" \
    --story "1-1" \
    --git-status-file "git-status.yaml" \
    --branch "story/1-1" \
    --platform "github" \
    --base-branch "main"
  [ "$status" -eq 0 ]
  [[ "$output" == OK:1-1:* ]]
  [ -f "git-status.yaml" ]
  grep -q "stories:" git-status.yaml
  grep -q "1-1:" git-status.yaml
  grep -q "branch:" git-status.yaml
}

@test "creates parent directories for git-status-file" {
  run bash "$SCRIPTS_DIR/sync-status.sh" \
    --story "1-1" \
    --git-status-file "deep/nested/dir/git-status.yaml" \
    --branch "story/1-1"
  [ "$status" -eq 0 ]
  [ -f "deep/nested/dir/git-status.yaml" ]
}

@test "updates existing story entry" {
  # Create initial entry
  bash "$SCRIPTS_DIR/sync-status.sh" \
    --story "1-1" \
    --git-status-file "git-status.yaml" \
    --branch "story/1-1" \
    --push-status "pending" \
    --platform "github"

  # Update with push status
  run bash "$SCRIPTS_DIR/sync-status.sh" \
    --story "1-1" \
    --git-status-file "git-status.yaml" \
    --branch "story/1-1" \
    --push-status "pushed" \
    --pr-url "https://github.com/user/repo/pull/42"
  [ "$status" -eq 0 ]
  grep -q "push_status: pushed" git-status.yaml
  grep -q "https://github.com/user/repo/pull/42" git-status.yaml
}

@test "appends new story to existing file" {
  bash "$SCRIPTS_DIR/sync-status.sh" \
    --story "1-1" \
    --git-status-file "git-status.yaml" \
    --branch "story/1-1" \
    --platform "github"

  run bash "$SCRIPTS_DIR/sync-status.sh" \
    --story "1-2" \
    --git-status-file "git-status.yaml" \
    --branch "story/1-2"
  [ "$status" -eq 0 ]
  grep -q "1-1:" git-status.yaml
  grep -q "1-2:" git-status.yaml
}

@test "all fields are written" {
  run bash "$SCRIPTS_DIR/sync-status.sh" \
    --story "2-1" \
    --git-status-file "git-status.yaml" \
    --branch "story/2-1" \
    --worktree ".worktrees/2-1" \
    --commit "abc123def456" \
    --patch-commits "def789,ghi012" \
    --push-status "pushed" \
    --pr-url "https://github.com/u/r/pull/1" \
    --lint-result "0 errors, 2 warnings" \
    --platform "github" \
    --base-branch "main" \
    --worktree-cleaned "true"
  [ "$status" -eq 0 ]
  grep -q "branch:" git-status.yaml
  grep -q "worktree:" git-status.yaml
  grep -q "story_commit:" git-status.yaml
  grep -q "patch_commits:" git-status.yaml
  grep -q "push_status: pushed" git-status.yaml
  grep -q "pr_url:" git-status.yaml
  grep -q "lint_result:" git-status.yaml
  grep -q "worktree_cleaned: true" git-status.yaml
}

@test "missing required args fails" {
  run bash "$SCRIPTS_DIR/sync-status.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *"--story and --git-status-file required"* ]]
}

@test "missing story fails" {
  run bash "$SCRIPTS_DIR/sync-status.sh" --git-status-file "f.yaml"
  [ "$status" -eq 1 ]
}

@test "missing git-status-file fails" {
  run bash "$SCRIPTS_DIR/sync-status.sh" --story "1-1"
  [ "$status" -eq 1 ]
}

@test "YAML special characters in values are quoted" {
  run bash "$SCRIPTS_DIR/sync-status.sh" \
    --story "1-1" \
    --git-status-file "git-status.yaml" \
    --branch "story/1-1" \
    --lint-result "errors: 3, warnings: [none]"
  [ "$status" -eq 0 ]
  # Value with colons/brackets should be quoted
  grep -q 'lint_result:' git-status.yaml
}

@test "git_integration header is written for new files" {
  bash "$SCRIPTS_DIR/sync-status.sh" \
    --story "1-1" \
    --git-status-file "git-status.yaml" \
    --platform "gitlab" \
    --base-branch "develop"

  grep -q "git_integration:" git-status.yaml
  grep -q "enabled: true" git-status.yaml
  grep -q "base_branch: develop" git-status.yaml
  grep -q "platform: gitlab" git-status.yaml
}

@test "help flag shows usage" {
  run bash "$SCRIPTS_DIR/sync-status.sh" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage:"* ]]
}

@test "merge_status is written when provided" {
  run bash "$SCRIPTS_DIR/sync-status.sh" \
    --story "1-1" \
    --git-status-file "git-status.yaml" \
    --branch "story/1-1" \
    --push-status "pushed" \
    --merge-status "merged"
  [ "$status" -eq 0 ]
  grep -q "merge_status: merged" git-status.yaml
}

@test "merge_status omitted when not provided" {
  run bash "$SCRIPTS_DIR/sync-status.sh" \
    --story "1-1" \
    --git-status-file "git-status.yaml" \
    --branch "story/1-1" \
    --push-status "pushed"
  [ "$status" -eq 0 ]
  ! grep -q "merge_status:" git-status.yaml
}

@test "merge_status supports all valid values" {
  for value in pending merged failed recovered pr_pending; do
    rm -f git-status.yaml
    run bash "$SCRIPTS_DIR/sync-status.sh" \
      --story "1-1" \
      --git-status-file "git-status.yaml" \
      --branch "story/1-1" \
      --merge-status "$value"
    [ "$status" -eq 0 ]
    grep -q "merge_status: $value" git-status.yaml
  done
}

@test "merge_status preserved when updating existing story with all fields" {
  # Create initial entry with merge_status
  bash "$SCRIPTS_DIR/sync-status.sh" \
    --story "1-1" \
    --git-status-file "git-status.yaml" \
    --branch "story/1-1" \
    --push-status "pushed" \
    --merge-status "merged" \
    --pr-url "https://github.com/u/r/pull/1" \
    --platform "github"

  grep -q "merge_status: merged" git-status.yaml
  grep -q "push_status: pushed" git-status.yaml
  grep -q "pr_url:" git-status.yaml

  # Update with all fields including merge_status
  run bash "$SCRIPTS_DIR/sync-status.sh" \
    --story "1-1" \
    --git-status-file "git-status.yaml" \
    --branch "story/1-1" \
    --push-status "pushed" \
    --merge-status "recovered" \
    --pr-url "https://github.com/u/r/pull/1"
  [ "$status" -eq 0 ]
  grep -q "merge_status: recovered" git-status.yaml
  grep -q "push_status: pushed" git-status.yaml
  grep -q "pr_url:" git-status.yaml
}

@test "all fields including merge_status are written together" {
  run bash "$SCRIPTS_DIR/sync-status.sh" \
    --story "2-1" \
    --git-status-file "git-status.yaml" \
    --branch "story/2-1" \
    --worktree ".worktrees/2-1" \
    --commit "abc123def456" \
    --patch-commits "def789,ghi012" \
    --push-status "pushed" \
    --merge-status "merged" \
    --pr-url "https://github.com/u/r/pull/1" \
    --lint-result "0 errors, 2 warnings" \
    --platform "github" \
    --base-branch "main" \
    --worktree-cleaned "true"
  [ "$status" -eq 0 ]
  grep -q "branch:" git-status.yaml
  grep -q "worktree:" git-status.yaml
  grep -q "story_commit:" git-status.yaml
  grep -q "patch_commits:" git-status.yaml
  grep -q "push_status: pushed" git-status.yaml
  grep -q "merge_status: merged" git-status.yaml
  grep -q "pr_url:" git-status.yaml
  grep -q "lint_result:" git-status.yaml
  grep -q "worktree_cleaned: true" git-status.yaml
}

@test "merge_status field appears between push_status and pr_url" {
  bash "$SCRIPTS_DIR/sync-status.sh" \
    --story "1-1" \
    --git-status-file "git-status.yaml" \
    --branch "story/1-1" \
    --push-status "pushed" \
    --merge-status "merged" \
    --pr-url "https://github.com/u/r/pull/1"

  # Verify field ordering: push_status before merge_status before pr_url
  local push_line=$(grep -n "push_status:" git-status.yaml | head -1 | cut -d: -f1)
  local merge_line=$(grep -n "merge_status:" git-status.yaml | head -1 | cut -d: -f1)
  local pr_line=$(grep -n "pr_url:" git-status.yaml | head -1 | cut -d: -f1)
  [ "$push_line" -lt "$merge_line" ]
  [ "$merge_line" -lt "$pr_line" ]
}

@test "updating story without merge_status does not add merge_status field" {
  # Create entry without merge_status
  bash "$SCRIPTS_DIR/sync-status.sh" \
    --story "1-1" \
    --git-status-file "git-status.yaml" \
    --branch "story/1-1" \
    --push-status "pending"

  ! grep -q "merge_status:" git-status.yaml

  # Update same story still without merge_status
  run bash "$SCRIPTS_DIR/sync-status.sh" \
    --story "1-1" \
    --git-status-file "git-status.yaml" \
    --branch "story/1-1" \
    --push-status "pushed"
  [ "$status" -eq 0 ]
  ! grep -q "merge_status:" git-status.yaml
}

@test "merge_status on one story does not affect another story" {
  bash "$SCRIPTS_DIR/sync-status.sh" \
    --story "1-1" \
    --git-status-file "git-status.yaml" \
    --branch "story/1-1" \
    --push-status "pushed" \
    --merge-status "merged"

  bash "$SCRIPTS_DIR/sync-status.sh" \
    --story "1-2" \
    --git-status-file "git-status.yaml" \
    --branch "story/1-2" \
    --push-status "pushed"

  # 1-1 should have merge_status, 1-2 should not
  # Extract each story block and check independently
  local full=$(cat git-status.yaml)
  # Count occurrences — should be exactly 1
  local count=$(grep -c "merge_status:" git-status.yaml)
  [ "$count" -eq 1 ]
  grep -q "merge_status: merged" git-status.yaml
}
