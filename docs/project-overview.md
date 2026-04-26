# Project Overview

## Sprintpilot

**Autonomous end-to-end software delivery powered by the BMad Method.**

One command (`/sprint-autopilot-on`) takes a project from sprint plan to reviewed, tested, PR-ready code — with full git workflow and multi-agent intelligence.

## Purpose

BMad Method provides a structured AI-driven development workflow with 50+ skills and agent personas. Using it manually means invoking each skill one at a time, navigating menus, and handling git operations yourself. The Autopilot Add-On automates the entire sprint lifecycle: story creation, TDD implementation, code review, patching, linting, git branching, PR creation, and session management.

## Project Type

- **Type:** npm CLI + BMad Method addon
- **Repository:** Monolith
- **Primary Languages:** Node.js (zero-runtime-dep helper scripts), Markdown (skill prompts), YAML (config)
- **Test Languages:** TypeScript (Vitest)
- **License:** Apache 2.0

## Technology Stack

| Category | Technology | Version | Purpose |
|----------|-----------|---------|---------|
| Runtime | Node.js | >= 18 | Script execution (cross-platform; no Bash dependency at runtime) |
| Skill Engine | Markdown | - | AI prompt-based skill definitions |
| Base Framework | BMad Method | >= 6.2.0 | Structured AI development workflow |
| Test Runner | Vitest | ^3.0.0 | Unit, integration, and e2e tests |
| Test Language | TypeScript | ^5.7.0 | Test implementation |
| Package Manager | npm | - | Distribution + test dependencies |
| Version Control | Git | >= 2.5 (>= 2.18 for submodule speedups) | Worktree-based isolation |
| AI Tools | Claude Code, Cursor, Windsurf, Cline, Roo, Trae, Kiro, GitHub Copilot, Gemini CLI | - | Any of 9 supported coding agents |

## Architecture

- **Additive design**: Layers on top of BMad Method without modifying core BMad Method files
- **Skills as prompts**: Skill definitions are markdown files interpreted by AI tools
- **Scripts as infrastructure**: Shell scripts handle deterministic operations (git, lint, staging)
- **Multi-tool support**: Installs into 9 AI coding tools (Claude Code, Cursor, Windsurf, Cline, Roo, Trae, Kiro, GitHub Copilot, Gemini CLI)
- **Platform abstraction**: Supports GitHub, GitLab, Bitbucket, Gitea, and git-only workflows

## Key Capabilities

1. **Autonomous sprint execution** — reads sprint plan, implements stories end-to-end
2. **Adaptive process scaling (v2)** — `complexity_profile` selects nano (one-shot) / small / medium / large / legacy flow
3. **Git workflow integration** — worktree isolation, explicit staging, stacked PRs, story / epic granularity
4. **Multi-agent intelligence** — parallel code review (3 layers), codebase mapping (5 streams), migration planning (4 agents)
5. **Parallel story dispatch** — when host supports concurrent subagents, the autopilot dispatches independent stories from a DAG layer in parallel (Claude Code today; Gemini CLI experimentally)
6. **Auto-inferred story DAG** — autopilot infers inter-story dependencies once after `bmad-sprint-planning`; hand-authored sidecars are detected and respected
7. **Phase timing instrumentation** — `mark` API + auto-emit on critical paths; hotspot reports surface phases > 5% of total time
8. **Session management** — profile-aware checkpoints, crash recovery, orphaned worktree detection, fresh-context finalize
9. **Multi-language linting** — 14 languages with configurable linter chains
10. **Security-first commits** — secrets scanning, file size limits, binary detection

## Repository Structure

| Directory | Purpose |
|-----------|---------|
| `bin/` | npm CLI entry point (`sprintpilot install / uninstall / check-update`) |
| `lib/` | Installer runtime (Node.js, zero-third-party-dep) |
| `_Sprintpilot/` | Addon payload — copied into target projects by `sprintpilot install` |
| `_Sprintpilot/scripts/` | ~30 Node.js scripts (git ops, profile, timing, DAG, dispatch, shards) |
| `_Sprintpilot/lib/runtime/` | Shared zero-dep helpers (args, git, http, log, secrets, spawn, text, yaml-lite) |
| `_Sprintpilot/skills/` | 10 addon-owned skills with 19 subagent prompts |
| `_Sprintpilot/modules/autopilot/profiles/` | v2 profile YAMLs (base+overlay) |
| `_Sprintpilot/modules/git/` | Git workflow config + platform.yaml |
| `_Sprintpilot/modules/ma/` | Multi-agent + parallelism config |
| `tests/unit/` | 535 Vitest unit + integration tests |
| `tests/e2e/` | End-to-end suites (greenfield, brownfield, sudoku, medium-parallel, nano) |
| `docs/` | Project documentation |

## Links

- [Architecture](./ARCHITECTURE.md) — Design principles and mechanisms
- [Source Tree Analysis](./source-tree-analysis.md) — Annotated directory structure
- [Configuration Reference](./CONFIGURATION.md) — All configuration options
- [Installation Guide](./INSTALLATION.md) — Setup for all supported tools
- [Usage Guide](./USAGE.md) — How to use the autopilot
- [Contributing](./CONTRIBUTING.md) — Developer guide
- [Extending](./EXTENDING.md) — Adding platforms and linters
