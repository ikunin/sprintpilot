# Source Tree Analysis

## Repository Type

Monolith — single cohesive codebase (npm CLI + BMad Method addon).

## Annotated Directory Tree

```
sprintpilot/
├── bin/
│   └── sprintpilot.js                  # CLI entry point (commander) — install / uninstall / check-update
│
├── lib/                                # Installer runtime (Node.js, no third-party deps)
│   ├── commands/
│   │   ├── install.js                  # Install subcommand — per-tool deploy, system prompt upsert,
│   │   │                               # legacy migration, --profile flag handling
│   │   ├── uninstall.js                # Uninstall subcommand — per-tool removal, marker strip,
│   │   │                               # worktree cleanup
│   │   └── check-update.js             # check-update — queries npm for newer version
│   ├── core/
│   │   ├── bmad-config.js              # Reads BMad manifest + project output_folder
│   │   ├── file-ops.js                 # copyDirWithSubstitution, backupSkill, pruneBackups
│   │   ├── gitignore.js                # resolveIgnoreFile, addIgnoreEntry
│   │   ├── markers.js                  # BEGIN/END:sprintpilot-rules block handling + legacy helpers
│   │   ├── tool-registry.js            # 9 supported tools: name, skill dir, system-prompt file/mode
│   │   ├── update-check.js             # npm latest-version lookup
│   │   └── v1-detect.js                # Legacy bmad-autopilot-addon detection for migration
│   ├── prompts.js                      # @clack/prompts wrapper (multiselect, confirm, intro/outro)
│   └── substitute.js                   # {output_folder}/{planning_artifacts}/{implementation_artifacts}
│
├── _Sprintpilot/                       # ADDON PAYLOAD — copied into target projects by `sprintpilot install`
│   ├── manifest.yaml                   # Addon name, version, BMad compatibility, installed_skills list
│   ├── Sprintpilot.md                  # Full skill catalog + workflow reference (the "permanent home" doc)
│   ├── .secrets-allowlist              # Patterns excluded from secrets scanning
│   │
│   ├── modules/                        # User-editable module configuration
│   │   ├── autopilot/
│   │   │   ├── config.yaml             # Profile selection + session/retro settings
│   │   │   └── profiles/               # v2 profile YAMLs (base + overlay)
│   │   │       ├── _base.yaml          # Shared defaults (inherited by nano/small/medium/large)
│   │   │       ├── nano.yaml           # quick-dev one-shot, epic granularity
│   │   │       ├── small.yaml          # Minimal overlay
│   │   │       ├── medium.yaml         # Minimal overlay (default)
│   │   │       ├── large.yaml          # Parallel stories + state sharding always
│   │   │       └── legacy.yaml         # v1.0.5 byte-for-byte (standalone, version_pinned)
│   │   ├── git/
│   │   │   ├── config.yaml             # Granularity, branches, lint, push, PR, worktree, lock, platform
│   │   │   ├── platform.yaml           # CLI command templates (GitHub, GitLab, Bitbucket, Gitea)
│   │   │   ├── branching-and-pr-strategy.md
│   │   │   └── templates/
│   │   │       ├── pr-body.md          # Pull request body template
│   │   │       ├── commit-story.txt
│   │   │       └── commit-patch.txt
│   │   └── ma/
│   │       └── config.yaml             # Multi-agent + parallelism config
│   │
│   ├── bin/
│   │   └── autopilot.js                # Orchestrator CLI: start | next | record | state | report | validate-config | status
│   │                                   # Emits typed Actions; consumes typed Signals. Drives the BMad 7-step state machine.
│   │
│   ├── lib/orchestrator/               # 15 pure modules owned by the autopilot CLI:
│   │   ├── state-machine.js            #   BMad 7-step state graph (CREATE_STORY → DEV_RED → DEV_GREEN → CODE_REVIEW
│   │   │                               #     → PATCH_APPLY → PATCH_RETEST → STORY_DONE → STORY_LAND → RETROSPECTIVE → …)
│   │   ├── adapt.js                    #   Signal → next state transitions (incl. nano routing)
│   │   ├── profile-rules.js            #   Profile-aware policy (reject budgets, parallel caps, …)
│   │   ├── verify.js                   #   BMad bookkeeping enforcement (AC bullets, task boxes, git_steps_completed)
│   │   ├── impact-classifier.js        #   Maps decisions / failures to severity for halt logic
│   │   ├── decision-log.js             #   Appends to decision-log.yaml with id + timestamp + story stamping
│   │   ├── state-store.js              #   autopilot-state.yaml read/write (atomic)
│   │   ├── action-ledger.js            #   ledger.jsonl append-only audit trail
│   │   ├── divergence.js               #   Fingerprint + resume_divergence detection
│   │   ├── user-commands.js            #   user_input signal validation (force_continue, override_decision, …)
│   │   ├── user-command-applier.js     #   Applies validated user commands back into the state machine
│   │   ├── parallel-batch.js           #   parallel_batch action resolver (DAG-layer dispatch)
│   │   ├── git-plan.js                 #   Pre-plans every git_op as inlined argv steps for verbatim LLM execution
│   │   ├── report.js                   #   End-of-session / end-of-sprint reports
│   │   └── land.js                     #   STORY_LAND state (land_as_you_go merge + rebase recovery)
│   │
│   ├── scripts/                        # Node.js helpers invoked by the orchestrator + skills (zero third-party deps)
│   │   │ # — Core git / commit pipeline —
│   │   ├── lock.js                     # Mutex with stale timeout
│   │   ├── health-check.js             # Worktree state classification
│   │   ├── stage-and-commit.js         # Explicit staging with pre-commit checks
│   │   ├── sanitize-branch.js          # Story key → branch name
│   │   ├── detect-platform.js          # Auto-detect GitHub / GitLab / Bitbucket / Gitea
│   │   ├── create-pr.js                # PR/MR creation across 4 platforms
│   │   ├── sync-status.js              # Git metadata → git-status.yaml (granularity-aware)
│   │   ├── lint-changed.js             # Multi-language linting (14 languages)
│   │   ├── git-portable.js             # Cross-platform git helpers (count-worktrees, config-get,
│   │   │                               # common-dir, safe-add) — replaces POSIX-shell idioms
│   │   │
│   │   │ # — V2 profile + adaptive scaling —
│   │   ├── resolve-profile.js          # Profile resolution (base+overlay, fallback to medium)
│   │   ├── check-prereqs.js            # Node ≥ 18, git ≥ 2.18 enforcement
│   │   ├── log-timing.js               # Phase timing — mark / start / end / _end sentinel
│   │   ├── summarize-timings.js        # Hotspot report (>5% of total time)
│   │   ├── state-shard.js              # Per-story shards: write/read/append/init/batch/flush
│   │   ├── merge-shards.js             # Atomic shard → project YAML merge with corrupt-archive
│   │   ├── cached-read.js              # TTL + mtime-aware file cache
│   │   ├── inject-tasks-section.js     # Deterministic Tasks/Subtasks recovery
│   │   ├── list-remaining-stories.js   # Indent-agnostic sprint-status scanner
│   │   ├── mark-done-stories-tasks.js  # Fenced-block-aware task checkbox repair
│   │   │
│   │   │ # — DAG + parallel dispatch —
│   │   ├── infer-dependencies.js       # LLM JSON envelope → validated dependencies.yaml
│   │   ├── resolve-dag.js              # graph / layers / width / scaffold (Kahn cycle detection)
│   │   ├── agent-adapter.js            # Host detection (env > parent process > markers)
│   │   ├── dispatch-layer.js           # Worktree-per-story preflight + .layer-plan.json
│   │   ├── preflight-merge.js          # Cross-epic merge-conflict probe (per-pair, lock, HEAD restore)
│   │   ├── submodule-lock.js           # Per-submodule lock (slug-keyed)
│   │   └── with-retry.js               # Ref-lock-pattern jittered backoff (3 attempts)
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
│   │   ├── sprint-autopilot-on/        # Profile-aware autopilot driver (SKILL.md + workflow.orchestrator.md, ≤150 lines)
│   │   ├── sprint-autopilot-off/       # Graceful disengage + status report
│   │   ├── sprintpilot-update/         # In-IDE update flow
│   │   ├── sprintpilot-code-review/    # 3-layer parallel code review
│   │   ├── sprintpilot-codebase-map/   # 5-stream parallel codebase analysis
│   │   ├── sprintpilot-assess/         # Tech debt + dependency audit (3 agents)
│   │   ├── sprintpilot-reverse-architect/ # Bottom-up architecture extraction (3 agents)
│   │   ├── sprintpilot-migrate/        # Full-lifecycle migration planning (4 agents)
│   │   ├── sprintpilot-research/       # Parallel research fan-out (N agents)
│   │   └── sprintpilot-party-mode/     # Multi-persona parallel debates
│   │
│   ├── sprints/                        # Per-sprint artifacts (auto-inferred dependencies.yaml lives here)
│   │
│   └── templates/
│       └── agent-rules.md              # Template for per-tool system prompt generation
│
├── tests/
│   ├── package.json                    # Vitest + TypeScript — separate workspace so root package ships lean
│   ├── vitest.config.ts
│   ├── tsconfig.json
│   ├── unit/                           # 535 Vitest tests — units, scripts, runtime, profile, DAG, dispatch
│   │   └── *.test.ts
│   ├── fixtures/                       # Shared test fixtures (e.g. infer-dependencies/)
│   └── e2e/                            # End-to-end suites (gated on Claude Code presence + budget)
│       ├── greenfield.test.ts          # Full autopilot: build Tic Tac Toe from scratch
│       ├── brownfield.test.ts          # Multi-agent analysis pipeline on json-server
│       ├── sudoku.test.ts              # Web-game e2e exercising parallel dispatch
│       ├── medium-parallel.test.ts     # Asserts overlapping skill intervals
│       ├── nano.test.ts                # Asserts quick-dev invocation, no bmad-dev-story
│       ├── harness/                    # claude-runner, assertions, temp-project, cost-tracker, git-utils
│       └── fixtures/                   # Greenfield product briefs + brownfield feature specs
│
├── docs/                               # User and contributor documentation
│   ├── INSTALLATION.md                 # Multi-tool installation + --profile flag
│   ├── USAGE.md                        # End-user usage + profiles + parallel dispatch
│   ├── CONFIGURATION.md                # Full configuration reference (autopilot + git + ma)
│   ├── ARCHITECTURE.md                 # Design principles, mechanisms, v2 layers
│   ├── CONTRIBUTING.md                 # Developer guide
│   ├── EXTENDING.md                    # Adding platforms and linters
│   ├── adaptive-process-scaling.md     # v2 concept and roadmap
│   ├── implementation-plan.md          # 12-PR implementation plan
│   ├── implementation-decisions.md     # Per-PR rationale
│   ├── project-overview.md             # High-level overview
│   ├── development-guide.md            # Day-to-day dev workflow
│   ├── component-inventory.md          # Component inventory
│   ├── source-tree-analysis.md         # This file
│   └── index.md                        # Docs index
│
├── .github/workflows/publish.yml       # npm publish on GitHub release (OIDC trusted publisher)
├── .githooks/pre-push                  # Runs biome ci + fast test suite before push
├── .claude/                            # Dev's Claude Code config (skills/ + .sprintpilot-backups/ are .gitignored)
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
└── .gitattributes                      # Forces LF line endings on scripts and YAML
```

