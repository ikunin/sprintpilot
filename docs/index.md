# Project Documentation Index

## Project Overview

- **Type:** Monolith — CLI tool / AI coding tool add-on
- **Primary Languages:** Shell (Bash), Markdown
- **Architecture:** Additive add-on layered on BMad Method
- **Supported Tools:** Claude Code, Cursor, Windsurf, Cline, Roo, Trae, Kiro, GitHub Copilot, Gemini CLI

### Quick Reference

- **Framework:** BMad Method >=6.2.0
- **Entry Point:** `_Sprintpilot/install.sh` (installation), `/sprint-autopilot-on` (execution)
- **Architecture Pattern:** Skills-as-prompts + shell script infrastructure
- **Test Suite:** 80 BATS unit tests + 2 Vitest e2e suites

## Generated Documentation

- [Project Overview](./project-overview.md)
- [Source Tree Analysis](./source-tree-analysis.md)
- [Component Inventory](./component-inventory.md)
- [Development Guide](./development-guide.md)

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

1. **Install BMAD:** `npx bmad-method` in your project
2. **Install addon:** `npx sprintpilot`
3. **Start autopilot:** `/sprint-autopilot-on` in your AI coding tool

For detailed setup, see the [Installation Guide](./INSTALLATION.md).
