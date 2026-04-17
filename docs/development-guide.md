# Development Guide

## Prerequisites

- **Node.js** 18+ (both the addon and the test suite run on Node; no Bash dependency)
- **Git** (with a remote configured for e2e tests)
- **Claude Code CLI** (for e2e tests only)
- **Platform CLI** (optional): `gh` (GitHub), `glab` (GitLab), `bb` (Bitbucket), `tea` (Gitea)

## Setup

```bash
# Clone the repository
git clone https://github.com/ikunin/sprintpilot.git
cd sprintpilot

# Install test dependencies (root package has no build step)
cd tests && npm install && cd ..
```

## Project Structure

The addon has no build step — skills are markdown, scripts are Node.js. The only compiled surface is the TypeScript e2e/integration test layer, compiled by Vitest on the fly.

| Layer | Language | Build |
|-------|----------|-------|
| Skills | Markdown | None (interpreted by AI tools) |
| Scripts | Node.js | None (run via `node <file>.js`) |
| Config | YAML / Markdown | None |
| Unit + integration tests | TypeScript (Vitest) | On-the-fly by Vitest |

## Running Tests

### Unit + integration tests (Vitest)

Tests the installer, runtime helpers, and Node scripts in isolation using temporary git repos.

```bash
cd tests

# Fast suite: unit + scripts (no Claude Code, no network except a couple of check-update tests)
npm run test:fast

# Subsets
npm run test:unit      # lib/ and _Sprintpilot/lib/runtime/
npm run test:scripts   # _Sprintpilot/scripts/ and the CLI
```

Each test creates a temp git repo + temp project state, runs the code under test, asserts output / exit codes / filesystem side effects, and cleans up.

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
- `SPRINTPILOT_TEST_MODEL` — Override model (default: `sonnet`)
- `SPRINTPILOT_TEST_REMOTE_URL` — Override git remote for greenfield test
- `SPRINTPILOT_TEST_KEEP_ON_FAIL=1` — Preserve temp dirs on failure for debugging

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
4. Add Vitest tests in `tests/scripts/your-script.test.ts` (or `tests/unit/...` for pure-logic helpers)

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

Use `!` for breaking changes (`refactor!: …`, `feat!: …`).

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Node.js scripts over inline logic in workflow.md | Deterministic, testable, version-controlled |
| Inlined agent prompts (not files) | Subagents can't invoke the Skill tool or read arbitrary files |
| `git worktree add` via standard git commands | Compatible with any coding agent (not Claude-specific) |
| Explicit file staging | Prevents accidental secret/binary commits; `git add -A` never used |
| Separate git-status.yaml | Addon tracks git metadata in its own file; never modifies BMad Method's sprint-status.yaml |

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