## Critical Entry Points

| Entry Point | Purpose |
|-------------|---------|
| `bin/sprintpilot.js install` | Primary installation — deploys skills + system prompts, accepts `--profile`, handles legacy migration |
| `_Sprintpilot/bin/autopilot.js` | Profile-aware autopilot CLI — deterministic state machine that emits typed Actions / consumes typed Signals |
| `_Sprintpilot/skills/sprint-autopilot-on/workflow.orchestrator.md` | LLM-facing workflow (≤150 lines) consumed by the autopilot driver |
| `_Sprintpilot/scripts/resolve-profile.js` | Profile resolution at boot |
| `_Sprintpilot/scripts/dispatch-layer.js` | Parallel story dispatch entry point |
| `_Sprintpilot/scripts/infer-dependencies.js` | Story DAG inference (validates LLM JSON envelopes) |
| `_Sprintpilot/scripts/stage-and-commit.js` | Git commit pipeline with pre-commit safety checks |
| `_Sprintpilot/scripts/create-pr.js` | PR/MR creation across GitHub / GitLab / Bitbucket / Gitea |
| `AGENTS.md` | System prompt enforcement — loaded by Claude Code on every session |
| `lib/core/v1-detect.js` | Detects legacy `bmad-autopilot-addon` installs for migration |

