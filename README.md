# BMAD Autopilot Add-On

Autonomous end-to-end software delivery powered by the [BMAD Method](https://github.com/bmad-code-org/BMAD-METHOD). One command takes your project from sprint plan to reviewed, tested, PR-ready code — with full git workflow and multi-agent intelligence.

## The Problem

BMAD provides a structured development workflow with 50+ skills and agent personas. But using it manually means invoking each skill one at a time, navigating menus, making routine decisions, and handling git operations yourself. For a sprint with 10 stories across 3 epics, that's dozens of manual steps, context switches, and session restarts.

## The Solution: BMAD Autopilot

```
/bmad-autopilot-on
```

That's it. The autopilot takes over and drives your entire sprint to completion:

### What it does, story by story

1. **Reads your sprint plan** — picks the next story from `sprint-status.yaml`
2. **Creates an isolated worktree** — each story gets its own branch via `EnterWorktree`, keeping `main` clean
3. **Implements the story** — invokes `bmad-dev-story` which writes code and tests following TDD (RED then GREEN)
4. **Lints the code** — auto-detects your language (Python, JS/TS, Rust, Go, Ruby) and runs the appropriate linter on changed files only
5. **Stages explicitly** — never runs `git add -A`. Stages only changed files with pre-commit checks: secrets scanning, file size limits, binary detection
6. **Commits with conventional messages** — `feat(epic): story title (story-key)` with all placeholders resolved from your sprint artifacts
7. **Runs code review** — invokes `bmad-code-review` on the worktree diff
8. **Applies every patch** — auto-accepts all review findings, commits each fix separately for clean git history
9. **Pushes and creates a PR** — auto-detects your platform (GitHub/GitLab) and creates a PR/MR with a detailed body
10. **Moves to the next story** — syncs status, exits the worktree, picks up the next story
11. **Runs retrospective** — when all stories in an epic are done, runs `bmad-retrospective` and lists all PR URLs for merge

### What makes it autonomous

The autopilot handles everything that normally requires you to be present:

- **Menu navigation** — BMAD skills present menus, confirmations, and choices. The autopilot auto-selects "Continue", "Create Mode", and makes context-appropriate decisions from your PRD and architecture docs.
- **Decision making** — when a skill asks a design question, the autopilot derives the answer from existing project artifacts (PRD, architecture, story specs). Only truly unanswerable questions pause execution.
- **Session management** — after 3 stories, the autopilot checkpoints state to disk and tells you to start a fresh session. `/bmad-autopilot-on` in the new session resumes exactly where it left off. No work is ever repeated.
- **Crash recovery** — if a session crashes mid-story, the next boot detects orphaned worktrees, recovers committed work (pushes it), and cleans up stale state.

### When it stops (and only when)

The autopilot runs until the sprint is done or hits one of exactly 5 true blockers:

1. A skill needs **original creative input** not in any project document (e.g., product vision for a PRD)
2. A **new external dependency** is needed that isn't in the project
3. **3 consecutive test failures** with no forward progress
4. A **security vulnerability** requiring architectural decisions beyond the story scope
5. **Conflicting acceptance criteria** that can't be resolved from project docs

Everything else — it decides, documents the decision in one sentence, and moves on.

### The git workflow in detail

```
                    Your main branch stays clean
                              |
     ┌────────────────────────┼────────────────────────┐
     |                        |                        |
  story/1-1              story/1-2              story/1-3
  ┌──────────┐          ┌──────────┐          ┌──────────┐
  │ worktree │          │ worktree │          │ worktree │
  │          │          │          │          │          │
  │ code     │          │ code     │          │ code     │
  │ tests    │          │ tests    │          │ tests    │
  │ lint     │          │ lint     │          │ lint     │
  │ commit   │          │ commit   │          │ commit   │
  │ review   │          │ review   │          │ review   │
  │ patches  │          │ patches  │          │ patches  │
  │ push     │          │ push     │          │ push     │
  │ PR #42   │          │ PR #43   │          │ PR #44   │
  └──────────┘          └──────────┘          └──────────┘
     |                        |                        |
     └────────────────────────┼────────────────────────┘
                              |
                     Epic 1 complete
                     → retrospective
                     → "Ready to merge: PR #42, #43, #44"
```

Each story is fully isolated. No half-finished code on `main`. Every story has its own branch, its own commits, its own PR. The autopilot tracks everything in `sprint-status.yaml` with git fields (commit SHA, push status, PR URL, lint results).

---

## Multi-Agent Intelligence

Beyond the autopilot, the add-on includes 7 multi-agent skills that launch parallel subagents for tasks that benefit from diverse perspectives:

### Parallel Code Review (`/bmad-ma-code-review`)

Three independent reviewers run simultaneously on the same diff:

| Agent | Perspective | Access |
|-------|------------|--------|
| **Blind Hunter** | Pure adversarial — finds bugs from code alone | Diff only, no project context |
| **Edge Case Hunter** | Boundary conditions, race conditions, missing validation | Full codebase access |
| **Acceptance Auditor** | Verifies every acceptance criterion is met | Diff + story spec |

Results are triaged: duplicates merged, contradictions flagged, findings classified as PATCH / WARN / DISMISS.

### Brownfield Analysis Pipeline

For existing codebases, three skills chain together:

**`/bmad-ma-codebase-map`** — 5 parallel agents scan the codebase simultaneously:
- Stack Analyzer (languages, frameworks, versions)
- Architecture Mapper (modules, patterns, data flow)
- Quality Assessor (tests, CI/CD, conventions)
- Concerns Hunter (TODOs, deprecated APIs, security issues, dead code)
- Integration Mapper (external APIs, databases, env vars)

**`/bmad-ma-assess`** — 3 parallel agents produce actionable findings:
- Dependency Auditor (CVEs, outdated packages, upgrade paths)
- Debt Classifier (prioritized tech debt with effort estimates)
- Migration Analyzer (framework upgrade paths and phased roadmap)

**`/bmad-ma-reverse-architect`** — 3 parallel agents extract architecture from code:
- Component Mapper (module boundaries, dependency graph)
- Data Flow Tracer (request lifecycle, state management)
- Pattern Extractor (design patterns, conventions, error handling)

Output: a BMAD-compatible `architecture.md` that feeds directly into `bmad-create-epics-and-stories`.

### Migration Planning (`/bmad-ma-migrate`)

A 12-step workflow for taking a codebase from one stack to another. 4 subagent fan-outs across the process:

1. Validate prerequisites and get target stack from user
2. Auto-recommend migration strategy (strangler fig / big bang / branch-by-abstraction / parallel run)
3. **Parallel**: Stack Mapper + Dependency Analyzer produce compatibility matrix
4. Design coexistence layer (old + new code running together)
5. Build phased roadmap ordered by dependency graph
6. Generate per-component migration cards with effort/risk
7. Plan data migration (schema changes, dual-write, backfill)
8. Design API compatibility (versioning, deprecation timeline)
9. **Parallel**: Test Parity Analyzer maps old tests to new equivalents
10. **Parallel**: Risk Assessor produces per-phase risk matrix with rollback triggers
11. Generate BMAD-compatible epics for sprint planning
12. Finalize migration plan, epics, and tracking artifacts

### Research and Discussion

**`/bmad-ma-research`** — Fan out research across multiple topics in parallel, each with web search access. Results synthesized into a unified report.

**`/bmad-ma-party-mode`** — Launch 2-3 BMAD personas (architect, PM, QA, dev, etc.) as parallel agents debating a topic. Multiple rounds where personas respond to each other. Produces consensus points, disagreements, and action items.

---

## Quick Start

```bash
# 1. Install BMAD (if not already)
npx bmad-method install --modules bmm --tools claude-code --yes

# 2. Install the add-on (interactive tool selection)
bash _bmad-addons/install.sh

# Or specify tools directly:
bash _bmad-addons/install.sh --tools claude-code,cursor

# Or install for all supported tools:
bash _bmad-addons/install.sh --tools all

# 3. Start the autopilot in your IDE
/bmad-autopilot-on
```

## Supported Tools

The add-on uses the universal SKILL.md format — same skills work across all 9 tools:

| Tool | Directory |
|------|-----------|
| Claude Code | `.claude/skills/` |
| Cursor | `.cursor/skills/` |
| Windsurf | `.windsurf/skills/` |
| Gemini CLI | `.gemini/skills/` |
| Cline | `.cline/skills/` |
| Roo Code | `.roo/skills/` |
| Trae | `.trae/skills/` |
| Kiro | `.kiro/skills/` |
| GitHub Copilot | `.github/copilot/skills/` |

```bash
bash _bmad-addons/install.sh --tools claude-code,cursor,gemini-cli
```

## Requirements

- [BMAD Method](https://github.com/bmad-code-org/BMAD-METHOD) v6.2.0+
- A supported AI code agent (see table above)
- Git repository with at least one commit
- `gh` (GitHub CLI) or `glab` (GitLab CLI) for PR creation (optional)

## Documentation

- [Installation Guide](docs/INSTALLATION.md)
- [Usage Guide](docs/USAGE.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Configuration Reference](docs/CONFIGURATION.md)
- [Contributing](docs/CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## License

MIT
