# Development Guide

## Prerequisites

- **Node.js** 18+ (for test suite)
- **Git** (with remote configured for e2e tests)
- **Bash** 3.2+ (ships with macOS; works on Linux, Git Bash, WSL)
- **BATS** (Bash Automated Testing System, for unit tests)
- **Claude Code CLI** (for e2e tests)
- **Platform CLI** (optional): `gh` (GitHub), `glab` (GitLab), `bb` (Bitbucket), `tea` (Gitea)

## Setup

```bash
# Clone the repository
git clone https://github.com/your-org/sprintpilot.git
cd sprintpilot

# Install test dependencies
cd tests && npm install && cd ..
```

## Project Structure

The add-on has no build step — skills are markdown, scripts are shell. The only compiled code is TypeScript e2e tests.

| Layer | Language | Build |
|-------|----------|-------|
| Skills | Markdown | None (interpreted by AI tools) |
| Scripts | Shell (Bash) | None (executable directly) |
| Config | YAML / Markdown | None |
| Unit Tests | BATS (Bash) | None |
| E2E Tests | TypeScript | Compiled by Vitest on-the-fly |

## Running Tests

### Unit Tests (BATS)

Tests shell scripts in isolation using temporary git repos.

```bash
cd tests

# Run all script tests
npm run test:scripts

# Run a specific test file
bats scripts/lock.bats
bats scripts/stage-and-commit.bats
```

**Test count:** 80 tests across 8 suites

Each BATS test:
- Creates a temporary git repo via `setup_temp_repo()`
- Runs the script under test
- Asserts output and exit codes
- Cleans up via `teardown_temp_repo()`

### E2E Tests (Vitest)

Tests the full autopilot workflow by spawning Claude Code CLI sessions.

```bash
cd tests

# Run greenfield test (builds Tic Tac Toe from scratch)
npm run test:e2e:greenfield

# Run brownfield test (analyzes json-server)
npm run test:e2e:brownfield

# Run all e2e tests
npm run test:e2e
```

**Important:** E2e tests invoke Claude Code and cost real API credits. Budget limits are configured per test.

| Test | Budget | Timeout | Sessions |
|------|--------|---------|----------|
| Greenfield | $20/session x 8 sessions | 20 min/session | Up to 8 |
| Brownfield | $8-10/phase x 4 phases | 10-25 min/phase | 4 phases |

**Environment variables:**
- `BMAD_TEST_MODEL` — Override model (default: `sonnet`)
- `BMAD_TEST_REMOTE_URL` — Override git remote for greenfield test

### All Tests

```bash
cd tests && npm test
```

## Making Changes

### Adding a New Script

1. Create the script in `_Sprintpilot/scripts/your-script.js`
2. Use the `#!/usr/bin/env node` shebang
3. Follow conventions:
   - `'use strict';` at the top
   - Support `--help` flag (parse via `_Sprintpilot/lib/runtime/args.js`)
   - Exit codes: 0=success, 1=expected failure, 2=error
   - Zero external runtime deps — Node built-ins only; import shared helpers from `_Sprintpilot/lib/runtime/` if needed
4. Add BATS tests in `tests/scripts/your-script.bats`

### Adding a New Skill

1. Create directory in `_Sprintpilot/skills/your-skill/`
2. Add `SKILL.md` (metadata) and `workflow.md` (instructions)
3. For multi-agent skills, add prompts in `agents/` subdirectory
4. Register in `_Sprintpilot/manifest.yaml` under `installed_skills`
5. Update `bin/sprintpilot.js install` if the skill needs special handling

### Adding a New Platform

See [EXTENDING.md](./EXTENDING.md) for step-by-step instructions on adding git hosting platforms.

### Adding a New Linter

See [EXTENDING.md](./EXTENDING.md) for step-by-step instructions on adding language linters.

## Commit Conventions

```
feat(scope): description     # New feature
fix(scope): description      # Bug fix
docs(scope): description     # Documentation
refactor(scope): description # Code refactoring
test(scope): description     # Test changes
```

Co-authorship line required:
```
Co-Authored-By: Claude <tool>@anthropic.com
```

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Shell scripts over inline Bash | Deterministic, testable, version-controlled |
| Inlined agent prompts (not files) | Subagents can't read files from disk |
| EnterWorktree over manual git worktree | Claude Code manages cleanup and paths |
| Explicit file staging | Prevents accidental secret/binary commits |
| Separate git-status.yaml | Never modify BMad Method's sprint-status.yaml |

## Debugging

### Lock Issues

```bash
# Check lock status
node _Sprintpilot/scripts/lock.js status

# Force release
node _Sprintpilot/scripts/lock.js release
```

### Worktree Issues

```bash
# Check worktree health
node _Sprintpilot/scripts/health-check.js

# List all worktrees
git worktree list
```

### Platform Detection

```bash
# Test platform detection
node _Sprintpilot/scripts/detect-platform.js
```

### Installer

```bash
# Dry run
npx @ikunin/sprintpilot@latest install --dry-run

# Force reinstall
npx @ikunin/sprintpilot@latest install --force --tools claude-code
```
