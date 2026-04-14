# Usage Guide

## System Prompt Enforcement

After installation, every AI agent session starts with BMAD awareness. The installer creates system prompt files that tell the agent:

- This project uses the BMAD Method
- The 7-step story sequence is **mandatory** — no skipping steps
- Git safety rules are enforced (no `git add -A`, no secrets)
- Available skills and how to get started

This means you don't need to tell the agent about BMAD — it already knows. If you ask the agent to "implement feature X", it will follow the BMAD story sequence automatically.

### How it works per tool

**Claude Code** uses a two-file pattern:
- `CLAUDE.md` contains a single line: `@AGENTS.md` (an include directive)
- `AGENTS.md` contains the BMAD enforcement rules (the 7-step sequence, git rules, skill reference)

**Cursor, Roo, Kiro, Trae** get a dedicated `bmad.md` file in their rules directory (e.g., `.cursor/rules/bmad.md`).

**Windsurf, Cline, Gemini CLI, GitHub Copilot** get the enforcement block appended to their shared system prompt file with markers for safe update/removal.

All tools reference `_bmad-addons/BMAD.md` for the full skill catalog. The enforcement rules are in `_bmad-addons/templates/agent-rules.md`.

---

## Git-Enhanced Autopilot

### Starting the Autopilot

In the coding agent of your choice, invoke:

```
/bmad-autopilot-on
```

The autopilot will:
1. Acquire a lock (prevents concurrent sessions)
2. Detect your git platform (GitHub/GitLab/git_only)
3. Check for orphaned worktrees from previous sessions
4. Resume from saved state or assess the project fresh
5. Execute stories with automatic git operations

### What Happens During a Story

For each story, the autopilot:

1. **Creates a worktree** via `git worktree add` — isolates the story's code changes on branch `story/{sanitized-key}`
3. **Runs `bmad-dev-story`** in the worktree — writes code and tests
4. **Lints** changed files (language-aware, errors-first output)
5. **Stages** files explicitly (never `git add -A`) with pre-commit checks
6. **Commits** with a conventional message: `feat({epic}): {title} ({key})`
7. **Runs `bmad-code-review`** — applies all patch findings as separate commits
8. **Pushes** the branch and creates a PR/MR
9. **Exits the worktree** and syncs status to the project root
10. At epic completion: runs retrospective, lists all PRs, suggests merge

### Stopping the Autopilot

```
/bmad-autopilot-off
```

This produces a status report with git information and releases the lock.

### Updating the Add-On

Check for updates and install them from within your coding agent:

```
/bmad-addon-update
```

This compares your installed version against npm, shows what's new, and asks for confirmation before updating. You can also check from the terminal: `npx bmad-autopilot-addon check-update`.

### Session Management

The autopilot checkpoints after every 3 stories (configurable). It saves state to `_bmad-output/implementation-artifacts/autopilot-state.yaml` and asks you to start a new session:

```
/bmad-autopilot-on    # resumes exactly where it left off
```

The state file tracks:
- Current story and BMAD step in progress
- Stories completed this session
- Remaining stories in the sprint
- Next skill to invoke
- Git platform detected
- Whether a worktree is active
- PR target branch (for stacked PRs)

All fields are persisted on every state write to prevent data loss across sessions. If `next_skill` is empty on resume, the autopilot recovers by re-reading `sprint-status.yaml` and determining the correct next step for the first undone story.

This file is deleted automatically when the sprint completes.

### Submodules

If your project uses git submodules (`.gitmodules` present), the autopilot automatically initializes them when creating worktrees. Initialization times out after 30 seconds (configurable via `worktree.submodule_timeout` in config). If timeout occurs (e.g., auth required), the autopilot warns and continues without submodules.

### Crash Recovery

If a session crashes, the next `/bmad-autopilot-on` will:

1. **Remove stale locks** — locks older than 30 minutes are auto-removed
2. **Health check worktrees** — scans `.worktrees/` for orphaned directories
3. **Classify each worktree**:
   - **COMMITTED** — branch has commits beyond main. Pushed and PR created automatically.
   - **CLEAN_DONE** — story is marked done, worktree is clean. Removed.
   - **STALE** — no commits beyond main. Work was lost. Removed.
   - **DIRTY** — uncommitted changes. You are prompted: stash, commit, or discard.
   - **ORPHAN** — worktree exists but branch was deleted. Removed.
4. **Resume** — reads `autopilot-state.yaml` and continues from the saved step

---

## Multi-Agent Skills

### Parallel Code Review

```
/bmad-ma-code-review
```

Launches 3 review agents simultaneously:
- **Blind Hunter** — adversarial review from diff only (no project context)
- **Edge Case Hunter** — boundary conditions with full project access
- **Acceptance Auditor** — verifies acceptance criteria are met

Results are triaged into PATCH (apply), WARN (note), DISMISS (false positive), or DECISION_NEEDED (contradictory findings).

### Codebase Analysis (Brownfield)

```
/bmad-ma-codebase-map
```

Launches 5 analysis agents in parallel:
- **Stack Analyzer** — languages, frameworks, versions, build tools
- **Architecture Mapper** — modules, patterns, entry points, data flow
- **Quality Assessor** — tests, CI/CD, conventions, code metrics
- **Concerns Hunter** — TODOs, deprecated APIs, security issues, dead code
- **Integration Mapper** — external APIs, databases, env vars, cloud services

Outputs to `_bmad-output/codebase-analysis/`.

### Tech Debt Assessment

```
/bmad-ma-assess
```

Runs after `bmad-ma-codebase-map`. Launches 3 agents:
- **Dependency Auditor** — CVEs, outdated packages, deprecations
- **Debt Classifier** — categorizes and prioritizes tech debt
- **Migration Analyzer** — framework upgrade paths and effort

Produces `brownfield-assessment.md` with prioritized action items.

### Reverse Architecture

```
/bmad-ma-reverse-architect
```

Extracts architecture from existing code. Launches 3 agents:
- **Component Mapper** — module boundaries, public APIs, dependency graph
- **Data Flow Tracer** — request lifecycle, state management, async flows
- **Pattern Extractor** — design patterns, conventions, error handling

Produces BMAD-compatible `architecture.md` that feeds into `bmad-create-epics-and-stories`.

### Migration Planning

```
/bmad-ma-migrate
```

12-step migration workflow for moving from current stack to a target stack. Requires:
- Target stack specification (from user)
- Codebase analysis outputs (from `bmad-ma-codebase-map`)

Launches 4 agents across steps:
- **Stack Mapper** + **Dependency Analyzer** (step 3, parallel)
- **Test Parity Analyzer** (step 9)
- **Risk Assessor** (step 10)

Produces `migration-plan.md`, `migration-epics.md` (BMAD-compatible), and `migration-tracking.yaml`.

### Parallel Research

```
/bmad-ma-research
```

Provide a list of research topics with types (technical/domain/market). Each topic gets its own agent with `WebSearch`/`WebFetch` access. Results are collected and synthesized.

### Party Mode (Parallel)

```
/bmad-ma-party-mode
```

Select 2-3 BMAD personas (architect, PM, QA, dev, etc.) and a topic. Each persona runs as a parallel agent. Supports multiple discussion rounds where personas respond to each other.

---

## Recommended Workflows

### Greenfield Project

```
bmad-product-brief → bmad-create-prd → bmad-create-architecture
    → bmad-create-epics-and-stories → /bmad-autopilot-on
```

### Brownfield Project

```
/bmad-ma-codebase-map → /bmad-ma-assess → /bmad-ma-reverse-architect
    → bmad-create-prd (informed by analysis)
    → bmad-create-epics-and-stories → /bmad-autopilot-on
```

### Migration Project

```
/bmad-ma-codebase-map → /bmad-ma-assess → /bmad-ma-migrate
    → bmad-sprint-planning (from migration epics)
    → /bmad-autopilot-on
```
