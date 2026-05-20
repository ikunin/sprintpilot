# Component Inventory

## Orchestrator (the deterministic flow-control layer)

`_Sprintpilot/bin/autopilot.js` is a Node CLI that drives the BMad 7-step sequence as an explicit state machine. The skill body calls `autopilot next` to fetch the next Action, executes it, and signals the outcome via `autopilot record --signal <json>`. Actions and Signals are typed; flow control never lives in LLM-interpreted prose.

| Module (`_Sprintpilot/lib/orchestrator/`) | Purpose |
|---|---|
| `state-machine.js` | BMad 7-step state graph (CREATE_STORY → DEV_RED → DEV_GREEN → CODE_REVIEW → PATCH_APPLY → PATCH_RETEST → STORY_DONE → STORY_LAND → RETROSPECTIVE → terminal halts incl. `sprint_finalize_pending`). |
| `adapt.js` | Signal-driven transitions (incl. nano `NANO_QUICK_DEV` routing for `implementation_flow: quick`). |
| `profile-rules.js` | Per-profile policy (verify reject budgets, parallel caps, default flow). |
| `verify.js` | BMad bookkeeping gate per phase: AC bullets exist, task boxes flipped, story marked `done` in sprint-status, `commit_sha`+`branch` reported, `git_steps_completed: true` only after every step in `action.steps` (including `git push`) exits 0. |
| `impact-classifier.js` | Maps decisions / failures to severity (drives halt logic). |
| `decision-log.js` | Appends `decisions[]` entries with id + timestamp + story stamped automatically. |
| `state-store.js` | Atomic read/write of `autopilot-state.yaml`. |
| `action-ledger.js` | Append-only `ledger.jsonl` audit trail of every action + signal. |
| `divergence.js` | Fingerprints `_bmad-output/` + sprint-status + branch HEADs; surfaces `resume_divergence` on mismatch. |
| `user-commands.js` | Validates `user_input.commands[]` (e.g. `force_continue`, `override_decision`). |
| `user-command-applier.js` | Applies validated user commands back into the state machine. |
| `parallel-batch.js` | `parallel_batch` action resolver — DAG-layer dispatch with profile-aware fallback. |
| `git-plan.js` | Pre-plans every `git_op` as inlined argv `steps` (`git add`, `git commit`, `git push`, …). LLM executes verbatim. |
| `report.js` | End-of-session and end-of-sprint reports. |
| `land.js` | `STORY_LAND` state machinery for `merge_strategy: land_as_you_go` (incl. rebase + halt-on-conflict). |

The autopilot CLI exposes: `start | next | record | state | report | validate-config | status`.

## Node.js Scripts

The operational backbone of the addon. All scripts live in `_Sprintpilot/scripts/` and run on Node.js 18+ with **zero third-party runtime dependencies**.

### Core Git / Commit Pipeline

| Script | Purpose |
|--------|---------|
| `lock.js` | Mutex lock with stale timeout (epoch + UUID, no PID — Claude Code unreliable). |
| `health-check.js` | Worktree state classification (COMMITTED / CLEAN_DONE / STALE / DIRTY / ORPHAN). |
| `stage-and-commit.js` | Explicit staging with secrets / size / binary checks. Never uses `git add -A`. |
| `sanitize-branch.js` | Story key → valid git branch name. |
| `detect-platform.js` | Auto-detect GitHub / GitLab / Bitbucket / Gitea / git-only. |
| `create-pr.js` | PR/MR creation across 4 platforms (CLI primary, REST fallback for Bitbucket / Gitea). |
| `sync-status.js` | Git metadata → `git-status.yaml` (granularity-aware: story or epic). |
| `lint-changed.js` | Multi-language linting on changed files (14 languages). |
| `git-portable.js` | Cross-platform helpers (`count-worktrees`, `config-get`, `common-dir`, `safe-add`). |

### V2 Profile + Adaptive Scaling

| Script | Purpose |
|--------|---------|
| `resolve-profile.js` | Profile resolution (base + overlay; fallback to `medium` with notice). |
| `check-prereqs.js` | Node ≥ 18, git ≥ 2.18 enforcement (warn-only on git 2.5–2.17). |
| `log-timing.js` | Phase timing — `mark` (single-call), `start` / `end` (legacy bracket), `_end` sentinel. JSONL writes. |
| `summarize-timings.js` | Hotspot report (phases > 5% of total time). text / json / md. |
| `state-shard.js` | Per-story state shards (`write` / `read` / `append` / `init` / `batch` / `flush`). |
| `merge-shards.js` | Atomic shard → project YAML merge with corrupt-archive handling. |
| `cached-read.js` | TTL + mtime-aware file cache (`read` / `invalidate` / `clear` / `stats`). |
| `inject-tasks-section.js` | Deterministic Tasks/Subtasks recovery from Acceptance Criteria. |
| `list-remaining-stories.js` | Indent-agnostic sprint-status scanner; envelope-format output. |
| `mark-done-stories-tasks.js` | Fenced-block-aware task checkbox repair. |

