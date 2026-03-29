# Installation Guide

## Prerequisites

1. **BMAD Method v6.2.0+** installed in your project
2. **Claude Code** (CLI, desktop app, or IDE extension)
3. **Git** initialized with at least one commit
4. **Platform CLI** (optional): `gh` for GitHub, `glab` for GitLab, `bb` for Bitbucket, or `tea` for Gitea

## Install BMAD (if needed)

```bash
npx bmad-method install --modules bmm --tools claude-code --yes
```

For test architecture support, add the TEA module:

```bash
npx bmad-method install --modules bmm,tea --tools claude-code --yes
```

## Install the Add-On

### Interactive Install (recommended)

```bash
bash _bmad-addons/install.sh
```

The installer will:
1. Verify BMAD is installed
2. Auto-detect which tools have BMAD configured
3. Prompt you to select target tools (or press Enter to use detected ones)
4. Install 9 skills to each selected tool's skills directory
5. Back up any existing skills before overwriting
6. Add artifact entries to `.gitignore`

### Specify Tools Directly

```bash
# Single tool
bash _bmad-addons/install.sh --tools claude-code

# Multiple tools
bash _bmad-addons/install.sh --tools claude-code,cursor,windsurf

# All supported tools
bash _bmad-addons/install.sh --tools all
```

### Non-Interactive (CI/CD)

```bash
bash _bmad-addons/install.sh --tools claude-code,cursor --yes
```

### Dry Run (preview without changes)

```bash
bash _bmad-addons/install.sh --tools claude-code,cursor --dry-run
```

### Force Install (skip backups)

```bash
bash _bmad-addons/install.sh --tools claude-code --force
```

### Supported Tools

| Tool | Skills Directory | Notes |
|------|-----------------|-------|
| `claude-code` | `.claude/skills/` | CLI, desktop, web, IDE extensions |
| `cursor` | `.cursor/skills/` | Cursor IDE |
| `windsurf` | `.windsurf/skills/` | Windsurf IDE |
| `cline` | `.cline/skills/` | VS Code extension |
| `roo` | `.roo/skills/` | VS Code extension |
| `trae` | `.trae/skills/` | Trae IDE |
| `kiro` | `.kiro/skills/` | Kiro IDE |
| `gemini-cli` | `.gemini/skills/` | Gemini CLI (Google) |
| `github-copilot` | `.github/copilot/skills/` | GitHub Copilot |

All tools use the same universal SKILL.md format.

## Verify Installation

After install, check that skills are available in your tool's directory:

```bash
# For Claude Code
ls .claude/skills/bmad-autopilot-* .claude/skills/bmad-ma-*

# For Cursor
ls .cursor/skills/bmad-autopilot-* .cursor/skills/bmad-ma-*
```

You should see 9 skill directories per tool:
- `bmad-autopilot-on`, `bmad-autopilot-off`
- `bmad-ma-code-review`, `bmad-ma-codebase-map`, `bmad-ma-assess`
- `bmad-ma-reverse-architect`, `bmad-ma-migrate`
- `bmad-ma-research`, `bmad-ma-party-mode`

The installer also creates **system prompt files** that enforce BMAD workflows:

| Tool | File Created |
|------|-------------|
| Claude Code | `CLAUDE.md` (with `@AGENTS.md`) + `AGENTS.md` |
| Cursor | `.cursor/rules/bmad.md` |
| Windsurf | Appends to `.windsurfrules` |
| Cline | Appends to `.clinerules` |
| Gemini CLI | Appends to `GEMINI.md` |
| Others | Tool-specific rules file |

These files tell the AI agent about BMAD's mandatory workflow, preventing it from skipping steps or writing code without a story.

## After a BMAD Update

BMAD updates may regenerate `.claude/skills/`. The add-on's skills use prefixes not in BMAD's manifest, so they typically survive. If any are lost:

```bash
bash _bmad-addons/install.sh
```

Backups of previous versions are kept in `.claude/.addon-backups/` (last 3 per skill).

## Uninstall

```bash
bash _bmad-addons/uninstall.sh
```

This will:
1. Remove all add-on skills from `.claude/skills/`
2. Clean up worktrees (skipping those with uncommitted changes)
3. Remove `.autopilot.lock` and backup directory

BMAD's own skills are never affected.

## Platform CLI Setup

### GitHub

```bash
brew install gh
gh auth login
```

### GitLab

```bash
brew install glab
glab auth login
```

### No CLI

The add-on works without a platform CLI. Push and PR creation are skipped, and manual commands are printed instead.

## Troubleshooting

### "BMAD not found"

Ensure BMAD is installed in the project root (`_bmad/_config/manifest.yaml` must exist).

### Skills not appearing in Claude Code

Claude Code discovers skills by scanning `.claude/skills/`. Verify the directory exists and contains `SKILL.md` files:

```bash
find .claude/skills -name SKILL.md
```

### Lock file prevents startup

If a previous session crashed, the lock may remain:

```bash
rm .autopilot.lock
```

Or wait 30 minutes for automatic stale lock removal.
