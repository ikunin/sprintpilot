# Sprintpilot — Autopilot & Multi-Agent Addon for BMad Method

[![npm version](https://img.shields.io/npm/v/@ikunin/sprintpilot.svg?style=flat)](https://www.npmjs.com/package/@ikunin/sprintpilot)
[![npm downloads](https://img.shields.io/npm/dm/@ikunin/sprintpilot.svg?style=flat)](https://www.npmjs.com/package/@ikunin/sprintpilot)
[![License Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg?style=flat)](LICENSE)
[![BMad Method](https://img.shields.io/badge/BMad%20Method-v6.2%2B-green.svg?style=flat)](https://github.com/bmad-code-org/BMAD-METHOD)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg?style=flat)](https://nodejs.org)
[![Tools](https://img.shields.io/badge/tools-9%20supported-orange.svg?style=flat)](#tools-9-supported)
[![GitHub stars](https://img.shields.io/github/stars/ikunin/sprintpilot.svg?style=flat)](https://github.com/ikunin/sprintpilot/stargazers)

Sprintpilot drives [BMad Method](https://github.com/bmad-code-org/BMAD-METHOD) v6 sprints to completion autonomously. One command turns your sprint plan into reviewed, tested, PR-ready code — story by story, with full git workflow and multi-agent intelligence.

BMad Method's manual flow is dozens of skills, menus, and git operations per story. Sprintpilot drives all of it for you — one command per sprint.

> **Independent project.** Sprintpilot is not affiliated with or endorsed by BMad Code, LLC. See [TRADEMARK.md](TRADEMARK.md).
>
> **Migrating from `bmad-autopilot-addon` v1?** See [MIGRATION.md](MIGRATION.md). `sprintpilot install` auto-detects v1 and cleanly replaces it.

## Quick Start

```bash
# 1. Install BMad Method (interactive — pick your tool when prompted)
npx bmad-method install --modules bmm,tea

# 2. Install Sprintpilot (interactive — pick tool + complexity profile)
npx @ikunin/sprintpilot@latest

# 3. In your IDE, run:
/sprint-autopilot-on
```

Non-interactive install:

```bash
npx @ikunin/sprintpilot@latest install --tools claude-code --profile medium --yes
```

Runs on Windows, macOS, and Linux — every workflow call site is portable across bash, zsh, Git Bash, PowerShell, and cmd.

## What It Does, Story by Story

When you run `/sprint-autopilot-on`, the autopilot drives your entire sprint to completion:

1. **Reads your sprint plan** — picks the next story from `sprint-status.yaml`
2. **Creates an isolated worktree** — each story gets its own branch via `git worktree add`, keeping `main` clean
3. **Implements the story** — invokes `bmad-dev-story`, which writes code and tests following TDD (RED then GREEN)
4. **Lints the code** — auto-detects your language and runs the right linter on changed files only (not the whole repo)
5. **Stages explicitly** — never `git add -A`. Only changed files, with secrets / size / binary pre-commit checks.
6. **Commits with conventional messages** — `feat(epic): story title (story-key)`, placeholders resolved from your sprint artifacts
7. **Runs parallel code review** — three reviewers in parallel (see [Multi-Agent Intelligence](#multi-agent-intelligence))
8. **Applies every patch finding** — auto-accepts review fixes, commits each one separately for clean history
9. **Pushes and creates a PR** (configurable) — auto-detects GitHub / GitLab / Bitbucket / Gitea. With `create_pr: false`, merges directly to `main`.
10. **Moves to the next story** — exits the worktree, commits artifacts to `main`, picks up the next story
11. **Runs retrospective** per epic — when all stories in an epic are done, lists all PR URLs ready for merge

## What Makes It Autonomous

The autopilot handles everything that normally requires you to be present:

- **Auto-inferred story DAG** — after `bmad-sprint-planning`, the autopilot infers inter-story dependencies once and writes `_Sprintpilot/sprints/dependencies.yaml`. Parallel dispatch works out of the box; no hand-authored deps file required. Hand-authored sidecars are detected and respected silently.
- **Menu navigation** — BMad skills present menus and confirmations. The autopilot auto-selects "Continue" / "Create Mode" and derives answers from your PRD and architecture docs.
- **Decision making** — when a skill asks a design question, the autopilot answers from existing project artifacts. Only truly unanswerable questions pause execution.
- **Session management** — checkpoints state to disk after N stories (configurable). Re-running `/sprint-autopilot-on` in a fresh session resumes exactly where it left off — no work repeated.
- **Crash recovery** — on boot, the autopilot detects orphaned worktrees from a crashed previous run, pushes any committed-but-unpushed work, and cleans up stale state. No lost commits, no manual cleanup.
- **Fresh-context finalize** — when the last story of a sprint completes, the autopilot writes a `sprint-finalize-pending` marker and stops. The next session runs sprint cleanup deterministically in fresh context, eliminating context-rot failures of the final step.

### When it stops (and only when)

The autopilot runs until the sprint is done or hits one of exactly 5 true blockers:

1. A skill needs **original creative input** not in any project document (e.g., product vision for a PRD)
2. A **new external dependency** is needed that isn't in the project
3. **3 consecutive test failures** with no forward progress
4. A **security vulnerability** requiring architectural decisions beyond the story scope
5. **Conflicting acceptance criteria** that can't be resolved from project docs

Everything else — it decides, documents the decision in one sentence, and moves on.

## The Git Workflow

Controlled by `git.push.create_pr` in `_Sprintpilot/modules/git/config.yaml`.

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

When previous stories have pending PRs, the autopilot creates **stacked PRs** — each story branches from the previous story's branch and targets it. Reviewers see each story's diff in isolation while the next story is already in progress. When a PR is merged on the platform, subsequent PRs automatically retarget.

**Direct merge flow** (`create_pr: false`) — stories are merged to `main` immediately after push:

```
main ── story/1-1 ──→ merge ── story/1-2 ──→ merge ── story/1-3 ──→ merge
```

Each story is fully isolated in its own worktree. No half-finished code on `main`. The autopilot tracks git metadata in its own `git-status.yaml` (commit SHA, push status, PR URL, lint results) — it never modifies BMad Method's `sprint-status.yaml`. Implementation artifacts are always committed to `main` after each story, regardless of merge strategy.

Concurrent git operations (parallel pushes, submodule updates, ref locks) are serialized and retry with jittered backoff — safe under parallel dispatch.

See [`modules/git/branching-and-pr-strategy.md`](_Sprintpilot/modules/git/branching-and-pr-strategy.md) for the full decision matrix.

## Adaptive Process Scaling

The right amount of process for a 2-story bug-fix sprint is different from a 30-story green-field rebuild — running the heavy flow on a small change costs more LLM turns, more context rot, more time. One knob picks the right balance:

| Profile | Per-story flow | Branching | Worktrees | Parallel stories | Use it for |
|---------|---------------|-----------|-----------|------------------|-----------|
| `nano` | `bmad-quick-dev` (one-shot) | `epic` (one PR per epic) | off | n/a | Tiny patch sprints, hot-fix runs |
| `small` | Full 7-step BMad cycle | `story` (one PR per story) | on | off | Single-developer projects, ≤10 stories |
| `medium` *(default)* | Full 7-step BMad cycle | `story` | on | off | Default — balanced for most sprints |
| `large` | Full 7-step BMad cycle | `story` | on | **on** (Claude Code) | Multi-epic sprints, 20+ stories |
| `legacy` | Pinned to v1.0.5 behavior byte-for-byte | `story` | on | off | Existing installs that want zero behavior change |

Pick the profile at install time — `--profile <nano|small|medium|large|legacy>` non-interactively. Missing profile defaults to `medium` with no behavior change vs. v1.0.5.

**Nano safety net** — if `bmad-quick-dev` tests fail or its review classifies a finding as `high` severity, the autopilot escalates the session to the full 7-step cycle (session-scoped — never written back to config). Fast track for routine work, full rigor when something needs it.

### v2 optimization layers

Each can be disabled independently per profile in `_Sprintpilot/modules/autopilot/profiles/<profile>.yaml`:

- **Auto-inferred story DAG** — see above.
- **Phase timing instrumentation** — emits `duration` records per skill phase. `summarize-timings.js` reports hotspots over 5% of total runtime, so you can see where a sprint actually spends its time.
- **State sharding** — non-critical writes accumulate in `.pending/` shards, flushed atomically at story boundaries / session checkpoints / sprint complete. Crash-recovery keys still write straight through. This is what makes parallel dispatch safe under contention.
- **Conditional boot work** — on clean repos (main worktree only, no in-progress stories), skips the slow health-check / branch-reconciliation block, saving 8–30s per session. Disabled on `large` and `legacy` profiles, which always run full reconciliation.
- **Cached reads** — TTL + source-mtime aware file cache for hot reads; any writer's mtime advance auto-invalidates without explicit calls.
- **Parallel story dispatch** — when the host supports it, layer-aware dispatch runs N stories concurrently in their own worktrees, then merges their state shards. Claude Code today; Gemini CLI experimentally.

## Multi-Agent Intelligence

Beyond the autopilot, Sprintpilot includes 7 multi-agent skills that launch parallel subagents for tasks that benefit from diverse perspectives.

### Parallel Code Review (`/sprintpilot-code-review`)

Three independent reviewers run **simultaneously** on the same diff — not serially. Each comes with a different bias by design:

| Agent | Perspective | Access |
|-------|------------|--------|
| **Blind Hunter** | Pure adversarial — finds bugs from code alone | Diff only, no project context |
| **Edge Case Hunter** | Boundary conditions, race conditions, missing validation | Full codebase access |
| **Acceptance Auditor** | Verifies every acceptance criterion is met | Diff + story spec |

Results are triaged: duplicates merged, contradictions flagged, findings classified as **PATCH / WARN / DISMISS**. The autopilot auto-accepts every PATCH finding and commits each fix separately.

### Brownfield Analysis Pipeline

> Codebase mapping inspired by [GSD's map-codebase](https://github.com/gsd-build/get-shit-done). Adapted with a distinct output format, enriched agent prompts, and BMad Method-specific downstream integration.

For existing codebases, three skills chain together:

**`/sprintpilot-codebase-map`** — 5 parallel agents scan the codebase simultaneously:
- Stack Analyzer (languages, frameworks, versions)
- Architecture Mapper (modules, patterns, data flow)
- Quality Assessor (tests, CI/CD, conventions)
- Concerns Hunter (TODOs, deprecated APIs, security issues, dead code)
- Integration Mapper (external APIs, databases, env vars)

Output files (`_bmad-output/codebase-analysis/`):

| File | Content |
|------|---------|
| `stack-analysis.md` | Languages, frameworks, versions, runtime requirements, package health |
| `architecture-analysis.md` | Project structure, architectural pattern, module boundaries, data flow |
| `quality-analysis.md` | Test coverage, CI/CD pipeline, code conventions, complexity metrics |
| `concerns-analysis.md` | TODOs/FIXMEs, security issues, dead code, deprecated patterns, error handling gaps |
| `integrations-analysis.md` | External APIs, databases, message queues, cloud services, env vars |

Scanned file types: TypeScript, JavaScript, Python, Java, Go, Rust, Ruby, C, C++, C#, SQL, PL/SQL (`.sps`, `.spb`), XML, Shell.

**`/sprintpilot-assess`** — 3 parallel agents produce actionable findings:
- Dependency Auditor (CVEs, outdated packages, upgrade paths)
- Debt Classifier (prioritized tech debt with effort estimates)
- Migration Analyzer (framework upgrade paths and phased roadmap)

Output: `_bmad-output/codebase-analysis/brownfield-assessment.md` — prioritized findings with severity, confidence, effort, and migration paths.

**`/sprintpilot-reverse-architect`** — 3 parallel agents extract architecture from code:
- Component Mapper (module boundaries, dependency graph)
- Data Flow Tracer (request lifecycle, state management)
- Pattern Extractor (design patterns, conventions, error handling)

Output: `{planning_artifacts}/architecture.md` — BMad Method-compatible, feeds directly into `bmad-create-epics-and-stories`.

### Migration Planning (`/sprintpilot-migrate`)

A 12-step workflow for taking a codebase from one stack to another, with 4 subagent fan-outs:

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
11. Generate BMad Method-compatible epics for sprint planning
12. Finalize migration plan, epics, and tracking artifacts

Output:

| File | Location | Content |
|------|----------|---------|
| `migration-plan.md` | `{planning_artifacts}/` | Strategy, compatibility matrix, coexistence design, phased roadmap, component cards, data/API migration, risk matrix |
| `migration-epics.md` | `{planning_artifacts}/` | Epics with stories, acceptance criteria, effort estimates (BMad Method-compatible) |
| `migration-tracking.yaml` | `{implementation_artifacts}/` | Phase-by-phase progress tracking for sprint execution |

### Research and Discussion

**`/sprintpilot-research`** — fan out research across multiple topics in parallel, each with web search access. Results synthesized into a unified report.

**`/sprintpilot-party-mode`** — launch 2–3 BMad personas (architect, PM, QA, dev, etc.) as parallel agents debating a topic. Multiple rounds where personas respond to each other. Produces consensus points, disagreements, and action items.

## Skills Reference

| Skill | What it does |
|-------|--------------|
| `/sprint-autopilot-on` | Engage autonomous sprint execution |
| `/sprint-autopilot-off` | Disengage and show status |
| `/sprintpilot-update` | Check for updates and install the latest version |
| `/sprintpilot-code-review` | Parallel 3-layer adversarial code review |
| `/sprintpilot-codebase-map` | 5-stream brownfield codebase analysis |
| `/sprintpilot-assess` | Tech debt, dependency audit, migration assessment |
| `/sprintpilot-reverse-architect` | Extract architecture document from existing code |
| `/sprintpilot-migrate` | 12-step legacy migration planning |
| `/sprintpilot-research` | Parallel web research fan-out |
| `/sprintpilot-party-mode` | Multi-persona BMad agent discussions |

## Compatibility

### Tools (9 supported)

Sprintpilot uses the universal SKILL.md format — same skills work everywhere:

| Tool | Directory | Tool | Directory |
|------|-----------|------|-----------|
| Claude Code | `.claude/skills/` | Roo Code | `.roo/skills/` |
| Cursor | `.cursor/skills/` | Trae | `.trae/skills/` |
| Windsurf | `.windsurf/skills/` | Kiro | `.kiro/skills/` |
| Gemini CLI | `.gemini/skills/` | GitHub Copilot | `.github/copilot/skills/` |
| Cline | `.cline/skills/` | | |

For non-interactive installs:

```bash
npx @ikunin/sprintpilot@latest install --tools <tool1>,<tool2> --yes
```

Valid values: `claude-code`, `cursor`, `windsurf`, `gemini-cli`, `cline`, `roo`, `trae`, `kiro`, `github-copilot`, or `all`.

### Git platforms

| Platform | CLI | Auto-detect | API fallback |
|----------|-----|-------------|--------------|
| GitHub | `gh` | `github.com` | No |
| GitLab | `glab` | `gitlab.*` | No |
| Bitbucket | `bb` | `bitbucket.org` | Yes (`BITBUCKET_TOKEN`) |
| Gitea | `tea` | Explicit config | Yes (`GITEA_TOKEN` + `base_url`) |

No CLI installed? Falls back to **git_only mode** (direct merge, no PRs).

### Linters (auto-detected, changed files only)

| Language | Linters | Language | Linters |
|----------|---------|----------|---------|
| Python | ruff, flake8, pylint | Java | checkstyle, pmd |
| JavaScript/TS | eslint, biome | C/C++ | cppcheck, clang-tidy |
| Rust | cargo clippy | C# | dotnet format |
| Go | golangci-lint | Swift | swiftlint |
| Ruby | rubocop | PL/SQL | sqlfluff |
| Kotlin | ktlint, detekt | PHP | phpstan, phpcs |

First found wins per language. Multi-language monorepos lint all languages in one pass. See [Extending](docs/EXTENDING.md) to add more.

## Configuration

All settings live in YAML files under `_Sprintpilot/modules/`. Most projects only ever change a handful — the rest have sensible profile-aware defaults.

**Most-tweaked settings:**

| Setting | File | Default | What it controls |
|---------|------|---------|------------------|
| `complexity_profile` | `autopilot/config.yaml` | `medium` | One of `nano`/`small`/`medium`/`large`/`legacy` — picks the per-story flow + which v2 layers are enabled |
| `git.push.create_pr` | `git/config.yaml` | `true` | `true` = push + PR (no auto-merge), `false` = direct merge to base branch |
| `git.lint.blocking` | `git/config.yaml` | `false` | `true` = lint errors halt the autopilot |
| `autopilot.session_story_limit` | `autopilot/config.yaml` | `3` (nano: `5`) | Stories per session before checkpoint. `0` = unlimited |
| `multi_agent.enabled` | `ma/config.yaml` | `true` | Enable parallel agent skills |

**Profile-level overrides** — settings like `parallel_stories`, `state_sharding`, `phase_timings`, `cache_shared_reads`, and `conditional_boot_work` live in profile files at `_Sprintpilot/modules/autopilot/profiles/<profile>.yaml`, not in `autopilot/config.yaml` or `ma/config.yaml`. Their effective value depends on the active `complexity_profile`.

See the [Configuration Reference](docs/CONFIGURATION.md) for every setting, default, and profile-level override.

## Requirements

- [BMad Method](https://github.com/bmad-code-org/BMAD-METHOD) v6.2.0+
- A supported AI code agent (see [Tools](#tools-9-supported))
- Git repository with at least one commit
- Platform CLI for PR creation (optional — see [Git platforms](#git-platforms))

## Documentation

- [Installation Guide](docs/INSTALLATION.md)
- [Usage Guide](docs/USAGE.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Configuration Reference](docs/CONFIGURATION.md)
- [Extending (Platforms & Languages)](docs/EXTENDING.md)
- [Contributing](docs/CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## License

Apache 2.0
