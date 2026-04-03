# Source Tree Analysis

## Repository Type

Monolith — single cohesive codebase (CLI tool / add-on)

## Annotated Directory Tree

```
bmad-autopilot-addon/
├── _bmad-addons/                    # ADD-ON SOURCE — all addon code lives here
│   ├── manifest.yaml                # Addon metadata: name, version, BMAD compat, installed skills
│   ├── install.sh                   # Multi-tool installer (9 supported AI tools)
│   ├── uninstall.sh                 # Clean uninstaller with worktree cleanup
│   ├── BMAD.md                      # System prompt injected into AI tool config
│   ├── .secrets-allowlist           # Patterns excluded from secrets scanning
│   │
│   ├── modules/                     # Module configuration
│   │   ├── git/
│   │   │   ├── config.yaml          # Git workflow settings (branches, commits, lint, push, PR)
│   │   │   ├── branching-and-pr-strategy.md  # Branching strategy documentation
│   │   │   └── templates/
│   │   │       ├── pr-body.md       # Pull request body template
│   │   │       ├── commit-story.txt # Story commit message template
│   │   │       └── commit-patch.txt # Patch commit message template
│   │   └── ma/
│   │       └── config.yaml          # Multi-agent parallelism limits
│   │
│   ├── scripts/                     # Shell scripts — the operational backbone
│   │   ├── lock.sh                  # Mutex lock with stale timeout (112 lines)
│   │   ├── health-check.sh          # Orphaned worktree detection/classification (108 lines)
│   │   ├── stage-and-commit.sh      # Explicit staging with secrets/size/binary checks (169 lines)
│   │   ├── sanitize-branch.sh       # Story key → valid git branch name (84 lines)
│   │   ├── detect-platform.sh       # Auto-detect GitHub/GitLab/Bitbucket/Gitea (90 lines)
│   │   ├── create-pr.sh             # Create PR/MR via platform CLI or API (199 lines)
│   │   ├── sync-status.sh           # Write git metadata to git-status.yaml (139 lines)
│   │   └── lint-changed.sh          # Multi-language linting on changed files (293 lines)
│   │
│   ├── skills/                      # Skill definitions (markdown-based prompts)
│   │   ├── bmad-autopilot-on/       # Autonomous sprint execution orchestrator
│   │   │   ├── SKILL.md             # Skill metadata
│   │   │   └── workflow.md          # Full autopilot workflow (10 steps)
│   │   ├── bmad-autopilot-off/      # Graceful exit with status report
│   │   │   ├── SKILL.md
│   │   │   └── workflow.md
│   │   ├── bmad-ma-code-review/     # 3-layer parallel code review
│   │   │   ├── SKILL.md
│   │   │   ├── workflow.md
│   │   │   └── agents/              # Subagent prompts
│   │   │       ├── blind-hunter.md
│   │   │       ├── edge-case-hunter.md
│   │   │       └── acceptance-auditor.md
│   │   ├── bmad-ma-codebase-map/    # 5-stream parallel codebase analysis
│   │   │   ├── SKILL.md
│   │   │   ├── workflow.md
│   │   │   └── agents/              # 5 subagent prompts
│   │   ├── bmad-ma-assess/          # Tech debt + dependency audit (3 agents)
│   │   │   ├── SKILL.md
│   │   │   ├── workflow.md
│   │   │   └── agents/              # 3 subagent prompts
│   │   ├── bmad-ma-reverse-architect/ # Bottom-up architecture extraction (3 agents)
│   │   │   ├── SKILL.md
│   │   │   ├── workflow.md
│   │   │   └── agents/              # 3 subagent prompts
│   │   ├── bmad-ma-migrate/         # Full-lifecycle migration planning (4 agents)
│   │   │   ├── SKILL.md
│   │   │   ├── workflow.md
│   │   │   ├── agents/              # 4 subagent prompts
│   │   │   ├── resources/           # Strategy and pattern references
│   │   │   └── templates/           # Migration plan templates
│   │   ├── bmad-ma-research/        # Parallel research fan-out
│   │   │   ├── SKILL.md
│   │   │   └── workflow.md
│   │   └── bmad-ma-party-mode/      # Multi-agent group discussions
│   │       ├── SKILL.md
│   │       └── workflow.md
│   │
│   └── templates/
│       └── agent-rules.md           # Template for system prompt generation
│
├── .claude/                         # Claude Code tool configuration
│   ├── settings.json                # Status line config
│   ├── settings.local.json          # Local settings
│   ├── statusline-command.sh        # Status line display script
│   └── skills/                      # Installed BMAD skills (60+ skills, .gitignored)
│
├── _bmad/                           # BMAD core installation (.gitignored except bmm/)
│   └── bmm/
│       └── config.yaml              # Project-level BMAD config (user, language, paths)
│
├── docs/                            # Project documentation
│   ├── ARCHITECTURE.md              # Design principles and mechanisms
│   ├── CONFIGURATION.md             # Full configuration reference
│   ├── CONTRIBUTING.md              # Developer guide
│   ├── EXTENDING.md                 # Adding platforms and linters
│   ├── INSTALLATION.md              # Multi-tool installation guide
│   └── USAGE.md                     # End-user usage guide
│
├── tests/                           # Test suite
│   ├── package.json                 # Test dependencies (vitest, typescript, yaml)
│   ├── vitest.config.ts             # Vitest config (2.3h timeout for e2e)
│   ├── tsconfig.json                # TypeScript config for e2e tests
│   ├── scripts/                     # BATS unit tests for shell scripts
│   │   ├── helpers/
│   │   │   └── setup.bash           # Shared test utilities (temp repos, fixtures)
│   │   ├── lock.bats                # 12 tests
│   │   ├── health-check.bats        # 13 tests
│   │   ├── stage-and-commit.bats    # 15 tests
│   │   ├── sanitize-branch.bats     # 11 tests
│   │   ├── detect-platform.bats     # 6 tests
│   │   ├── create-pr.bats           # 6 tests
│   │   ├── sync-status.bats         # 11 tests
│   │   └── lint-changed.bats        # 6 tests
│   └── e2e/                         # End-to-end integration tests
│       ├── greenfield.test.ts       # Full autopilot: build Tic Tac Toe from scratch
│       ├── brownfield.test.ts       # Multi-agent analysis pipeline on json-server
│       ├── harness/                 # Test infrastructure
│       │   ├── claude-runner.ts     # Claude Code CLI spawner
│       │   ├── assertions.ts        # File, YAML, git state assertions
│       │   ├── temp-project.ts      # Temporary project factory
│       │   └── cost-tracker.ts      # API cost tracking and reporting
│       └── fixtures/                # Test inputs
│           ├── greenfield/
│           │   └── product-brief.md # CLI Tic Tac Toe game spec
│           └── brownfield/
│               └── feature-spec.md  # Auth middleware for json-server
│
├── CLAUDE.md                        # → @AGENTS.md (redirect)
├── AGENTS.md                        # BMAD workflow enforcement rules
├── README.md                        # Comprehensive project documentation
├── CHANGELOG.md                     # Version history
├── LICENSE                          # MIT License
├── .gitignore                       # Ignores _bmad/, _bmad-output/, .claude/skills/
└── .gitattributes                   # Git attributes
```

## Critical Entry Points

| Entry Point | Purpose |
|-------------|---------|
| `_bmad-addons/install.sh` | Primary installation entry — sets up all skills and system prompts |
| `_bmad-addons/skills/bmad-autopilot-on/workflow.md` | Autopilot orchestrator — the main execution engine |
| `_bmad-addons/scripts/stage-and-commit.sh` | Git commit pipeline with safety checks |
| `_bmad-addons/scripts/create-pr.sh` | PR/MR creation across 5 platforms |
| `AGENTS.md` | System prompt enforcement — loaded by Claude Code on every session |

## Key Design Patterns

- **Skills as prompts**: All skills are markdown files, not executable code — the AI tool interprets them
- **Scripts as infrastructure**: Shell scripts handle all git operations, providing deterministic behavior
- **Separation of concerns**: BMAD owns sprint-status.yaml, addon owns git-status.yaml — never cross-written
- **Multi-tool compatibility**: Single codebase installs into 9 different AI coding tools
- **Additive architecture**: Addon layers on top of BMAD without modifying BMAD files
