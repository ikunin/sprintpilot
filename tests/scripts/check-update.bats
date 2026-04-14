#!/usr/bin/env bats
# Tests for check-update command and version flag in bmad-autopilot-addon.sh

DISPATCHER="$BATS_TEST_DIRNAME/../../bin/bmad-autopilot-addon.sh"

setup() {
  TEST_DIR=$(mktemp -d)
  # Create a fake project manifest to simulate an installed project
  mkdir -p "$TEST_DIR/_bmad-addons"
  cat > "$TEST_DIR/_bmad-addons/manifest.yaml" <<'EOF'
addon:
  name: bmad-ma-git
  version: 1.0.10
  description: test manifest
EOF
  export BMAD_PROJECT_ROOT="$TEST_DIR"
}

teardown() {
  cd /tmp || true
  if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
    rm -rf "$TEST_DIR" || true
  fi
  unset BMAD_PROJECT_ROOT
}

@test "check-update shows installed version from project manifest" {
  run bash "$DISPATCHER" check-update
  [ "$status" -eq 0 ]
  [[ "$output" == *"Installed: 1.0.10"* ]]
}

@test "check-update reaches npm registry" {
  # Skip if npm is not available
  command -v npm >/dev/null 2>&1 || skip "npm not installed"
  run bash "$DISPATCHER" check-update
  [ "$status" -eq 0 ]
  [[ "$output" == *"Latest:"* ]]
  # Should not say "unknown" if npm is reachable
  [[ "$output" != *"unknown"* ]]
}

@test "check-update detects newer version available" {
  # Project has old version 1.0.10, npm latest should be newer
  command -v npm >/dev/null 2>&1 || skip "npm not installed"
  run bash "$DISPATCHER" check-update
  [ "$status" -eq 0 ]
  [[ "$output" == *"Update available"* ]]
  [[ "$output" == *"npx bmad-autopilot-addon@latest"* ]]
}

@test "check-update shows up-to-date when versions match" {
  # Set project version to match whatever npm returns
  command -v npm >/dev/null 2>&1 || skip "npm not installed"
  local latest
  latest=$(npm view bmad-autopilot-addon@latest version 2>/dev/null) || skip "npm registry unreachable"
  cat > "$TEST_DIR/_bmad-addons/manifest.yaml" <<EOF
addon:
  version: $latest
EOF
  run bash "$DISPATCHER" check-update
  [ "$status" -eq 0 ]
  [[ "$output" == *"Up to date"* ]]
}

@test "check-update handles missing npm gracefully" {
  # Override PATH to hide npm
  local git_dir=$(dirname "$(command -v git)")
  run env PATH="/usr/bin:/bin:$git_dir" BMAD_PROJECT_ROOT="$TEST_DIR" bash "$DISPATCHER" check-update
  [ "$status" -eq 0 ]
  [[ "$output" == *"Installed: 1.0.10"* ]]
  [[ "$output" == *"npm not found"* ]]
}

@test "check-update falls back to package manifest when no project manifest" {
  rm -rf "$TEST_DIR/_bmad-addons"
  run bash "$DISPATCHER" check-update
  [ "$status" -eq 0 ]
  [[ "$output" == *"No project installation found"* ]]
  [[ "$output" == *"Installed:"* ]]
}

@test "--version reads from project manifest" {
  run bash "$DISPATCHER" --version
  [ "$status" -eq 0 ]
  [ "$output" = "1.0.10" ]
}

@test "--version falls back to package manifest when no project" {
  rm -rf "$TEST_DIR/_bmad-addons"
  run bash "$DISPATCHER" --version
  [ "$status" -eq 0 ]
  # Should return the package's version (not empty)
  [ -n "$output" ]
}

@test "help text includes check-update command" {
  run bash "$DISPATCHER" help
  [ "$status" -eq 0 ]
  [[ "$output" == *"check-update"* ]]
  [[ "$output" == *"Check if a newer version is available"* ]]
}
