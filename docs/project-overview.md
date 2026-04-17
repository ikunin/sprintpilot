# Project Overview

## Sprintpilot

**Autonomous end-to-end software delivery powered by the BMad Method.**

One command (`/sprint-autopilot-on`) takes a project from sprint plan to reviewed, tested, PR-ready code — with full git workflow and multi-agent intelligence.

## Purpose

BMAD provides a structured AI-driven development workflow with 50+ skills and agent personas. Using it manually means invoking each skill one at a time, navigating menus, and handling git operations yourself. The Autopilot Add-On automates the entire sprint lifecycle: story creation, TDD implementation, code review, patching, linting, git branching, PR creation, and session management.

## Project Type

- **Type:** CLI tool / AI coding tool add-on
- **Repository:** Monolith
- **Primary Languages:** Shell (Bash), Markdown
- **Test Languages:** TypeScript (Vitest, BATS)
- **License:** Apache 2.0

## Technology Stack

| Category | Technology | Version | Purpose |
|----------|-----------|---------|---------|
| Runtime | Bash | 3.2+ | Script execution (macOS compatible) |
| Skill Engine | Markdown | - | AI prompt-based skill definitions |
| Base Framework | BMad Method | >=6.2.0 | Structured AI development workflow |
| Test Runner (unit) | BATS | - | Shell script unit testing |
| Test Runner (e2e) | Vitest | ^3.0.0 | End-to-end integration testing |
| Test Language | TypeScript | ^5.7.0 | E2E test implementation |
| Package Manager | npm | - | Test dependency management |
| Version Control | Git | - | Worktree-based isolation |
| AI Tools | Claude Code, Cursor, Windsurf, Cline, Roo, Trae, Kiro, GitHub Copilot, Gemini CLI | - | Any of 9 supported coding agents |

## Architecture

- **Additive design**: Layers on top of BMAD without modifying core BMAD files
- **Skills as prompts**: Skill definitions are markdown files interpreted by AI tools
- **Scripts as infrastructure**: Shell scripts handle deterministic operations (git, lint, staging)
- **Multi-tool support**: Installs into 9 AI coding tools (Claude Code, Cursor, Windsurf, Cline, Roo, Trae, Kiro, GitHub Copilot, Gemini CLI)
- **Platform abstraction**: Supports GitHub, GitLab, Bitbucket, Gitea, and git-only workflows

## Key Capabilities

1. **Autonomous sprint execution** — reads sprint plan, implements stories end-to-end
2. **Git workflow integration** — worktree isolation, explicit staging, stacked PRs
3. **Multi-agent intelligence** — parallel code review (3 layers), codebase mapping (5 streams), migration planning (4 agents)
4. **Session management** — checkpoints after 3 stories, crash recovery, orphaned worktree detection
5. **Multi-language linting** — 12+ languages with configurable linter chains
6. **Security-first commits** — secrets scanning, file size limits, binary detection

## Repository Structure

| Directory | Purpose |
|-----------|---------|
| `_Sprintpilot/` | All addon source code (scripts, skills, modules, config) |
| `_Sprintpilot/scripts/` | 8 shell scripts — git operations backbone |
| `_Sprintpilot/skills/` | 9 skill definitions with 19 subagent prompts |
| `_Sprintpilot/modules/` | Module configuration (git, multi-agent) |
| `docs/` | Project documentation |
| `tests/scripts/` | 80+ BATS unit tests for shell scripts |
| `tests/e2e/` | End-to-end integration tests (greenfield + brownfield) |

## Links

- [Architecture](./ARCHITECTURE.md) — Design principles and mechanisms
- [Source Tree Analysis](./source-tree-analysis.md) — Annotated directory structure
- [Configuration Reference](./CONFIGURATION.md) — All configuration options
- [Installation Guide](./INSTALLATION.md) — Setup for all supported tools
- [Usage Guide](./USAGE.md) — How to use the autopilot
- [Contributing](./CONTRIBUTING.md) — Developer guide
- [Extending](./EXTENDING.md) — Adding platforms and linters
