# Component Inventory

## Shell Scripts

The operational backbone of the add-on. All scripts are in `_Sprintpilot/scripts/`.

| Script | Lines | Purpose | Dependencies |
|--------|-------|---------|-------------|
| `lock.js` | 112 | Mutex lock with stale timeout | Core Unix tools |
| `health-check.js` | 108 | Worktree state classification | Git |
| `stage-and-commit.js` | 169 | Explicit staging with pre-commit validation | Git |
| `sanitize-branch.js` | 84 | Story key to branch name conversion | Git, sha256sum/shasum |
| `detect-platform.js` | 90 | Git hosting platform auto-detection | Platform CLIs (optional) |
| `create-pr.js` | 199 | PR/MR creation across platforms | Platform CLI or API tokens |
| `sync-status.js` | 139 | Git metadata tracking in YAML | awk |
| `lint-changed.js` | 293 | Multi-language linting of changed files | Language-specific linters |

**Total:** 8 scripts, ~1,194 lines

### Script Characteristics

- All use `set -e` for fail-fast behavior
- Portable across macOS (Bash 3.2+) and Linux
- Atomic file writes via temp+mv pattern
- Multiple fallback implementations for cross-platform tools

## Skill Definitions

Skills are markdown-based prompts interpreted by AI tools. All source skills are in `_Sprintpilot/skills/`.

### Autopilot Skills

| Skill | Files | Purpose |
|-------|-------|---------|
| `sprint-autopilot-on` | SKILL.md, workflow.md | Full autonomous sprint execution (10-step orchestrator) |
| `sprint-autopilot-off` | SKILL.md, workflow.md | Graceful exit with status report |

### Multi-Agent Skills

| Skill | Agents | Purpose | Output |
|-------|--------|---------|--------|
| `sprintpilot-code-review` | 3 | Parallel adversarial code review | Prioritized findings |
| `sprintpilot-codebase-map` | 5 | Full codebase analysis | 5 analysis files |
| `sprintpilot-assess` | 3 | Tech debt + dependency audit | brownfield-assessment.md |
| `sprintpilot-reverse-architect` | 3 | Bottom-up architecture extraction | architecture.md |
| `sprintpilot-migrate` | 4 | Migration planning | migration-plan.md |
| `sprintpilot-research` | 3 | Parallel research fan-out | Research report |
| `sprintpilot-party-mode` | 2-3 | Multi-persona group discussions | Discussion summary |

**Total:** 9 skills, 19 subagent prompts

### Subagent Prompts

| Skill | Agents |
|-------|--------|
| Code Review | blind-hunter, edge-case-hunter, acceptance-auditor |
| Codebase Map | stack-analyzer, architecture-mapper, quality-assessor, concerns-hunter, integration-mapper |
| Assess | debt-classifier, dependency-auditor, migration-analyzer |
| Reverse Architect | component-mapper, data-flow-tracer, pattern-extractor |
| Migrate | stack-mapper, dependency-analyzer, risk-assessor, test-parity-analyzer |

## Configuration Components

| File | Purpose |
|------|---------|
| `_Sprintpilot/manifest.yaml` | Addon metadata and skill registry |
| `_Sprintpilot/modules/git/config.yaml` | Git workflow configuration (branches, commits, lint, push, PR, worktree, lock, platform) |
| `_Sprintpilot/modules/ma/config.yaml` | Multi-agent parallelism limits |
| `_Sprintpilot/modules/git/templates/pr-body.md` | PR body template |
| `_Sprintpilot/modules/git/templates/commit-story.txt` | Story commit message template |
| `_Sprintpilot/modules/git/templates/commit-patch.txt` | Patch commit message template |
| `_Sprintpilot/modules/git/branching-and-pr-strategy.md` | Branching strategy documentation |

## Installation Components

| File | Purpose |
|------|---------|
| `bin/sprintpilot.js (install subcommand)` | Multi-tool installer supporting 9 AI coding tools |
| `bin/sprintpilot.js (uninstall subcommand)` | Clean removal with worktree cleanup |
| `_Sprintpilot/templates/agent-rules.md` | Template for system prompt generation |
| `_Sprintpilot/.secrets-allowlist` | Patterns excluded from secrets scanning |

## Test Components

### Unit Tests (BATS)

| Test File | Count | Covers |
|-----------|-------|--------|
| `lock.bats` | 12 | Lock acquire, release, stale detection |
| `health-check.bats` | 13 | Worktree classification |
| `stage-and-commit.bats` | 15 | Staging, secrets, size, binary checks |
| `sanitize-branch.bats` | 11 | Branch name sanitization |
| `detect-platform.bats` | 6 | Platform auto-detection |
| `create-pr.bats` | 6 | PR creation |
| `sync-status.bats` | 11 | YAML status updates |
| `lint-changed.bats` | 6 | Multi-language linting |

**Total:** 8 suites, 80 tests

### E2E Tests (Vitest + TypeScript)

| Test | Strategy | Duration Budget |
|------|----------|----------------|
| `greenfield.test.ts` | Build Tic Tac Toe from scratch via autopilot | 8 sessions x 20 min |
| `brownfield.test.ts` | Multi-agent analysis pipeline on json-server | 4 phases x 10-25 min |

### Test Harness

| Module | Purpose |
|--------|---------|
| `claude-runner.ts` | Spawns Claude Code CLI, captures JSON output |
| `assertions.ts` | File system, YAML, and git state assertions |
| `temp-project.ts` | Temporary project factory with BMad Method setup |
| `cost-tracker.ts` | API cost tracking and reporting |

## Platform Support Matrix

| Platform | CLI | API Fallback | Tested |
|----------|-----|-------------|--------|
| GitHub | `gh` | - | Yes |
| GitLab | `glab` | - | Yes |
| Bitbucket | `bb` | `curl` + token | Yes |
| Gitea | `tea` | `curl` + token | Yes |
| Git-only | - | - | Yes |

## Linter Support Matrix

| Language | Linters (priority order) |
|----------|-------------------------|
| Python | ruff, flake8, pylint |
| JavaScript | eslint, biome |
| TypeScript | eslint, biome |
| Rust | cargo clippy |
| Go | golangci-lint |
| Ruby | rubocop |
| Java | checkstyle, pmd |
| C | cppcheck, clang-tidy |
| C++ | cppcheck, clang-tidy |
| C# | dotnet format |
| Swift | swiftlint |
| PL/SQL | sqlfluff |
| Kotlin | ktlint, detekt |
| PHP | phpstan, phpcs |
