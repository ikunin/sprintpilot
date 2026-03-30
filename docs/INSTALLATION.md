# Installation Guide

## Prerequisites

1. **Node.js 18+** and **npm** — required for BMAD installer and most projects
2. **Git** — [git-scm.com/downloads](https://git-scm.com/downloads)
3. **A supported AI code agent** — Claude Code, Cursor, Windsurf, etc. (see [Supported Tools](#supported-tools))
4. **Platform CLI** (optional) — `gh` for GitHub, `glab` for GitLab, etc. (see [Platform CLI Setup](#platform-cli-setup))

### Windows

Use one of:
- **Git Bash** (included with [Git for Windows](https://git-scm.com/download/win)) — recommended, all commands below work as-is
- **WSL 2** (Windows Subsystem for Linux) — full Linux environment
- **PowerShell** — works for git and npm commands; bash scripts require Git Bash or WSL

## Step 1: Create or Open Your Project

Start with an existing project or create a new one:

```bash
# New project
mkdir my-project && cd my-project
git init
git commit --allow-empty -m "initial commit"

# Or clone an existing repo
git clone https://github.com/your-org/your-project.git
cd your-project
```

## Step 2: Install BMAD

```bash
npx bmad-method install --modules bmm --tools claude-code --yes
```

For test architecture support, add the TEA module:

```bash
npx bmad-method install --modules bmm,tea --tools claude-code --yes
```

## Step 3: Add the Autopilot Add-On

Clone the add-on into your project as the `_bmad-addons` directory:

```bash
# From your project root
git clone https://github.com/ikunin/bmad-autopilot-addon.git _bmad-addons
```

Or add it as a git submodule (keeps it updatable):

```bash
git submodule add https://github.com/ikunin/bmad-autopilot-addon.git _bmad-addons
```

On Windows (Git Bash or WSL):
```bash
# Same commands work in Git Bash and WSL
git clone https://github.com/ikunin/bmad-autopilot-addon.git _bmad-addons
```

On Windows (PowerShell):
```powershell
git clone https://github.com/ikunin/bmad-autopilot-addon.git _bmad-addons
```

## Step 4: Run the Installer

### Interactive (recommended)

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

## Step 5: Verify and Start

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

Once verified, start the autopilot in your AI tool:

```
/bmad-autopilot-on
```

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
1. Remove all add-on skills from all tool directories
2. Remove system prompt files (AGENTS.md, tool-specific rules)
3. Clean up worktrees (skipping those with uncommitted changes)
4. Remove `.autopilot.lock` and backup directories

Use `--force` to remove dirty worktrees without prompting:
```bash
bash _bmad-addons/uninstall.sh --force
```

BMAD's own skills are never affected.

## Platform CLI Setup

### GitHub (`gh`)

```bash
# macOS
brew install gh

# Windows
winget install GitHub.cli
# or: scoop install gh
# or: choco install gh

# Linux (Debian/Ubuntu)
sudo apt install gh
# or: sudo dnf install gh (Fedora)

# Then authenticate
gh auth login
```

### GitLab (`glab`)

```bash
# macOS
brew install glab

# Windows
winget install GLab.GLab
# or: scoop install glab

# Linux (Debian/Ubuntu)
sudo apt install glab
# or see https://gitlab.com/gitlab-org/cli#installation

# Then authenticate
glab auth login
```

### Bitbucket

```bash
# Option 1: Bitbucket CLI (all platforms, requires Python)
pip install bitbucket-cli
bb auth login

# Option 2: API token (no CLI needed, any platform)
export BITBUCKET_TOKEN="your_app_password_or_token"
# Windows (PowerShell): $env:BITBUCKET_TOKEN="your_token"
```

For Bitbucket Cloud (bitbucket.org), the remote URL is auto-detected. For Bitbucket Server (self-hosted), set `provider: bitbucket` in config.

### Gitea

```bash
# Option 1: tea CLI (https://gitea.com/gitea/tea)
# macOS
brew install tea

# All platforms (requires Go)
go install code.gitea.io/tea@latest
tea login add

# Option 2: API token (no CLI needed, any platform)
export GITEA_TOKEN="your_token"
# Windows (PowerShell): $env:GITEA_TOKEN="your_token"
# Also set in _bmad-addons/modules/git/config.yaml:
#   platform:
#     provider: gitea
#     base_url: https://git.example.com
```

Gitea is always self-hosted — auto-detection requires explicit `provider: gitea` in config.

### No CLI

The add-on works without any platform CLI (`git_only` mode). Git branches are created and pushed normally, but PR/MR creation is skipped. Manual instructions are printed showing the branch and base for you to create the PR in the web UI.

To skip PRs even when a CLI is installed, set `create_pr: false` in config:
```yaml
# _bmad-addons/modules/git/config.yaml
git:
  push:
    create_pr: false  # merge directly to main, no PRs
```

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

### Windows (Git Bash / WSL)

On Windows, always invoke scripts with `bash` explicitly:

```bash
bash _bmad-addons/install.sh --tools claude-code
```

Not `./install.sh` (which may fail if the script has CRLF line endings or `/bin/bash` doesn't resolve).

The repo includes `.gitattributes` that forces LF line endings for all scripts and YAML files, preventing CRLF issues on clone.

### Wrong platform detected

If the autopilot creates PRs on the wrong platform:

1. Check which CLIs are installed: `which gh glab bb tea`
2. If multiple CLIs are present, the remote URL is used as tiebreaker
3. Override explicitly in `_bmad-addons/modules/git/config.yaml`:
   ```yaml
   platform:
     provider: github  # or gitlab, bitbucket, gitea, git_only
   ```
4. For self-hosted instances, also set `base_url` (Gitea) or configure the CLI to point to your server
