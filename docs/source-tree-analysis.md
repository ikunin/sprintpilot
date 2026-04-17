# Source Tree Analysis

## Repository Type

Monolith — single cohesive codebase (npm CLI + BMad Method addon).

## Annotated Directory Tree

```
sprintpilot/
├── bin/
│   └── sprintpilot.js                  # CLI entry point (commander) — install / uninstall / check-update
│
├── lib/                                # Installer runtime (Node.js, no third-party deps beyond package.json)
│   ├── commands/
│   │   ├── install.js                  # Install subcommand — per-tool skill deploy, system prompt upsert, legacy migration
│   │   ├── uninstall.js                # Uninstall subcommand — per-tool skill removal, marker strip, worktree cleanup
│   │   └── check-update.js             # check-update subcommand — queries npm for newer version
│   ├── core/
│   │   ├── bmad-config.js              # Reads BMad Method manifest + project output_folder
│   │   ├── file-ops.js                 # copyDirWithSubstitution, backupSkill, pruneBackups
│   │   ├── gitignore.js                # resolveIgnoreFile, addIgnoreEntry
│   │   ├── markers.js                  # BEGIN/END:sprintpilot-rules block handling (plus legacy helpers)
│   │   ├── tool-registry.js            # 9 supported tools: name, skill dir, system-prompt file/mode
│   │   ├── update-check.js             # npm latest-version lookup
│   │   └── v1-detect.js                # Legacy bmad-autopilot-addon detection for migration
│   ├── prompts.js                      # @clack/prompts wrapper (multiselect, confirm, intro/outro, log)
│   └── substitute.js                   # {output_folder}/{planning_artifacts}/{implementation_artifacts} substitution
│
├── _Sprintpilot/                       # ADDON PAYLOAD — copied into target projects by `sprintpilot install`
│   ├── manifest.yaml                   # Addon name, version, BMad Method compatibility, installed_skills list
│   ├── Sprintpilot.md                  # Full skill catalog + workflow reference (the "permanent home" doc)
│   ├── .secrets-allowlist              # Patterns excluded from secrets scanning
│   │
│   ├── modules/                        # User-editable module configuration
│   │   ├── git/
│   │   │   ├── config.yaml             # Git workflow settings (branches, commits, lint, push, PR)
│   │   │   ├── branching-and-pr-strategy.md
│   │   │   └── templates/
│   │   │       ├── pr-body.md          # Pull request body template
│   │   │       ├── commit-story.txt
│   │   │       └── commit-patch.txt
│   │   ├── ma/
│   │   │   └── config.yaml             # Multi-agent parallelism limits
│   │   └── autopilot/
│   │       └── config.yaml             # Autopilot session_story_limit
│   │
│   ├── scripts/                        # Node.js helpers invoked by workflow.md (zero third-party deps)
│   │   ├── lock.js                     # Mutex lock with stale timeout
│   │   ├── health-check.js             # Orphaned worktree detection / classification
│   │   ├── stage-and-commit.js         # Explicit staging with secrets / size / binary checks
│   │   ├── sanitize-branch.js          # Story key → valid git branch name
│   │   ├── detect-platform.js          # Auto-detect GitHub / GitLab / Bitbucket / Gitea
│   │   ├── create-pr.js                # Create PR/MR via platform CLI or REST API
│   │   ├── sync-status.js              # Write git metadata to git-status.yaml
│   │   └── lint-changed.js             # Multi-language linting on changed files (16 languages)
│   │
│   ├── lib/runtime/                    # Shared zero-dep helpers for the scripts above
│   │   ├── args.js                     # Argument parser
│   │   ├── git.js                      # Thin git wrapper
│   │   ├── http.js                     # REST fallback with body-size cap
│   │   ├── log.js                      # stdout/stderr helpers
│   │   ├── secrets.js                  # Concrete-format secrets scanner
│   │   ├── spawn.js                    # Cross-platform process spawn
│   │   ├── text.js                     # String utilities
│   │   └── yaml-lite.js                # Zero-dep YAML read/write for story blocks
│   │
│   ├── skills/                         # 10 addon-owned skills (markdown-based prompts)
│   │   ├── sprint-autopilot-on/        # Autonomous sprint execution orchestrator
│   │   ├── sprint-autopilot-off/       # Graceful disengage + status report
│   │   ├── sprintpilot-update/         # Check for updates and install latest
│   │   ├── sprintpilot-code-review/    # 3-layer parallel code review
│   │   ├── sprintpilot-codebase-map/   # 5-stream parallel codebase analysis
│   │   ├── sprintpilot-assess/         # Tech debt + dependency audit (3 agents)
│   │   ├── sprintpilot-reverse-architect/ # Bottom-up architecture extraction (3 agents)
│   │   ├── sprintpilot-migrate/        # Full-lifecycle migration planning (4 agents)
│   │   ├── sprintpilot-research/       # Parallel research fan-out (N agents)
│   │   └── sprintpilot-party-mode/     # Multi-persona parallel debates
│   │
│   └── templates/
│       └── agent-rules.md              # Template for per-tool system prompt generation
│
├── tests/
│   ├── package.json                    # Vitest + TypeScript — separate workspace so the root package ships lean
│   ├── vitest.config.ts
│   ├── tsconfig.json
│   ├── unit/                           # Unit tests for lib/* + _Sprintpilot/lib/runtime/*
│   │   └── *.test.ts                   # markers, gitignore, secrets, http, spawn, args, yaml-lite, bmad-config, v1-detect, …
│   ├── scripts/                        # Integration tests for _Sprintpilot/scripts/* and the CLI
│   │   ├── helpers/run.ts              # runCli / runScript wrappers
│   │   ├── *.test.ts                   # lock, health-check, stage-and-commit, sanitize-branch, create-pr,
│   │   │                               # detect-platform, sync-status, lint-changed, check-update, v1-migration
│   └── e2e/                            # End-to-end integration tests (require real Claude Code + budget)
│       ├── greenfield.test.ts          # Full autopilot: build Tic Tac Toe from scratch
│       ├── brownfield.test.ts          # Multi-agent analysis pipeline on json-server
│       ├── harness/                    # claude-runner, assertions, temp-project, cost-tracker
│       └── fixtures/                   # Greenfield product briefs + brownfield feature specs
│
├── docs/                               # User and contributor documentation
│   ├── INSTALLATION.md                 # Multi-tool installation guide
│   ├── USAGE.md                        # End-user usage guide
│   ├── CONFIGURATION.md                # Full configuration reference
│   ├── ARCHITECTURE.md                 # Design principles and mechanisms
│   ├── CONTRIBUTING.md                 # Developer guide
│   ├── EXTENDING.md                    # Adding platforms and linters
│   ├── project-overview.md             # High-level overview
│   ├── development-guide.md            # Day-to-day dev workflow
│   ├── component-inventory.md          # Component inventory
│   ├── source-tree-analysis.md         # This file
│   └── index.md                        # Docs index
│
├── .github/workflows/publish.yml       # npm publish on GitHub release (OIDC trusted publisher)
├── .claude/                            # Dev's Claude Code config (skills/ + .addon-backups/ are .gitignored)
├── _bmad/                              # Upstream BMad Method installation (.gitignored except bmm/)
├── _bmad-output/                       # BMad Method artifacts (.gitignored)
│
├── package.json                        # npm package: @ikunin/sprintpilot
├── README.md
├── CHANGELOG.md
├── MIGRATION.md                        # bmad-autopilot-addon → sprintpilot migration guide
├── TRADEMARK.md                        # Trademark notice
├── LICENSE                             # Apache 2.0
├── AGENTS.md                           # BMad Method workflow enforcement rules (read by AI agents)
├── CLAUDE.md                           # → @AGENTS.md (include directive)
├── .gitignore
└── .gitattributes
```

