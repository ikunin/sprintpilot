# Usage Guide

## System Prompt Enforcement

After installation, every AI agent session starts with BMAD awareness. The installer creates system prompt files (e.g., `CLAUDE.md` + `AGENTS.md` for Claude Code) that tell the agent:

- This project uses the BMAD Method
- The 7-step story sequence is **mandatory** — no skipping steps
- Git safety rules are enforced (no `git add -A`, no secrets)
- Available skills and how to get started

This means you don't need to tell the agent about BMAD — it already knows. If you ask the agent to "implement feature X", it will follow the BMAD story sequence automatically.

The full skill reference lives at `_bmad-addons/BMAD.md`. The enforcement rules are in `_bmad-addons/templates/agent-rules.md`.

---

## Git-Enhanced Autopilot

### Starting the Autopilot

In Claude Code, invoke:

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

1. **Creates a worktree** via `EnterWorktree` — isolates the story's code changes
2. **Renames the branch** to `story/{sanitized-key}`
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

### Session Management

The autopilot checkpoints after every 3 stories (configurable). It saves state to `autopilot-state.yaml` and asks you to start a new Claude Code session:

```
/bmad-autopilot-on    # resumes exactly where it left off
```

### Crash Recovery

If a session crashes, the next `/bmad-autopilot-on` will:
- Detect and remove stale locks (>30 min old)
- Find orphaned worktrees and classify them:
  - **Committed work**: pushes the branch and creates PR
  - **No commits**: removes the stale worktree
  - **Dirty**: warns you and asks how to proceed

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
