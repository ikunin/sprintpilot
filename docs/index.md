# Project Documentation Index

## Project Overview

- **Type:** Monolith — npm CLI + BMad Method addon
- **Primary Languages:** Node.js (zero-runtime-dep helper scripts), Markdown (skill prompts), YAML (config)
- **Test Languages:** TypeScript (Vitest)
- **Architecture:** Additive addon layered on BMad Method, profile-driven adaptive scaling (v2)
- **Supported Tools:** Claude Code, Cursor, Windsurf, Cline, Roo, Trae, Kiro, GitHub Copilot, Gemini CLI

### Quick Reference

- **Framework:** BMad Method >= 6.2.0
- **Runtime:** Node.js >= 18 (no Bash dependency at runtime)
- **Entry Point:** `bin/sprintpilot.js install` (installation), `/sprint-autopilot-on` (execution)
- **Architecture Pattern:** Skills-as-prompts + Node.js script infrastructure + complexity profiles
- **Test Suite:** 535 unit + integration tests (Vitest) + 5 e2e suites (gated on Claude Code presence)

## Generated Documentation

- [Project Overview](./project-overview.md)
- [Source Tree Analysis](./source-tree-analysis.md)
- [Component Inventory](./component-inventory.md)
- [Development Guide](./development-guide.md)

## V2 Design Notes

- [Adaptive Process Scaling](./adaptive-process-scaling.md) — concept, profiles, rollout
- [Implementation Plan](./implementation-plan.md) — 12-PR roadmap
- [Implementation Decisions](./implementation-decisions.md) — per-PR rationale

## Existing Documentation

- [Architecture](./ARCHITECTURE.md) — Design principles, mechanisms, and survivability guarantees
- [Configuration Reference](./CONFIGURATION.md) — All git, lint, push, PR, worktree, lock, and platform settings
- [Installation Guide](./INSTALLATION.md) — Multi-tool setup, platform CLI config, troubleshooting
- [Usage Guide](./USAGE.md) — Autopilot workflow, session management, crash recovery, multi-agent skills
- [Contributing](./CONTRIBUTING.md) — Project structure, conventions, script/skill creation guides
- [Extending](./EXTENDING.md) — Adding new git platforms and language linters
- [Changelog](../CHANGELOG.md) — Version history
- [README](../README.md) — Comprehensive project introduction with workflow diagrams

## Getting Started

1. **Install BMad Method:** `npx bmad-method` in your project
2. **Install addon:** `npx @ikunin/sprintpilot@latest`
3. **Start autopilot:** `/sprint-autopilot-on` in your AI coding tool

For detailed setup, see the [Installation Guide](./INSTALLATION.md).
