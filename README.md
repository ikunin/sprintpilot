# BMAD Autopilot Add-On v1.0.16

[![npm version](https://img.shields.io/npm/v/bmad-autopilot-addon.svg?style=flat)](https://www.npmjs.com/package/bmad-autopilot-addon)
[![npm downloads](https://img.shields.io/npm/dm/bmad-autopilot-addon.svg?style=flat)](https://www.npmjs.com/package/bmad-autopilot-addon)
[![License MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat)](LICENSE)
[![BMAD Method](https://img.shields.io/badge/BMAD-v6.2%2B-green.svg?style=flat)](https://github.com/bmad-code-org/BMAD-METHOD)
[![Node.js](https://img.shields.io/badge/node-%3E%3D14-brightgreen.svg?style=flat)](https://nodejs.org)
[![Tools](https://img.shields.io/badge/tools-9%20supported-orange.svg?style=flat)](#supported-tools)
[![GitHub stars](https://img.shields.io/github/stars/ikunin/bmad-autopilot-addon.svg?style=flat)](https://github.com/ikunin/bmad-autopilot-addon/stargazers)

Autonomous end-to-end software delivery powered by the [BMAD Method](https://github.com/bmad-code-org/BMAD-METHOD). One command takes your project from sprint plan to reviewed, tested, PR-ready code — with full git workflow and multi-agent intelligence.

## Included Skills

| Skill | Description |
|-------|-------------|
| `/bmad-autopilot-on` | Engage autonomous sprint execution |
| `/bmad-autopilot-off` | Disengage and show status |
| `/bmad-ma-code-review` | Parallel 3-layer adversarial code review |
| `/bmad-ma-codebase-map` | 5-stream brownfield codebase analysis |
| `/bmad-ma-assess` | Tech debt and dependency audit |
| `/bmad-ma-reverse-architect` | Extract architecture from existing code |
| `/bmad-ma-migrate` | Legacy migration planning |
| `/bmad-ma-research` | Parallel web research fan-out |
| `/bmad-ma-party-mode` | Multi-persona agent discussions |

## The Problem

BMAD provides a structured development workflow with 50+ skills and agent personas. But using it manually means invoking each skill one at a time, navigating menus, making routine decisions, and handling git operations yourself. For a sprint with 10 stories across 3 epics, that's dozens of manual steps, context switches, and session restarts.

## The Solution: BMAD Autopilot

```
/bmad-autopilot-on
```

That's it. The autopilot takes over and drives your entire sprint to completion:

### What it does, story by story

1. **Reads your sprint plan** — picks the next story from `sprint-status.yaml`
2. **Creates an isolated worktree** — each story gets its own branch via `git worktree add`, keeping `main` clean
3. **Implements the story** — invokes `bmad-dev-story` which writes code and tests following TDD (RED then GREEN)
4. **Lints the code** — auto-detects your language (Python, JS/TS, Rust, Go, Ruby) and runs the appropriate linter on changed files only
5. **Stages explicitly** — never runs `git add -A`. Stages only changed files with pre-commit checks: secrets scanning, file size limits, binary detection
6. **Commits with conventional messages** — `feat(epic): story title (story-key)` with all placeholders resolved from your sprint artifacts
7. **Runs code review** — invokes `bmad-code-review` on the worktree diff
8. **Applies every patch** — auto-accepts all review findings, commits each fix separately for clean git history
9. **Pushes and creates a PR** (configurable) — auto-detects your platform (GitHub/GitLab) and creates a PR/MR with a detailed body. With `create_pr: false`, merges directly to main instead.
10. **Moves to the next story** — syncs status, exits the worktree, commits artifacts to main, picks up the next story
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

Controlled by `git.push.create_pr` in `_bmad-addons/modules/git/config.yaml`:

**PR flow** (`create_pr: true`, default) — stories are pushed and PRs are created. No auto-merge. Code reaches `main` only after PR approval.

```
main ─────────────────────────────────────────────────────────
  │                                          (artifacts only)
  ├── story/1-1 ──→ push + PR #42 (→ main)
  │        │
  │        └── story/1-2 ──→ push + PR #43 (→ story/1-1)
  │                 │
  │                 └── story/1-3 ──→ push + PR #44 (→ story/1-2)
  │
  Epic 1 complete → retrospective
  → "Ready to merge: PR #42, #43, #44"
```

When previous stories have pending PRs, the autopilot creates **stacked PRs** — each story branches from the previous story's branch and targets it. When a PR is merged on the platform, subsequent PRs automatically retarget.

**Direct merge flow** (`create_pr: false`) — stories are merged to `main` immediately after push:

```
main ── story/1-1 ──→ merge ── story/1-2 ──→ merge ── story/1-3 ──→ merge
```

Each story is fully isolated in its own worktree. No half-finished code on `main`. The autopilot tracks git metadata in its own `git-status.yaml` (commit SHA, push status, PR URL, lint results) — it never modifies BMAD's `sprint-status.yaml`. Implementation artifacts (sprint status, story files, planning docs) are always committed to `main` after each story, regardless of merge strategy.

See [`modules/git/branching-and-pr-strategy.md`](_bmad-addons/modules/git/branching-and-pr-strategy.md) for the full branching and PR decision matrix.

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

> Codebase mapping inspired by [GSD's map-codebase](https://github.com/gsd-build/get-shit-done). Adapted with distinct output format, enriched agent prompts, and BMAD-specific downstream integration.

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
# 1. Install BMAD with the core method and Test Architect module
#    (interactive — you'll be prompted to pick your tool)
npx bmad-method install --modules bmm,tea
```

This installs:
- **BMM** (BMad Method) — the core development workflow with 34+ skills
- **TEA** (Test Architect Enterprise) — risk-based test strategy, ATDD, CI quality gates, test framework scaffolding

For full interactive setup (module *and* tool selection):
```bash
npx bmad-method install
```

```bash
# 2. Install the autopilot add-on (interactive — select your tool when prompted)
npx bmad-autopilot-addon

# 3. Start the autopilot in your IDE
/bmad-autopilot-on
```

See [Supported Tools](#supported-tools) below for the full list of `--tools` values if you prefer non-interactive installs.

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

For non-interactive installs, pass one or more tool keys via `--tools`:
```bash
npx bmad-autopilot-addon install --tools <tool1>,<tool2> --yes
```
Valid values: `claude-code`, `cursor`, `windsurf`, `gemini-cli`, `cline`, `roo`, `trae`, `kiro`, `github-copilot`, or `all`.

## Git Platforms

| Platform | CLI | Auto-Detect | API Fallback |
|----------|-----|-------------|-------------|
| GitHub | `gh` | `github.com` | No |
| GitLab | `glab` | `gitlab.*` | No |
| Bitbucket | `bb` | `bitbucket.org` | Yes (`BITBUCKET_TOKEN`) |
| Gitea | `tea` | Explicit config | Yes (`GITEA_TOKEN` + `base_url`) |

No CLI installed? The addon falls back to **git_only mode** (direct merge, no PRs).

To explicitly choose between PR and direct merge regardless of platform:
```yaml
# _bmad-addons/modules/git/config.yaml
git:
  push:
    create_pr: true   # PR flow (default) — push + PR, no auto-merge
    create_pr: false  # Direct merge — merge to main after each story
```

## Supported Languages (Linting)

| Language | Linters | Language | Linters |
|----------|---------|----------|---------|
| Python | ruff, flake8, pylint | Java | checkstyle, pmd |
| JavaScript/TS | eslint, biome | C/C++ | cppcheck, clang-tidy |
| Rust | cargo clippy | C# | dotnet format |
| Go | golangci-lint | Swift | swiftlint |
| Ruby | rubocop | PL/SQL | sqlfluff |
| Kotlin | ktlint, detekt | PHP | phpstan, phpcs |

First found wins per language. Multi-language projects (monorepos) lint all languages in one pass. See [Extending](docs/EXTENDING.md) to add more.

## Configuration

All settings live in two YAML files — edit after install to customize behavior.

### Git Workflow (`_bmad-addons/modules/git/config.yaml`)

| Setting | Default | Description |
|---------|---------|-------------|
| `git.enabled` | `true` | Enable/disable all git operations |
| `git.base_branch` | `main` | Branch PRs target |
| `git.branch_prefix` | `story/` | Story branch naming (e.g., `story/1-2-user-auth`) |
| `git.lint.enabled` | `true` | Lint changed files after implementation |
| `git.lint.blocking` | `false` | `true` = lint errors halt autopilot |
| `git.push.auto` | `true` | Auto-push branches after commit |
| `git.push.create_pr` | `true` | Create PR (`false` = direct merge to base branch) |
| `git.platform.provider` | `auto` | `auto` \| `github` \| `gitlab` \| `bitbucket` \| `gitea` \| `git_only` |
| `git.lock.stale_timeout_minutes` | `30` | Auto-remove orphaned lock files |
| `git.worktree.cleanup_on_merge` | `true` | Delete worktrees after merge |

### Multi-Agent (`_bmad-addons/modules/ma/config.yaml`)

| Setting | Default | Description |
|---------|---------|-------------|
| `multi_agent.enabled` | `true` | Enable parallel agent skills |
| `multi_agent.max_parallel_research` | `3` | Concurrent research agents per batch |
| `multi_agent.max_parallel_analysis` | `5` | Concurrent codebase analysis agents |

See the [Configuration Reference](docs/CONFIGURATION.md) for the full list.

## Requirements

- [BMAD Method](https://github.com/bmad-code-org/BMAD-METHOD) v6.2.0+
- A supported AI code agent (see table above)
- Git repository with at least one commit
- Platform CLI for PR creation (optional — see table above)

## Documentation

- [Installation Guide](docs/INSTALLATION.md)
- [Usage Guide](docs/USAGE.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Configuration Reference](docs/CONFIGURATION.md)
- [Extending (Platforms & Languages)](docs/EXTENDING.md)
- [Contributing](docs/CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## License

MIT
