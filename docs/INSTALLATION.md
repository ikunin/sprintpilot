# Installation Guide

## Prerequisites

1. **BMAD Method v6.2.0+** installed in your project
2. **Claude Code** (CLI, desktop app, or IDE extension)
3. **Git** initialized with at least one commit
4. **Platform CLI** (optional): `gh` for GitHub or `glab` for GitLab

## Install BMAD (if needed)

```bash
npx bmad-method install --modules bmm --tools claude-code --yes
```

For test architecture support, add the TEA module:

```bash
npx bmad-method install --modules bmm,tea --tools claude-code --yes
```

## Install the Add-On

### Standard Install

```bash
bash _bmad-addons/install.sh
```

This will:
1. Verify BMAD is installed
2. Back up existing `bmad-autopilot-on/off` skills
3. Copy enhanced skills to `.claude/skills/`
4. Copy all `bmad-ma-*` skills
5. Add `.autopilot.lock` and `.claude/.addon-backups/` to `.gitignore`

### Dry Run (preview without changes)

```bash
bash _bmad-addons/install.sh --dry-run
```

### Force Install (skip backups)

```bash
bash _bmad-addons/install.sh --force
```

## Verify Installation

After install, check that skills are available:

```bash
ls .claude/skills/bmad-autopilot-* .claude/skills/bmad-ma-*
```

You should see 9 skill directories:
- `bmad-autopilot-on`, `bmad-autopilot-off`
- `bmad-ma-code-review`, `bmad-ma-codebase-map`, `bmad-ma-assess`
- `bmad-ma-reverse-architect`, `bmad-ma-migrate`
- `bmad-ma-research`, `bmad-ma-party-mode`

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
