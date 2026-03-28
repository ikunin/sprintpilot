# BMAD Autopilot Add-On

Multi-agent execution and git workflow integration for the [BMAD Method](https://github.com/bmad-code-org/BMAD-METHOD) in Claude Code.

## What It Does

This add-on enhances BMAD's autopilot with two capabilities:

**Git Workflow** (v1.0) — Automatic branching, commits, linting, and PR creation during story implementation. Each story gets its own worktree via Claude Code's `EnterWorktree`, isolating work-in-progress from the main branch.

**Multi-Agent Execution** (v1.1+) — Parallel subagent dispatch for code review, codebase analysis, tech debt assessment, architecture extraction, migration planning, research, and multi-persona discussions.

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

## Skills

### Git Workflow
| Skill | Description |
|-------|-------------|
| `/bmad-autopilot-on` | Enhanced autopilot with git branching, commits, PRs |
| `/bmad-autopilot-off` | Disengage with git status report and lock release |

### Multi-Agent (7 skills, 19 subagents)
| Skill | Agents | Description |
|-------|--------|-------------|
| `/bmad-ma-code-review` | 3 | Parallel Blind Hunter + Edge Case + Acceptance review |
| `/bmad-ma-codebase-map` | 5 | Stack, architecture, quality, concerns, integrations |
| `/bmad-ma-assess` | 3 | Dependency audit, debt classification, migration analysis |
| `/bmad-ma-reverse-architect` | 3 | Extract architecture from existing code |
| `/bmad-ma-migrate` | 4 | 12-step migration planning with phased roadmap |
| `/bmad-ma-research` | N | Parallel research fan-out with WebSearch |
| `/bmad-ma-party-mode` | 2-3 | Real parallel multi-persona discussions |

## How It Works

The add-on lives in `_bmad-addons/` and installs skills to `.claude/skills/`. It never modifies BMAD's own files, so it survives BMAD updates — just re-run `install.sh` after updating BMAD.

### Git Workflow

```
sprint-planning → create-story → implementation-readiness
                                        ↓
                              EnterWorktree (isolate story)
                                        ↓
                              dev-story (write code + tests)
                                        ↓
                              lint → stage → commit
                                        ↓
                              code-review → patch commits
                                        ↓
                              push → create PR
                                        ↓
                              ExitWorktree → sync status
                                        ↓
                              next story or retrospective
```

### Brownfield Analysis Pipeline

```
bmad-ma-codebase-map  →  bmad-ma-assess  →  bmad-ma-reverse-architect
   (5 agents)              (3 agents)           (3 agents)
       ↓                       ↓                     ↓
   STACK.md              brownfield-           architecture.md
   ARCHITECTURE.md       assessment.md         (BMAD-compatible)
   QUALITY.md
   CONCERNS.md                    ↓
   INTEGRATIONS.md         bmad-ma-migrate
                              (4 agents)
                                  ↓
                           migration-plan.md
                           migration-epics.md
```

## Supported Tools

| Tool | Directory | Status |
|------|-----------|--------|
| Claude Code | `.claude/skills/` | Primary |
| Cursor | `.cursor/skills/` | Supported |
| Windsurf | `.windsurf/skills/` | Supported |
| Cline | `.cline/skills/` | Supported |
| Roo Code | `.roo/skills/` | Supported |
| Trae | `.trae/skills/` | Supported |
| Kiro | `.kiro/skills/` | Supported |
| Gemini CLI | `.gemini/skills/` | Supported |
| GitHub Copilot | `.github/copilot/skills/` | Supported |

All tools use the same SKILL.md format. Install for multiple tools simultaneously:
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