## Critical Entry Points

| Entry Point | Purpose |
|-------------|---------|
| `bin/sprintpilot.js` (`install`) | Primary installation — deploys skills + system prompts, handles legacy migration |
| `_Sprintpilot/skills/sprint-autopilot-on/workflow.md` | Autopilot orchestrator — the main execution engine |
| `_Sprintpilot/scripts/stage-and-commit.js` | Git commit pipeline with pre-commit safety checks |
| `_Sprintpilot/scripts/create-pr.js` | PR/MR creation across GitHub / GitLab / Bitbucket / Gitea |
| `AGENTS.md` | System prompt enforcement — loaded by Claude Code on every session |
| `lib/core/v1-detect.js` | Detects legacy `bmad-autopilot-addon` installs for migration |

## Key Design Patterns

- **Skills as prompts** — all addon-owned skills are markdown files, not executable code. The AI tool interprets them.
- **Scripts as infrastructure** — Node.js scripts (zero third-party runtime deps) handle git operations and complex logic, providing deterministic behavior the LLM can't drift from.
- **Separation of concerns** — BMad Method owns `sprint-status.yaml`; the addon writes only to its own `git-status.yaml`.
- **Multi-tool compatibility** — a single `_Sprintpilot/` payload installs into 9 different AI coding tools via `lib/core/tool-registry.js`.
- **Additive architecture** — the addon never modifies BMad Method's own files; a BMad Method update won't touch `_Sprintpilot/`.
- **Marker-gated system-prompt injection** — `<!-- BEGIN/END:sprintpilot-rules -->` lets the installer idempotently upsert or cleanly strip its block from user rule files.