### DAG + Parallel Dispatch

| Script | Purpose |
|--------|---------|
| `infer-dependencies.js` | LLM JSON envelope → validated `dependencies.yaml` (`scaffold-prompt` / `dry-run` / `write`). Never calls an LLM. |
| `resolve-dag.js` | DAG `graph` / `layers` / `width` / `scaffold` (Kahn cycle detection, explicit > ordering). |
| `agent-adapter.js` | Host detection with confidence levels (env > parent process > markers; tautology guard). |
| `dispatch-layer.js` | Worktree-per-story preflight + `.layer-plan.json`. |
| `preflight-merge.js` | Cross-epic merge-conflict probe (per-pair dry-run, 60s lock, HEAD restore). |
| `submodule-lock.js` | Per-submodule lock keyed by slug. |
| `with-retry.js` | Ref-lock-pattern jittered backoff (500ms–2s, 3 attempts). |

### Script Characteristics

- All scripts use `spawnSync(..., args[])` with no shell — cross-platform safe (bash, zsh, Git Bash, PowerShell, cmd).
- Atomic file writes via tmp-sibling + `rename()` everywhere state matters.
- Shared zero-dep helpers in `_Sprintpilot/lib/runtime/`: args, git, http, log, secrets, spawn, text, yaml-lite.
- Exit codes: 0 = success, 1 = expected failure, 2 = error.
- All accept `--help`. Most accept `--story` / `--phase` / `--meta` for timing instrumentation.

## Skill Definitions

Skills are markdown-based prompts interpreted by AI tools. All source skills live in `_Sprintpilot/skills/` and install into `<tool>/skills/` per tool.

### Autopilot Skills

| Skill | Files | Purpose |
|-------|-------|---------|
| `sprint-autopilot-on` | SKILL.md, workflow.orchestrator.md (≤150 lines) + `_Sprintpilot/bin/autopilot.js` state machine | Full autonomous sprint execution |
| `sprint-autopilot-off` | SKILL.md | Graceful exit with status report |
| `sprintpilot-update` | SKILL.md | In-IDE update flow (compares vs npm latest) |

### Multi-Agent Skills

| Skill | Agents | Purpose | Output |
|-------|--------|---------|--------|
| `sprintpilot-codebase-map` | 5 | Brownfield codebase analysis | 5 analysis files |
| `sprintpilot-assess` | 3 | Tech debt + dependency audit | `brownfield-assessment.md` |
| `sprintpilot-reverse-architect` | 3 | Bottom-up architecture extraction | BMad-compatible `architecture.md` |
| `sprintpilot-migrate` | 4 | Full-lifecycle migration planning | `migration-plan.md` + `migration-epics.md` |
| `sprintpilot-research` | N | Parallel research fan-out | Research report |

### Subagent Prompts

| Skill | Agents |
|-------|--------|
| Codebase Map | stack-analyzer, architecture-mapper, quality-assessor, concerns-hunter, integration-mapper |
| Assess | debt-classifier, dependency-auditor, migration-analyzer |
| Reverse Architect | component-mapper, data-flow-tracer, pattern-extractor |
| Migrate | stack-mapper, dependency-analyzer, risk-assessor, test-parity-analyzer |

## Configuration Components

| File | Purpose |
|------|---------|
| `_Sprintpilot/manifest.yaml` | Addon metadata, version, BMad compat, `installed_skills` |
| `_Sprintpilot/modules/autopilot/config.yaml` | Profile selection + session/retro settings |
| `_Sprintpilot/modules/autopilot/profiles/_base.yaml` | Shared defaults for nano/small/medium/large |
| `_Sprintpilot/modules/autopilot/profiles/{nano,small,medium,large}.yaml` | Profile overlays |
| `_Sprintpilot/modules/autopilot/profiles/legacy.yaml` | v1.0.5 byte-for-byte (standalone, `version_pinned`) |
| `_Sprintpilot/modules/git/config.yaml` | Git workflow (granularity, branches, lint, push, PR, worktree, lock, platform) |
| `_Sprintpilot/modules/ma/config.yaml` | Multi-agent + parallelism (state sharding, parallel stories/epics, gates) |
| `_Sprintpilot/modules/git/templates/pr-body.md` | PR body template |
| `_Sprintpilot/modules/git/templates/commit-story.txt` | Story commit template |
| `_Sprintpilot/modules/git/templates/commit-patch.txt` | Patch commit template |
| `_Sprintpilot/modules/git/branching-and-pr-strategy.md` | Branching strategy doc |

## Installation Components