## Key Design Patterns

- **Profile-driven flow** — `complexity_profile` decides per-story behavior + which v2 layers are enabled. Missing-key fallback to `medium` matches v1.0.5 byte-for-byte.
- **Skills as prompts** — addon-owned skills are markdown files, not executable code. The AI tool interprets them.
- **Scripts as infrastructure** — Node.js scripts (zero third-party runtime deps) handle git operations and complex logic. Deterministic. Testable. The "Sprintpilot scripts NEVER call LLMs" rule is preserved across the codebase.
- **Cross-platform by default** — every script uses `spawnSync(..., args[])` with no shell. Workflow.md call sites are bash/zsh/Git-Bash/PowerShell/cmd safe.
- **Worktree isolation via standard `git worktree add`** — compatible with any AI coding tool, not just Claude.
- **Separation of concerns** — BMad Method owns `sprint-status.yaml`; the addon writes only to its own `git-status.yaml` (and per-story shards).
- **Multi-tool compatibility** — single `_Sprintpilot/` payload installs into 9 different AI coding tools via `lib/core/tool-registry.js`.
- **Additive architecture** — the addon never modifies BMad Method's own files; a BMad update won't touch `_Sprintpilot/`.
- **Marker-gated system-prompt injection** — `<!-- BEGIN/END:sprintpilot-rules -->` lets the installer idempotently upsert or cleanly strip its block from user rule files.