| File | Purpose |
|------|---------|
| `bin/sprintpilot.js` | npm CLI (`install` / `uninstall` / `check-update`) |
| `lib/commands/install.js` | Install subcommand — per-tool deploy, system prompt upsert, legacy migration, `--profile` flag |
| `lib/commands/uninstall.js` | Uninstall subcommand — per-tool removal, marker strip, worktree cleanup |
| `lib/commands/check-update.js` | npm latest-version lookup |
| `lib/core/tool-registry.js` | 9 supported tools (skill dir + system-prompt strategy) |
| `lib/core/markers.js` | `<!-- BEGIN/END:sprintpilot-rules -->` block handling (+ legacy migration) |
| `lib/core/v1-detect.js` | Legacy `bmad-autopilot-addon` detection |
| `_Sprintpilot/templates/agent-rules.md` | Per-tool system prompt template |
| `_Sprintpilot/.secrets-allowlist` | Patterns excluded from secrets scanning |

## Test Components

### Unit + Integration Tests (Vitest, TypeScript)

Total: 535 tests across 32+ files. Highlights:

| Suite | Coverage |
|-------|----------|
| `agent-adapter.test.ts` | Host detection priority + tautology guard |
| `cached-read.test.ts` | TTL, mtime invalidation, stats |
| `check-prereqs.test.ts` | Node / git version gates |
| `complexity-profile.test.ts` | Profile resolution (base+overlay, fallback) |
| `conditional-boot-work.test.ts` | Clean-repo fast-path |
| `dispatch-layer.test.ts` | Worktree preflight + `.layer-plan.json` |
| `git-portable.test.ts` | 18 cases against real temp git repo + non-repo failure path |
| `infer-dependencies.test.ts` | 30 cases: schema, cycles, hash stability, override preservation, CLI round-trip |
| `inject-tasks-section.test.ts` | Numbered / bullet / `**AC-N:**` styles, fenced-block awareness |
| `list-remaining-stories.test.ts` | Every observed sprint-status shape |
| `log-timing.test.ts` | 24-writer race-free subprocess append + mark API + `_end` sentinel |
| `mark-done-stories-tasks.test.ts` | Fenced code blocks (``` and `~~~`), output_folder honoring |
| `merge-shards.test.ts` | Decision-log dedup, corrupt archive |
| `nano-routing.test.ts` | quick-dev escalation safety net |
| `preflight-merge.test.ts` | Real-temp-git-repo conflict detection |
| `resolve-dag.test.ts` | Kahn cycle detection, override merging, YAML round-trip |
| `resolve-profile.test.ts` | Base+overlay merge, missing-key fallback |
| `state-shard.test.ts` | Atomic write, monotonic tiebreaker |
| `state-shard-coalesce.test.ts` | Buffer + flush + crash-recovery key bypass |
| `submodule-lock.test.ts` | Concurrent acquire + slug keying |
| `summarize-timings.test.ts` | Pairing, hotspot threshold, formats |
| `sync-status-granularity.test.ts` | Story vs epic granularity passthrough |
| `with-retry.test.ts` | Ref-lock pattern matching, non-matching pass-through |
| `worktree-path-audit.test.ts` | `.worktrees/` scope enforcement |

### E2E Tests (Vitest, gated on Claude Code presence)

| Test | Strategy |
|------|----------|
| `greenfield.test.ts` | Build Tic Tac Toe / sudoku from scratch via autopilot |
| `brownfield.test.ts` | Multi-agent analysis pipeline on json-server |
| `sudoku.test.ts` | Web-game e2e exercising parallel dispatch |
| `medium-parallel.test.ts` | Asserts overlapping skill intervals in `.timings/*.jsonl` |
| `nano.test.ts` | Asserts quick-dev invocation + no `bmad-dev-story` |

### Test Harness

| Module | Purpose |
|--------|---------|
| `claude-runner.ts` | Spawns Claude Code CLI, captures JSON output |
| `assertions.ts` | File system, YAML, and git state assertions |
| `temp-project.ts` | Temporary project factory with BMad setup |
| `cost-tracker.ts` | API cost tracking and reporting |
| `git-utils.ts` | Story branch detection, dirty-tree probes |

## Platform Support Matrix

| Platform | CLI | API Fallback | Tested |
|----------|-----|-------------|--------|
| GitHub | `gh` | — | Yes |
| GitLab | `glab` | — | Yes |
| Bitbucket | `bb` | `curl` + `BITBUCKET_TOKEN` | Yes |
| Gitea | `tea` | `curl` + `GITEA_TOKEN` | Yes |
| Git-only | — | — | Yes |

## Linter Support Matrix

| Language | Linters (priority order) |
|----------|-------------------------|
| Python | ruff, flake8, pylint |
| JavaScript | eslint, biome |
| TypeScript | eslint, biome |
| Rust | cargo clippy |
| Go | golangci-lint |
| Ruby | rubocop |
| Java | checkstyle, pmd |
| C / C++ | cppcheck, clang-tidy |
| C# | dotnet format |
| Swift | swiftlint |
| PL/SQL | sqlfluff |
| Kotlin | ktlint, detekt |
| PHP | phpstan, phpcs |
