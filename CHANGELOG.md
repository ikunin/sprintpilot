# Changelog

## [Unreleased]

**PR 12 of 12 — Cross-epic parallelism (experimental)**

Ships the dry-run merge probe that PR 12's cross-epic dispatcher gates on. `parallel_epics` stays **off by default on every profile including `large`** — the feature is experimental and requires users to opt in explicitly per project after reviewing the risk profile. The preflight script is safe to invoke at any time; it never commits, never leaves the preflight branch behind, and holds a per-project lock so two preflights never race.

### Added
- `_Sprintpilot/scripts/preflight-merge.js` — checks every pair of epic branches for merge conflicts. Output: `{safe_pairs: [["1","3"]], conflict_pairs: [["2","4"]], checked: N}`. Safety rails:
  1. Lock acquisition via `lock.js --file .sprintpilot/preflight.lock` (default 60 s timeout). Only one preflight runs per project at a time.
  2. Startup cleanup — deletes a stale `__sprintpilot_preflight` branch if a prior run crashed. Refuses to run if HEAD is already on the preflight branch (paranoia).
  3. Per-pair cleanup — the preflight branch is checked out from base, merges land as commits on top, and the branch is force-deleted after every pair so base is never left mid-merge.
  4. try/finally release of the lock, even on fatal errors.
- `tests/unit/preflight-merge.test.ts` — 11 tests: epic input parsing, pair generation, real-repo safe vs. conflict detection, cleanup verification, mixed-layer triage, CLI exit codes. Uses a temp git repo per test (no mocks). Suite: 387 → 398 passing.

### Changed
- `_Sprintpilot/modules/ma/config.yaml`: new `parallel_epics` key (default `false`) with inline docs noting experimental status and hardcoded `max_parallel_epics=2`.
- `_Sprintpilot/modules/autopilot/profiles/large.yaml`: explicitly pins `parallel_epics: false` (not inherited). Future `_base` changes cannot silently flip the flag for compliance-conscious users.

### Rollback
- The default IS rollback — `parallel_epics: false` on every profile. The script is latent unless a workflow integration invokes it; users who do opt in can flip the single key back to disable.

## [Unreleased — PR 11]

**PR 11 of 12 — Parallel intra-epic stories (M2)**

Ships the orchestrator + host detector for parallel story execution within an epic. `parallel_stories: true` runs N sub-agents concurrently on Claude Code (the only host with a first-class multi-agent API today). Other hosts silently fall back to sequential with a one-line log notice — no silent no-op, no false promise of wall-clock reductions. Host detection prioritizes env vars (high confidence), then parent-process name (medium), then filesystem markers (low); low-confidence detection forces `supports_parallel=false` to close the install-marker tautology.

### Added
- `_Sprintpilot/scripts/agent-adapter.js` — `detect` command. Emits `{host, supports_parallel, confidence, detection_reason}`. Host capability table starts with `claude-code: supports_parallel=true` and every other host false. Future hosts opt in here after validation.
- `_Sprintpilot/scripts/dispatch-layer.js` — reads a comma-separated layer of story keys, creates one worktree per story, writes `_bmad-output/implementation-artifacts/.layer-plan.json` describing each story's worktree + branch. Script does NOT call LLMs; actual sub-agent spawning is the host workflow's job. `--max-parallel` caps concurrent worktrees, `--dry-run` computes the plan without touching the filesystem.
- `tests/unit/agent-adapter.test.ts` — 9 tests: host-capability table, env-var precedence, filesystem-marker tautology guard, unknown-host default.
- `tests/unit/dispatch-layer.test.ts` — 10 tests: layer parsing (including path-traversal rejection), effective-parallel bounds, plan file atomicity, CLI exit codes.

### Changed
- `_Sprintpilot/modules/ma/config.yaml`: new keys `parallel_stories` (default false), `max_parallel_stories` (2), `min_epic_duration_for_parallel_sec`, `baseline_story_duration_sec`, `max_consecutive_conflicts`, `effective_parallel_floor`.
- `_Sprintpilot/modules/autopilot/profiles/_base.yaml` + `large.yaml`: profile defaults align with the plan (`medium`: off by default, opt-in max 2; `large`: on, max 3).
- `_Sprintpilot/skills/sprint-autopilot-on/workflow.md`: boot detects the host and reads `ma.parallel_stories`. Coerces `parallel_stories=false` when the host's detection confidence is not `high` OR `supports_parallel=false`, and logs a one-line notice so users on non-Claude-Code hosts get a predictable sequential experience.

### Rollback
- Set `ma.parallel_stories: false` on the active profile (default on all profiles except `large`). Dispatcher is never invoked; autopilot reverts to sequential.

## [Unreleased — PR 10]

**PR 10 of 12 — Worktree cost mitigation + concurrent discipline**

Makes per-worktree submodule init 2–5s instead of ~30s on git ≥ 2.18 via `--reference` + `--jobs=4`. Wraps ref-mutating git calls with a jittered-backoff retry so transient ref-lock contention in concurrent worktree setups doesn't fail builds. Per-submodule locks serialize concurrent `git submodule update` calls across worktrees. `gc.auto` is disabled for the duration of a sprint on both the main repo and every worktree, then restored.

### Added
- `_Sprintpilot/scripts/with-retry.js` — 3-attempt jittered-backoff retry (500ms–2s) triggered only when stderr matches a ref-lock regex (configurable via `--pattern`). Non-matching failures pass through unchanged — no blind retry hiding real bugs.
- `_Sprintpilot/scripts/submodule-lock.js` — thin wrapper over `lock.js --file` keyed by submodule slug. Locks live under `<project>/.sprintpilot/submodule-locks/` (outside `.git/`) so git doesn't warn about foreign files.
- `tests/unit/with-retry.test.ts` — 11 tests: default regex coverage, custom `--pattern`, retry success after N attempts, give-up after attempts exhausted, non-retriable pass-through, CLI exit codes.
- `tests/unit/submodule-lock.test.ts` — 10 tests: slugify, lock-path resolution, acquire/release/check, cross-submodule non-contention, CLI exit codes.
- `tests/unit/worktree-path-audit.test.ts` — regression guard: scans workflow.md + every script for commands that treat `<worktree>/.git` as a directory. In a worktree, `.git` is a file pointer; `ls .git/refs/...` would break silently.

### Changed
- `_Sprintpilot/skills/sprint-autopilot-on/workflow.md`:
  - Boot saves + disables `gc.auto` on the main repo; sprint complete (step 10) restores it.
  - Each worktree saves + disables `gc.auto` on worktree entry.
  - Submodule init now uses `git submodule update --init --recursive --reference "$GIT_COMMON" --jobs=4 -- <path>` on git ≥ 2.18, wrapped with `with-retry.js`, with a per-submodule lock acquired before and released after. Falls back to the plain command on older git (degraded mode, already warned at boot by `check-prereqs.js`).

### Rollback
- Revert the PR. The retry wrapper is a no-op when not invoked; the per-submodule lock is a no-op when unused. The `gc.auto` change is self-unwinding because restore is symmetric.

## [Unreleased — PR 9]

**PR 9 of 12 — Dependency sidecar + DAG resolver**

Ships the Sprintpilot-owned `dependencies.yaml` format and a resolver that turns it into an execution DAG for parallel dispatch (PR 11+). Missing sidecar → linear chain from sprint-status order (no surprises). Cycles rejected with a clear diagnostic. Includes a `scaffold` subcommand that writes a safe linear starter + inline docs so users don't have to hand-craft the first file.

### Added
- `_Sprintpilot/scripts/resolve-dag.js` — commands: `graph`, `layers`, `width`, `scaffold`. Strategies: `explicit` (reads `_Sprintpilot/sprints/dependencies.yaml`), `ordering` (linear chain from sprint-status). Priority: explicit > ordering; a sidecar `force_independent` override strips inbound/outbound edges on listed keys; `force_sequential` adds a chain among listed keys; epic-filtered builds.
- Purpose-built YAML parser inside `resolve-dag.js` for hand-authored block-form `dependencies.yaml`: nested objects, block-form lists with inline mappings (`- key: value`), flow-form arrays on value side (`["a","b"]`), quoted keys (`"2"`), trailing comments. Deliberately narrower than a full YAML impl so no install-time dep (mirrors the PR 1 `resolve-profile.js` invariant).
- `tests/unit/resolve-dag.test.ts` — 22 new tests covering parser round-trip on the plan's canonical example, epic filter, cycle detection, `force_independent` / `force_sequential` overrides, scaffold (create, refuse-overwrite, `--force`), CLI exit codes.

### LLM graph inference — not in scope
Per concept §7.6, Sprintpilot scripts never call LLMs. Any future AI-inferred DAG would land as a separate `sprintpilot-infer-dependencies` skill writing a proposed `dependencies.yaml`; the resolver keeps consuming the human-affirmed sidecar via the `explicit` strategy.

### Rollback
- Delete or empty `_Sprintpilot/sprints/dependencies.yaml`. Resolver falls back to `ordering` (linear chain) and subsequent PRs (11+) serialize execution accordingly. No behavior change.

## [Unreleased — PR 8]

**PR 8 of 12 — Cached per-iteration reads (M5)**

Ships a TTL + source-mtime-aware file cache for the autopilot loop. `sprint-status.yaml`, `git-status.yaml`, and `decision-log.yaml` get read 5+ times per story step today; cached reads cut those to one disk read per TTL window, invalidating automatically when the source file's mtime advances (so writes are seen immediately without an explicit `invalidate` call).

### Added
- `_Sprintpilot/scripts/cached-read.js` — `read` / `invalidate` / `clear` / `stats` actions. Cache entries land under `<cache-root>/.cache/cached-reads/<sha256(path)>.json` carrying `{source, mtime_ms, cached_at, body}`. Default TTL 60s. Source mtime advances always force a miss.
- `tests/unit/cached-read.test.ts` — 9 new tests: miss-then-hit, mtime-driven invalidation, ttl=0 = always-miss, invalidate, clearAll, stats, CLI round-trip, missing-source exit 2.

### Changed
- `_Sprintpilot/modules/autopilot/profiles/_base.yaml`: `cache_shared_reads: false → true`. `legacy` keeps the false default. Consumer gate — callers check `autopilot.cache_shared_reads` via `resolve-profile.js` before shelling out to `cached-read.js`; when the flag is false, read the file directly.

### Rollback
- Set `autopilot.cache_shared_reads: false` on the active profile. Callers skip the cache and read through.

## [Unreleased — PR 7]

**PR 7 of 12 — Conditional boot work (M4)**

On a clean repo (no extra worktrees, no in-progress stories) the autopilot now skips `health-check.js` + branch reconciliation at boot. This is the common case when starting a fresh session on a merged-and-done sprint state; typical savings are ~8–28s of `git fetch` + worktree scans. The `large` profile keeps full reconciliation always (compliance/uptime rationale); `legacy` preserves v1.0.5 behavior.

### Added
- `tests/unit/conditional-boot-work.test.ts` — locks in the per-profile default: nano/small/medium=`true`, large/legacy=`false`.

### Changed
- `_Sprintpilot/modules/autopilot/profiles/_base.yaml`: `conditional_boot_work: false → true`. Inherited by nano/small/medium.
- `_Sprintpilot/modules/autopilot/profiles/large.yaml`: already set `conditional_boot_work: false` (unchanged). Also fixed `ma.state_sharding: true → always` to match the PR 3 tri-valued string.
- `_Sprintpilot/skills/sprint-autopilot-on/workflow.md`: boot resolves `conditional_boot_work` via the profile, counts worktrees via `git worktree list --porcelain` and in-progress stories via `sprint-status.yaml`. When both counts imply a clean repo AND the flag is on, the autopilot logs a `boot.fast-path` once-marker and skips the health-check / reconciliation block; otherwise it runs the existing full path.

### Rollback
- Set `autopilot.conditional_boot_work: false` on the active profile, or switch to `legacy` / `large`. Boot reverts to the full path unconditionally.

## [Unreleased — PR 6]

**PR 6 of 12 — Coalesce state writes (M3)**

Adds a `batch` / `flush` mode to `state-shard.js` that buffers non-critical field changes in a pending file and flushes them atomically at a story boundary — one shard write per story instead of 5+. Four crash-recovery keys (`current_story`, `current_bmad_step`, `in_worktree`, `patch_commits`) bypass the buffer and write straight through, keeping resume-after-crash semantics intact. Infrastructure ships now; PR 11 (parallel stories) is the first consumer.

### Added
- `_Sprintpilot/scripts/state-shard.js` — new `batch` and `flush` actions. `batch` accumulates partial updates into `.pending/<kind>/<story>.yaml`; `flush` merges pending into the shard and deletes the pending file. `write` auto-flushes pending first (so direct writes never leave stale buffers). Exports `CRITICAL_KEYS`, `containsCriticalKey`, `batchWrite`, `flushPending`.
- `tests/unit/state-shard-coalesce.test.ts` — 9 new tests covering pending accumulation, idempotent flush, merge into existing shard, critical-key bypass (prior buffer + new write both land), and write auto-flush. Suite: 300 → 309 passing.

### Changed
- `_Sprintpilot/modules/autopilot/profiles/_base.yaml`: `coalesce_state_writes: false → true`. `legacy` keeps the pre-PR direct-write behavior.

### Rollback
- Set `autopilot.coalesce_state_writes: false` on the active profile. Callers fall back to direct `write` calls (the existing path).

## [Unreleased — PR 5]

**PR 5 of 12 — Nano orchestration cuts (epic-granularity, squash merge, in-place branching)**

When `git.granularity: epic`, the autopilot creates one branch per epic and one PR per epic (merged with `--squash`) instead of one branch / PR per story. When `git.worktree.enabled: false`, stories run in-place on the shared branch with no worktree. Both settings are nano defaults; other profiles keep story granularity.

### Added
- `_Sprintpilot/modules/git/config.yaml` — new `git.granularity` key (`story | epic`, default `story`) with inline docs.
- `_Sprintpilot/scripts/sync-status.js` — accepts `--granularity <story|epic>` and `--epic-id <id>` passthrough; records them on the story block so downstream code can reconstruct the epic → branch mapping.
- `tests/unit/sync-status-granularity.test.ts` — 3 tests covering the new fields + validation.

### Changed
- `_Sprintpilot/skills/sprint-autopilot-on/workflow.md`:
  - Boot reads `git.granularity`, `git.worktree.enabled`, `git.squash_on_merge` from config.yaml and overrides them with the resolver's profile value.
  - Step 3 computes `{{epic_id}}`, `{{is_first_story_of_epic}}`, `{{is_last_story_of_epic}}` from the story key + sprint-status. Under `granularity=epic`, the branch name is forced to `epic-<id>` so every story in the epic lands on the same branch. Under `worktree.enabled=false`, the autopilot checks out that branch in place instead of creating a worktree.
  - Step 7 defers push + PR until the last story of the epic under `granularity=epic`. Earlier stories record `push_status=deferred`, `pr_url=DEFERRED`.
  - Merge step uses `git merge --squash` + a single epic commit when `squash_on_merge=true`; otherwise keeps the existing merge-commit path.
- `_Sprintpilot/modules/autopilot/profiles/nano.yaml`: already had the settings; PR 5 makes the workflow honor them.

### Rollback
- Flip `git.granularity: story`, `git.worktree.enabled: true`, `git.squash_on_merge: false` on the active profile (or just switch off `nano`). Workflow reverts to one branch per story, one PR per story, merge-commit.

## [Unreleased — PR 4]

**PR 4 of 12 — Nano routing through `bmad-quick-dev`**

When the active profile declares `implementation_flow: quick` (nano only, by default), the autopilot routes each story through BMad's `bmad-quick-dev` one-shot skill instead of the 7-step cycle. Quick-dev runs Implement → Review → Classify → Commit internally (BMad `step-oneshot.md:44`), so `bmad-create-story`, `bmad-check-implementation-readiness`, `bmad-dev-story`, and `bmad-code-review` are not invoked under nano. Quality gates are preserved via quick-dev's internal review.

### Added
- `_Sprintpilot/modules/autopilot/profiles/nano.yaml` declares a `nano.fallback_on_tests_fail`, `nano.fallback_on_quick_dev_high_severity`, and `nano.fallback_target` escalation block.
- `tests/unit/nano-routing.test.ts` — 9 tests asserting `implementation_flow` resolves correctly per profile and the nano-specific escalation + orchestration keys are exposed to the workflow.

### Changed
- `_Sprintpilot/skills/sprint-autopilot-on/workflow.md` — (1) boot resolves `{{implementation_flow}}` via `resolve-profile.js`; (2) step 3 overrides `{{next_skill}} = bmad-quick-dev` when `implementation_flow = quick AND next_skill in {bmad-dev-story, bmad-create-story, bmad-check-implementation-readiness}`; (3) step 4 adds a `bmad-quick-dev` completion handler that jumps directly to "mark story done" and escalates (session-scoped, not persisted) to `full` flow if tests fail or classify severity is high.
- `AGENTS.md` — nano section spells out the skipped skills and the escalation safety net.

### Rollback
- Set `complexity_profile` to anything except `nano`. The autopilot falls back to the 7-step cycle immediately.

## [Unreleased — PR 3]

**PR 3 of 12 — State-shard infrastructure**

Per-story shards for `autopilot-state.yaml` and `decision-log.yaml` so that parallel sub-agents (PR 11) can write without contention. The coordinator merges at layer boundaries. Shipping the scripts + schema; workflow consumers land in PR 6 (coalesce) and PR 11 (parallel).

### Added
- `_Sprintpilot/scripts/state-shard.js` — `write` / `read` / `append` / `init` over `.autopilot-state/<story>.yaml` and `.decision-log/<story>.yaml`. Atomic writes via tmp-sibling + `rename()`. Flat dotted-keys + JSON flow-form file shape — still valid YAML, round-trips without a general YAML parser so the installed script has zero install-time deps.
- `_Sprintpilot/scripts/merge-shards.js` — merges shards into authoritative project-level YAMLs. Decision-log dedupe by `id`, sort by `ts`. Corruption recovery: a shard that fails to parse OR lacks `updated_at` is moved to `.archive/corrupt/` and flagged on the merged output; never deleted. Idempotent. `--archive` moves merged shards to `.archive/layer-<id>/`. `--dry-run` computes without writing.
- 39 new unit tests (23 in `state-shard.test.ts`, 16 in `merge-shards.test.ts`), including concurrent-subprocess writes to distinct shards and corruption-archive verification. Suite: 249 → 288 passing.

### Changed
- `_Sprintpilot/modules/autopilot/profiles/_base.yaml` + `legacy.yaml`: `state_sharding` is now a tri-valued string (`never | auto | always`), default `auto` on non-legacy, `never` on legacy. Prior boolean shape is replaced (the key was never consumed).
- Shard schema adds an intra-process `updated_at.monotonic` tiebreaker alongside `updated_at.wall` so parallel writers within a single process resolve conflicts without NTP drift interference.

### Rollback
- Set `ma.state_sharding: never` on the active profile. Future workflow consumers of sharding gate on this value and fall back to direct writes.

## [Unreleased — PR 2]

**PR 2 of 12 — M0 phase-timing instrumentation**

Emits per-phase duration measurements so subsequent optimizations (PRs 3–12) can be validated against a real baseline instead of estimated percentages.

### Added
- `_Sprintpilot/scripts/log-timing.js` — append-only JSONL writer. Path-traversal-guarded `--story` / `--phase` arg validation, 2 KB cap on `--meta`, 4 KB cap on the full line so a single POSIX `write()` is atomic. Silently no-ops when the resolved `autopilot.phase_timings` is not `true`. Shard-per-story model (one sub-agent = one writer).
- `_Sprintpilot/scripts/summarize-timings.js` — reads `.timings/<story>.jsonl` shards, pairs `start`/`end` events per story + phase, emits a hotspot report (phases consuming > 5% of total paired time). Formats: text (stdout), json (stdout), md (artifact + stdout). `--session-only` writes `summary-session-<ts>.md`; default writes `summary-<YYYY-MM-DD>.md`.
- 40 new unit tests (23 in `log-timing.test.ts`, 17 in `summarize-timings.test.ts`), including a race-free subprocess append test (24 parallel writers to the same shard, all 24 lines present).

### Changed
- `_Sprintpilot/modules/autopilot/profiles/_base.yaml`: `phase_timings: true` default (was false). `legacy` profile stays `false` (explicit in `legacy.yaml`) to preserve v1.0.5 byte-for-byte behavior.
- `_Sprintpilot/skills/sprint-autopilot-on/workflow.md`: wrapped the primary skill `INVOKE` site, the code-review re-invoke, worktree add / submodule-init, test verification, and `git.commit` with `log-timing.js start` / `end` hooks. Session checkpoint calls `summarize-timings.js --session-only`; sprint complete calls the full summarizer.

### Rollback
- Set `autopilot.phase_timings: false` in `_Sprintpilot/modules/autopilot/config.yaml`, or switch to `complexity_profile: legacy`. All instrumentation becomes a silent no-op.

## [2.0.0] - 2026-04-23

**Major release: Adaptive Process Scaling — PR 1 of 12 (Foundation)**

Introduces `complexity_profile` as a first-class config dimension. Existing installs are unaffected — the missing-key default matches v1.0.5 behavior byte-for-byte. Full concept and roadmap: `docs/adaptive-process-scaling.md` and `docs/implementation-plan.md`.

### Added
- `_Sprintpilot/modules/autopilot/profiles/` — five profile YAMLs (`_base`, `nano`, `small`, `medium`, `large`, `legacy`). Base + overlay (DRY); `legacy` stands alone with `version_pinned: "v1.0.5"` so future refactors cannot silently drift legacy behavior.
- `_Sprintpilot/scripts/resolve-profile.js` — `print` / `get` / `validate` commands. Missing `complexity_profile` key defaults to `medium` with a stderr notice. Consulted by `workflow.md` starting PR 4.
- `_Sprintpilot/scripts/check-prereqs.js` — verifies node ≥ 18 and git ≥ 2.18. Warns (does not fail) on git 2.5–2.17 for degraded mode (no submodule speedups).
- `sprintpilot install --profile <name>` — non-interactive CLI flag. Five values: `nano | small | medium | large | legacy`.
- Interactive installer now asks for complexity profile between autopilot settings and tool selection. Upgrading users see their existing profile as the default.
- `complexity_profile` key in `_Sprintpilot/modules/autopilot/config.yaml` with full documentation inline.

### Changed
- `AGENTS.md` — "BMad Method is non-negotiable" section reframed as "Flow selection is profile-driven". The per-story 7-step cycle is still mandatory for `small`/`medium`/`large`/`legacy`; `nano` routes through `bmad-quick-dev` (behavior gated on PR 4).

### Deprecation
- **v1.x branch enters maintenance.** Security fixes + critical bug fixes only through **2026-10-31**. No new features. v2 active for 18 months after v3.0.0 ships.
- **Rollback.** Set `complexity_profile: legacy` in `_Sprintpilot/modules/autopilot/config.yaml` to pin to v1.0.5 semantics.
- **NPM upgrade path.** `npm i -g @ikunin/sprintpilot@latest` preserves behavior via the missing-key default. No interactive prompt on upgrade — scripted CI upgrades unaffected.

### Unreleased (PRs 2–12, future versions)
- **v2.1.0** (PRs 2–8): M0 phase-timing instrumentation, state-shard infrastructure, nano routing, nano orchestration cuts, M3/M4/M5 overhead cuts.
- **v2.2.0** (PRs 9–11): dependency sidecar, worktree cost mitigation, parallel intra-epic stories (Claude Code only; sequential fallback on other hosts).
- **v2.3.0** (PR 12): cross-epic parallelism (experimental).

## [1.0.5] - 2026-04-21

### Fixed
- `sprint-autopilot-on`: stopped routing new projects straight to `bmad-sprint-planning` (Phase 4); routes through `bmad-help` so Phase 1–3 gaps (PRD, architecture, epics) are caught first.
- `sprint-autopilot-on`: added `origin` remote check to git bootstrap. Local-only repos no longer error on `git fetch origin`; push/PR is automatically disabled in that mode.
- `sprintpilot-update`: fixed `npx @ikunin/sprintpilot@latest@{latest}` syntax error → `npx @ikunin/sprintpilot@{latest}`.

### Changed
- `sprint-autopilot-on`: stack detection is now stack-agnostic. Prefers `project-context.md` and `architecture.md` (BMAD-authored sources of truth), falling back to manifest heuristics across Node, Python, Go, Rust, Java/Kotlin, Ruby, .NET, PHP, Elixir, Docker, and Makefile. README install/run/test and the final launch command are all derived from the detected stack.
- `sprint-autopilot-on`: compacted from 1347 → 890 lines (−34%). Extracted `epic-retrospective.md` and `sprint-report.txt` to `_Sprintpilot/templates/`; deduplicated stack detection; inlined a shared `STATE_FIELDS` reference to replace three repeated YAML blocks; compressed shell-portability and decision-logging prose.

## [1.0.4] - 2026-04-21

### Added
- `sprint-autopilot-on`: configurable retrospective handling with `auto` / `stop` / `skip` modes, so epic rollovers don't silently loop.

### Fixed
- `sprint-autopilot-on`: addressed review findings on the retrospective-mode rollout.
- CI / installer: preserve v1 autopilot config values during upgrade, and activate the pre-push hook via `scripts/setup-git-hooks.mjs`.

## [1.0.3] - 2026-04-20

### Added
- `_Sprintpilot/scripts/scan.js` — cross-platform codebase scanner (subcommands: `files`, `largest`, `loc`, `extensions`). Replaces bash pipelines (`find … -exec wc -l | sort | head`) so sprintpilot skills run on Windows PowerShell / cmd, not just bash. Features: nested brace globs, symlink following with cycle protection, strict `--root` containment.
- 19 new unit tests covering glob edge cases, symlink handling, cycle protection, and root-escape prevention.

### Changed
- `sprintpilot-codebase-map` agents (stack-analyzer, architecture-mapper, quality-assessor, concerns-hunter, integration-mapper): exploration sections rewritten to use the LLM's native Glob/Grep/Read tools plus `scan.js` for aggregation. No more bash-only commands (`find`, `wc`, `grep -r`, `2>/dev/null`).
- `sprint-autopilot-on` workflow: added a shell-portability preamble with a bash→PowerShell translation table; converted `rm -rf`, `if [ -f … ]`, and the `2>/dev/null || true` / `|| true` idioms; preserved fail-fast semantics where `&&` was load-bearing (added explicit STOP-on-failure notes).
- Stale `sync-status.sh` references in `sprint-autopilot-on/workflow.md` updated to `sync-status.js` (the actual script).

### Fixed
- Skills now run under Gemini CLI and other LLM CLIs on Windows. Previously, bash-specific syntax caused silent failures when commands were dispatched through PowerShell or `cmd`.

## [1.0.2] - 2026-04-17

### Changed
- README: section heading **"The Solution: Sprintpilot"** → **"The Solution: Sprint Autopilot"** to lead with the headline feature name.
- README: scanned file types list for `sprintpilot-codebase-map` now correctly lists **C** and **C++** (the agent prompts have scanned `.c`, `.cc`, `.cpp`, `.cxx`, `.h`, `.hpp`, `.hxx` since legacy v1.0.21; the README was out of date).

### Added (developer tooling — no user-facing runtime changes)
- `.github/workflows/ci.yml`: fast test suite now runs on every push to `main` and every PR, in addition to the release-driven publish workflow.
- Biome for lint + format (config at repo root, `@biomejs/biome` in `tests/` devDeps so it doesn't ship). One-time `biome check --write .` reformat applied (single-quote, trailing commas, 100-col, 2-space). No semantic code changes; 265/265 tests green before and after.
- `.githooks/pre-push` — opt-in local hook running `biome ci .` + `npm run test:fast` before push. Enable with `git config core.hooksPath .githooks`.
- `docs/CONTRIBUTING.md`: new **Developer setup (one-time)** section documenting the hook opt-in and the `biome check --write` auto-fix command.

### Fixed (CI)
- `detect-platform` test's "no CLI" fallback case used `/usr/bin` in its minimal PATH, which leaks `gh` on GitHub Actions runners. Replaced with a tmpdir containing only `git` and `node` symlinks — test now correctly asserts `git_only` everywhere.

## [1.0.1] - 2026-04-17

### Fixed
- **Autopilot runtime crash**: `sprint-autopilot-on/workflow.md` still invoked helper scripts as `bash …/scripts/*.sh`, but they've been Node since the legacy v1.0.21. Replaced all 12 call sites with `node …/scripts/*.js` so the autopilot actually runs.
- **BMad Method version shown as "unknown"** during install: the installer read `bmadManifest.version` but BMad v6 writes the manifest with `version` nested under `bmad:`. New `extractBmadVersion()` helper tolerates both flat and nested shapes, plus a unit test covering both.
- `check-update` test fixture — 1.0.10 was correct against the legacy v1.0.21 on the registry, but higher than the `@ikunin/sprintpilot@1.0.0` baseline after the rebrand reset. Switched the "update available" assertion to pin 0.0.1 inside the test.

### Changed
- **npm package scope: `sprintpilot` → `@ikunin/sprintpilot`**. Unscoped `sprintpilot` is blocked by npm's typosquat-similarity policy (existing unrelated package `sprint-pilot`). Install: `npm i -g @ikunin/sprintpilot`. Product name, CLI binary (`sprintpilot`), skill IDs, and the GitHub repo slug are unchanged — only the npm install path differs.
- Installer banner layout: version is rendered inline on the 2nd-to-last banner row (`|____/| .__/…  v1.0.1`) instead of a standalone line below.
- Trademark phrasing tightened across `TRADEMARK.md`, `README.md`, `CHANGELOG.md`, `MIGRATION.md` — dropped third-party trademark-ownership claims that belong to the mark holder's own notices, not ours.
- Documentation refreshed across `docs/**` for the Node-script runtime (was still describing the bash + BATS world from before the legacy v1.0.21 migration).

## [1.0.0] - 2026-04-17

Initial public release of **Sprintpilot** — an autonomous story-execution and multi-agent addon for [BMad Method](https://github.com/bmad-code-org/BMAD-METHOD) v6. See [README.md](README.md) for features and [TRADEMARK.md](TRADEMARK.md) for the trademark policy acknowledgment.

### Relationship to `bmad-autopilot-addon`

Sprintpilot succeeds the `bmad-autopilot-addon` npm package (versions 1.0.0 – 1.0.21), which has been deprecated for trademark compliance with the [BMad Code, LLC policy](https://github.com/bmad-code-org/BMAD-METHOD/blob/main/TRADEMARK.md) prohibiting use of "BMad"/"BMAD" in product and package names. Functionality is unchanged; only the product name, package, and skill IDs changed. See [MIGRATION.md](MIGRATION.md) for the upgrade path.

### Package / CLI

- npm package: **`sprintpilot`**
- CLI binary: **`sprintpilot`**

### Project directory

- `<project>/_Sprintpilot/` — addon runtime, manifest, module configs, bundled skills
- `<project>/_Sprintpilot/Sprintpilot.md` — full skill catalog and workflow reference
- `<project>/_Sprintpilot/modules/{git,ma,autopilot}/config.yaml` — user-editable module configs

### Skills (slash commands)

| Skill | Purpose |
|-------|---------|
| `sprint-autopilot-on` | Engage autonomous story execution with git integration |
| `sprint-autopilot-off` | Disengage, show sprint + git status |
| `sprintpilot-update` | Check for Sprintpilot updates |
| `sprintpilot-code-review` | Parallel 3-layer adversarial code review |
| `sprintpilot-codebase-map` | 5-stream brownfield codebase analysis |
| `sprintpilot-assess` | Tech debt / dependency audit |
| `sprintpilot-reverse-architect` | Extract architecture from existing code |
| `sprintpilot-migrate` | Legacy migration planning |
| `sprintpilot-research` | Parallel web research |
| `sprintpilot-party-mode` | Multi-persona agent discussions |

### Agent-rules marker

Sprintpilot upserts a `<!-- BEGIN:sprintpilot-rules --> ... <!-- END:sprintpilot-rules -->` block into per-tool rule files (`AGENTS.md`, `GEMINI.md`, `.windsurfrules`, `.clinerules`, `.github/copilot-instructions.md`) so agents stay aware of the BMad Method workflow guardrails.

### Legacy migration from `bmad-autopilot-addon`

`sprintpilot install` detects a legacy `_bmad-addons/` layout automatically and cleanly replaces it:

- Snapshots the full `_bmad-addons/modules/<mod>/` tree (config.yaml + user-customized templates) into memory.
- Strips legacy `<!-- BEGIN/END:bmad-workflow-rules -->` blocks from rule files, writing atomic backups to `<file>.bak-sprintpilot-migration`.
- Removes legacy skill directories from all project-level tool skill folders (project-scoped; user-global `~/.claude/skills/` is untouched).
- Removes the `_bmad-addons/` directory.
- Reapplies the v1 snapshot on top of the freshly-installed v2 bundled resources, preserving user config values.
- If post-install reapply fails, persists the snapshot to `.sprintpilot-v1-snapshot.json` for manual recovery.
- Advises removing the legacy global npm package `bmad-autopilot-addon` if detected.
- Adds `*.bak-sprintpilot-migration` and `.sprintpilot-v1-snapshot*.json` to the project `.gitignore`.

Flags:

- `--migrate-v1` — required under `--yes` for destructive migration (so CI can't silently rewrite a repo's legacy footprint).
- Interactive confirmation with `initialValue: false` for manual runs.

### Core library (new)

- `lib/core/v1-detect.js` — shared legacy-detection module used by install and uninstall.
- `lib/core/markers.js` — first-END span semantics with iterative duplicate cleanup; legacy-marker helpers (`stripLegacyBlock`, `hasLegacyBlock`) for migration-time rewriting.

### Acknowledgments

Sprintpilot is an independent, unaffiliated project. See [TRADEMARK.md](TRADEMARK.md).

---

## Historical changelog from the legacy `bmad-autopilot-addon` package

The entries below document the final versions of the now-deprecated `bmad-autopilot-addon` npm package. They are retained for reference; new development continues under `sprintpilot@1.0.0` above.

## [bmad-autopilot-addon 1.0.21] - 2026-04-17

### Changed
- **License: MIT → Apache 2.0.** Full Apache 2.0 text in `LICENSE`, `"license": "Apache-2.0"` in `package.json`, badges and references updated.
- Installer rewritten in pure Node.js (was Bash). Eliminates the Windows WSL/Git-Bash PATH detection problem entirely — no bash is spawned at any point during install or uninstall. Matches the architecture used by the upstream `bmad-method` package.
- Installer now respects BMAD's `output_folder` setting from `_bmad/bmm/config.yaml`. Skill files and the agent-rules template use `{output_folder}`, `{planning_artifacts}`, and `{implementation_artifacts}` placeholders; the installer substitutes the configured values when copying files to each tool directory. Default remains `_bmad-output`.
- Runtime helper scripts (lock, detect-platform, health-check, sanitize-branch, sync-status, stage-and-commit, create-pr, lint-changed) rewritten in pure Node.js. Workflow invocations switched from `bash .../scripts/*.sh` to `node .../scripts/*.js`. No bash anywhere in the addon surface — the Windows WSL problem is now impossible to hit at runtime as well.

### Added
- Dependencies: `commander`, `@clack/prompts`, `@clack/core`, `fs-extra`, `js-yaml`, `semver`, `picocolors`. Runtime scripts have **zero runtime dependencies** — they use Node built-ins only (`fs`, `child_process`, `crypto`, `https`).
- Interactive tool picker now uses `@clack/prompts` (arrow-key multiselect) instead of numbered text prompt.
- `_bmad-addons/lib/runtime/` — shared zero-dep helpers consumed by runtime scripts (arg parsing, git wrapper, YAML-lite, secrets scan, etc.).
- Test suite migrated from Bats to Vitest: 9 script suites (`tests/scripts/*.test.ts`) plus new unit tests for helper modules (`tests/unit/*.test.ts`). 187 tests covering runtime scripts + installer helpers (args parsing, YAML shape, markers, secrets glob, bmad-config precedence, gitignore handling, placeholder substitution). Runs in ~13s, no Bats dependency.

### Removed
- `bin/bmad-autopilot-addon.sh`, `_bmad-addons/install.sh`, `_bmad-addons/uninstall.sh` — replaced by Node.js equivalents under `lib/`.
- `_bmad-addons/scripts/*.sh` — all 8 bash runtime scripts replaced by `.js` equivalents at the same paths.
- Bats test suite (`tests/scripts/*.bats`, `tests/scripts/helpers/setup.bash`) — replaced by Vitest equivalents.

### Fixed (code review)
- **[CRITICAL]** Lock acquire race: two processes both seeing `FREE` could both write. Now uses `fs.openSync(..., 'wx')` for atomic exclusive create; stale takeover re-runs the exclusive create after unlink.
- Lock integrity: corrupt/directory/unreadable lock files are now treated as `LOCKED` instead of silently evicted as stale. Future-dated `lockTime` (clock skew) is treated as `STALE` to prevent locks that never expire.
- `sync-status.js` / `lib/core/markers.js`: atomic write now falls back to `copyFile + unlink` on `EXDEV` (cross-device rename, e.g. Docker volumes). Tmp file names include 4 random bytes to prevent collision between concurrent writers.
- `yaml-lite.js` `replaceStoryBlock`: no longer inflates blank lines across repeated upserts; emits exactly one separator. `readStoryField` correctly exits a block on any line at or shallower than the story's indent (previous regex allowed spill into siblings).
- `yaml-lite.js` `yamlSafe`: now quotes YAML-reserved string literals (`true`, `false`, `yes`, `no`, `null`, `on`, `off`, etc.) so they round-trip as strings instead of being re-parsed as booleans/null.
- `sanitize-branch.js`: rejects `--max-length` below 8 (prior behavior silently produced branch names exceeding the limit). Strips `/` and collapses `..` sequences to prevent path-traversal-shaped branch names.
- `secrets.js`: secret detection now recognizes concrete real-world key formats (AWS `AKIA*`, GitHub `ghp_*`/`gho_*`/`github_pat_*`, OpenAI-style `sk-*`, Stripe `sk_live_*`/`sk_test_*`, Slack `xox[baprs]-*`, Google `AIza*`, PEM private-key headers) — previously only matched the literal words "API_KEY", "SECRET", etc.
- `stage-and-commit.js`: uses `lstat` to skip symlinks; skips secret scan for files larger than 2 MB (prevents OOM on accidentally-staged multi-MB logs); `.gitignore` check now uses exact line match instead of substring (was fooled by the entry appearing in a comment).
- `lib/core/markers.js` `findBlock`: uses `lastIndexOf(END)` so nested/duplicate BEGIN markers from a prior bad install collapse cleanly on the next upsert.
- `lib/core/bmad-config.js`: deterministic module precedence (sort `readdir` entries); loud warning on malformed YAML instead of silent fallback to default `output_folder`.
- `lib/runtime/http.js`: response body capped at 5 MB (prevents OOM on unbounded / malicious responses); 3xx redirects surfaced explicitly instead of silently succeeding.
- `create-pr.js`: remote URL parsing handles GitLab subgroups and SSH aliases (`ssh://`, `git@host-alias:`). Owner/repo components validated against a safe character set before interpolation into REST paths. Error logs redact `Authorization` / `Bearer` / `token` fields.
- `lib/commands/install.js`: skill install uses `.new` staging + `fs.move` so Ctrl-C between remove+copy can't leave a tool with no skill. Backup timestamps use UTC components (DST-safe).
- `lib/runtime/spawn.js`: registers `proc.on('error', ...)` so spawn-time ENOENT rejects the Promise instead of crashing on `proc.stdin.write`.
- `lint-changed.js`: removed hardcoded `/google_checks.xml` Linux-absolute path; runs `checkstyle` without `-c` when no config file is present.
- `sync-status.js`: `worktree_cleaned` field now only emitted when the flag is explicitly passed (prior default of `false` silently overwrote prior `true` on every update).
- Stale `.sh` filename references updated to `.js` in skill workflow prose and config comments.

### Fixed (code review, round 2)
- `yaml-lite.js` `readStoryField` now strips quotes only when the value is fully paired-quoted, and unescapes `\"` within — prior behavior mangled values containing embedded quotes.
- `yaml-lite.js` `replaceStoryBlock` recognizes any indent greater than the header's indent as block continuation (not hardcoded to 4 spaces) — externally-edited files no longer leave orphaned fields after replace.
- `sync-status.js` EXDEV fallback simplified: on cross-device rename failure, write the content directly to the target (we already hold it in memory). The previous `copyFileSync` path could truncate the target on mid-copy failure.
- `stage-and-commit.js` excludes deleted files from the `git add` loop; they are handled exclusively by the `git rm` pass. Eliminates a spurious "could not add" warning on deletions. `isBinaryFile` is now computed once per file instead of twice.
- `lock.js` stale-takeover retries once if the re-read shows the lock became `FREE` (another process released it between our unlink and our exclusive-create retry). Previously reported `LOCKED` incorrectly.
- `lock.js` `writeLockExclusive` unlinks the partially-created lockfile if `writeSync` fails (ENOSPC, EIO). The previous path left a zero-byte file that future acquirers treated as "corrupt" and could not evict.
- `lock.js` diagnostic IDs (`non-file-lock-path`, `unreadable-lock`, `corrupt-lock`) no longer contain spaces or parentheses, preserving the `STATE:ID:AGE` stdout contract for downstream parsers.
- `markers.js` `findBlock` now requires `BEGIN` and `END` to be on their own line. Plain-text mentions of the marker string inside code blocks or user documentation no longer cause `stripBlock` to delete intervening content.
- `http.js` `postJson` uses a `settled` guard so the Promise resolves or rejects exactly once, eliminating non-deterministic error messages on the size-cap abort path. Also accepts `http://` URLs (for local integration tests) alongside `https://`.
- `create-pr.js` `parseGitRemote` rejects SCP-style inputs that start with `[` (malformed IPv6) or contain a `:` in the path segment (non-standard port form that would otherwise misroute REST calls). Exports `parseGitRemote` and `redactAuth` for direct unit testing.
- `install.js` skill upgrades use a three-phase swap (`copy → rename target→.old → rename .new→target → remove .old`) so the only non-atomic window is a single same-filesystem rename. Any intermediate failure restores the prior skill directory.
- `secrets.js` Google-API-key regex now bounded `[35,99]\b` to reduce false positives on long base64-like blobs that happen to start with `AIza`. `matchesSecret` is exported (and `SECRET_FORMATS`) so external callers can opt into the combined keyword + concrete-format check instead of the legacy keyword-only `SECRET_PATTERN` alias.

### Added (regression tests, round 2)
- `tests/unit/create-pr-helpers.test.ts` — 14 tests for `parseGitRemote` (SSH aliases, GitLab subgroups, IPv6 rejection, `:` in path rejection) and `redactAuth` (Authorization header, Bearer token, API key fields).
- `tests/unit/http.test.ts` — 6 tests against a local `http.createServer` covering 201 success, 302 redirect passthrough, 5 MB body cap, timeout, and malformed URL.
- `tests/unit/spawn.test.ts` — 5 tests including ENOENT cleanup (binary does not exist).
- `tests/unit/install-timestamp.test.ts` — source-level guard that `install.js` uses only `getUTC*` accessors, preventing DST collisions from sneaking back in.
- `tests/unit/bmad-config.test.ts` — added tests for alphabetical module fallback precedence and the "warn loudly on malformed YAML" path.
- `tests/unit/markers.test.ts` — added a regression test that a plain-text mention of `END` inside user notes does NOT corrupt the document.
- `tests/scripts/stage-and-commit.test.ts` — added symlink-skip and 2 MB scan-skip regression tests.

### Fixed (test harness)
- `tests/e2e/harness/temp-project.ts` no longer references the removed `install.sh`. The harness now invokes `node bin/bmad-autopilot-addon.js install` directly via `execFileSync` (no shell). Previously, when `install.sh` was absent the install block was silently skipped, leaving the temp project with no `.claude/skills/` — autopilot slash commands then went unresolved and every session exited at $0.
- `tests/e2e/greenfield.test.ts` sprint-status assertion relaxed from `/status:\s*done/` to `/epic-\d+:\s*done/` to match the actual `development_status:` yaml shape produced by `bmad-sprint-planning`.
- `tests/unit/secrets.test.ts` Stripe fixture now assembled at runtime so the literal `sk_live_*` pattern no longer appears in the source, bypassing GitHub push-protection blocking on obviously synthetic test fixtures.

### Added (scan coverage)
- **C / C++ support in `bmad-ma-codebase-map` scan patterns.** All 5 agents (stack-analyzer, architecture-mapper, integration-mapper, quality-assessor, concerns-hunter) now include `*.c`, `*.h`, `*.cpp`, `*.hpp`, `*.cc`, `*.cxx`, `*.hxx` in their `grep --include` and `find` patterns. Adds C/C++-specific probes: `getenv()`, libcurl/cpprest/boost::beast (HTTP), PQconnectdb/mysql_real_connect/SQLConnect/OCILogon (DB), librdkafka/zmq_ (messaging), Aws::/google::cloud (cloud SDKs), CROW_ROUTE/Pistache:: (web routing), `#include` (module graph), strcpy/strcat/sprintf/gets/system/popen (buffer-overflow risks), `catch(...)` bare handlers, commented-out `struct`/`typedef` blocks. `stack-analyzer` also lists `CMakeLists.txt`, `configure.ac`, `conanfile.txt`, `vcpkg.json`.
- SQL / PL-SQL / XML / shell support in codebase-map scan patterns. All 5 agents include `*.sql`, `*.sps`, `*.spb`, `*.xml`, `*.sh`. PL/SQL-specific probes added: `EXECUTE IMMEDIATE`, `DBMS_SQL`, `DBMS_AQ`, `WHEN OTHERS`, `sqlplus/TNS_ADMIN`, commented-out PL/SQL objects.
- `bmad-ma-*` brownfield analysis and migration skills now list the expected output files in the user-facing prose, so downstream consumers can discover artifact locations without reading the workflow.

### Added (autopilot config)
- **`modules/autopilot/config.yaml`** — new module config exposes `autopilot.session_story_limit` (default 3; `0` disables the limit and runs until the sprint is complete). Replaces the hardcoded `3` in `bmad-autopilot-on/workflow.md`.
- `manifest.yaml` registers the new `autopilot` module alongside `git` and `ma`.
- Workflow prose now states explicitly that the session-story counter only ticks up after the full implementation cycle (dev-story GREEN + code-review + patches + artifacts committed), not after creating a story file — so the autopilot stops **after the Nth story is fully implemented**, not after its file is created.

### Notes
- Minimum Node version bumped to 18 (required by `@clack/prompts`).

## [bmad-autopilot-addon 1.0.20] - 2026-04-16

### Fixed
- Windows: shell wrapper used `exec bash` which resolved to WSL's bash instead of Git Bash, causing `execvpe(/bin/bash) failed` errors. Now uses `$BASH` to stay in the same Git Bash instance the Node.js launcher resolved.
- Windows: Git Bash resolver now finds Git installed via Scoop, Chocolatey, or custom paths by deriving the bash location from `git.exe` in PATH (fallback when standard install directories don't match).

## [bmad-autopilot-addon 1.0.18] - 2026-04-14

### Added
- `/bmad-addon-update` skill — check for updates and install the latest version from within your coding agent
- `check-update` CLI command — check if a newer version is available on npm (`npx bmad-autopilot-addon check-update`)
- Post-install update notice — installer shows a banner when a newer version exists on npm

### Fixed
- `--version` and `check-update` now read from the project's installed manifest, not the npx-cached package

## [bmad-autopilot-addon 1.0.17] - 2026-04-14

### Fixed
- Autopilot state file lost `stories_remaining` and `next_skill` across sessions — all state writes now persist the complete field set
- Autopilot terminated prematurely when `next_skill` was empty despite undone stories — added recovery that re-reads `sprint-status.yaml` and determines the correct next step
- Step 2 recovery now sets `current_story` alongside `next_skill` to prevent mismatched story/skill pairing
- Step 5 recovery heuristic uses `current_bmad_step` instead of test-file presence to correctly distinguish RED/GREEN phase from code-review phase

### Changed
- State file checkpoint (step 9) now uses explicit schema instead of ambiguous "full current state"
- `stories_remaining` list is actively maintained — entries removed as stories complete

## [bmad-autopilot-addon 1.0.16] - 2026-04-14

### Added
- `/ship` and `/publish` project commands (moved from published skills to `.claude/commands/`)

### Fixed
- Install now copies runtime resources (`_bmad-addons/`) to the target project
- Autopilot git recovery for pushed-but-unmerged story branches
- 5 bugs found in adversarial review of git recovery logic
- Partial `sync-status.sh` calls in boot reconciliation and checkpoint sweep
- Pre-existing test: added `.gitignore` to prevent stderr in SHA check

### Changed
- Added tests for `--merge-status` flag in `sync-status.sh`

## [bmad-autopilot-addon 1.0.13] - 2026-04-08

### Fixed
- Windows: launcher now explicitly prefers Git Bash over WSL's bash, which cannot resolve `C:/...` paths and broke `npx bmad-autopilot-addon` when both were installed.

## [bmad-autopilot-addon 1.0.12] - 2026-04-08

### Fixed
- Windows: `npx bmad-autopilot-addon` failed because Git Bash interpreted backslashes in the launcher script path as escapes. Path is now normalized to forward slashes.

## [bmad-autopilot-addon 1.0.11] - 2026-04-04

### Fixed
- npm website showing stale README (re-publish with updated metadata)

## [bmad-autopilot-addon 1.0.10] - 2026-04-03

### Added
- Automated npm publishing via GitHub Actions trusted publishers (OIDC, no tokens needed)
- Provenance attestation on published packages
- Shields.io badges in README (npm version, downloads, license, BMAD compat, Node.js, tools, stars)
- Add-on skills table and configuration section in README
- `/ship` and `/release` project skills for streamlined workflows

### Changed
- Removed BMAD standard TEA skills table from README (belongs in BMAD docs, not add-on)

### Fixed
- GitHub Actions publish workflow: Node 24 for npm 11.5.1+ OIDC support, removed `registry-url` that conflicted with trusted publishing

## [bmad-autopilot-addon 1.0.7] - 2026-04-03

### Fixed
- Bin script symlink resolution for npx compatibility
- npm 11 bin path validation (removed `./` prefix)
- Node.js wrapper for bin entry to pass npm publish validation
- Synced manifest.yaml version with package.json

### Added
- **npx installation** — `npx bmad-autopilot-addon` replaces manual `bash _bmad-addons/install.sh`
- Post-install output with usage guide, configuration reference, and skill descriptions
- License and author info in post-install output
- Package keywords (orchestrator, gemini)

### Changed
- Updated all documentation to reference `npx bmad-autopilot-addon` installation method

## [bmad-autopilot-addon 1.0.0] - 2026-03-29

### Added

#### Multi-Agent Skills (7 new skills, 19 subagent prompts)

- **bmad-ma-code-review** — Parallel 3-layer code review
  - Blind Hunter (adversarial, diff-only)
  - Edge Case Hunter (boundary conditions, full project access)
  - Acceptance Auditor (AC verification)
  - Triage with deduplication and contradiction handling

- **bmad-ma-codebase-map** — 5-stream parallel codebase analysis
  - Stack Analyzer, Architecture Mapper, Quality Assessor
  - Concerns Hunter, Integration Mapper
  - Outputs to `_bmad-output/codebase-analysis/`

- **bmad-ma-assess** — Tech debt and migration assessment
  - Dependency Auditor (CVEs, outdated packages)
  - Debt Classifier (prioritized with effort estimates)
  - Migration Analyzer (upgrade paths and roadmap)
  - Produces `brownfield-assessment.md`

- **bmad-ma-reverse-architect** — Bottom-up architecture extraction
  - Component Mapper, Data Flow Tracer, Pattern Extractor
  - Produces BMAD-compatible `architecture.md`

- **bmad-ma-migrate** — 12-step migration planning
  - 4 subagent fan-outs (Stack Mapper, Dependency Analyzer, Test Parity, Risk Assessor)
  - Templates: migration plan, epics, component cards
  - Resources: strategy reference, coexistence patterns
  - Produces `migration-plan.md`, `migration-epics.md`, `migration-tracking.yaml`

- **bmad-ma-research** — Parallel research fan-out with WebSearch/WebFetch

- **bmad-ma-party-mode** — Real parallel multi-persona discussions

#### Git Workflow Integration
- Enhanced `bmad-autopilot-on` with git operations between skill invocations
- Enhanced `bmad-autopilot-off` with git status report and lock release
- Worktree isolation via `EnterWorktree`/`ExitWorktree`
- Sprint-status.yaml sync from worktree to project root
- Git status separated from sprint-status.yaml — addon writes git metadata
  (branch, commit, PR URL, push status, lint result) to its own `git-status.yaml`

#### Helper Scripts (8)
- `detect-platform.sh` — GitHub/GitLab/Bitbucket/Gitea auto-detection
- `sanitize-branch.sh` — Story key to valid branch name
- `lock.sh` — Session lock (epoch + UUID, 30m stale timeout)
- `stage-and-commit.sh` — Explicit staging with pre-commit checks, binary file detection, `--file-list` cross-reference, `.gitignore` coverage verification
- `sync-status.sh` — Simple YAML write to `git-status.yaml`
- `lint-changed.sh` — Language-aware linting of changed files, multi-language monorepo support
- `health-check.sh` — Orphaned worktree classification with `git fetch` before commit comparison
- `create-pr.sh` — PR/MR creation with remote existence pre-check and graceful fallback

#### Platform Support
- GitHub (`gh` CLI)
- GitLab (`glab` CLI)
- Bitbucket (`bb` CLI + REST API fallback with `BITBUCKET_TOKEN`)
- Gitea (`tea` CLI + REST API fallback with `GITEA_TOKEN` + `base_url`)

#### Linting — 16 Languages
- JavaScript/TypeScript (eslint, biome)
- Python (ruff, flake8, pylint)
- Go (golangci-lint, go vet)
- Rust (clippy)
- Ruby (rubocop)
- Java (checkstyle, pmd)
- C/C++ (cppcheck, clang-tidy)
- C# (dotnet format)
- Swift (swiftlint)
- PL/SQL (sqlfluff — Oracle, PostgreSQL, MySQL, T-SQL dialects)
- Kotlin (ktlint, detekt)
- PHP (phpstan, phpcs)

#### Configuration
- Git workflow config (`modules/git/config.yaml`)
- Platform commands (`modules/git/platform.yaml`)
- Commit and PR templates
- Secrets allowlist

#### System Prompt Enforcement
- `BMAD.md` in `_bmad-addons/`: comprehensive skill reference by lifecycle phase
- `templates/agent-rules.md`: self-sufficient enforcement block with `<!-- BEGIN/END -->` markers
- Installer creates per-tool system prompt files:
  - Claude Code: `CLAUDE.md` + `AGENTS.md` (via `@include`)
  - Cursor/Roo/Kiro/Trae: dedicated `bmad.md` in rules directory
  - Windsurf/Cline/Gemini CLI/Copilot: marker-based append to shared rules file
- Marker-based idempotent updates (re-run install safely, user content preserved)
- Uninstaller surgically removes BMAD blocks only

#### Windows Compatibility
- `sanitize-branch.sh`: `sha256sum` before `shasum` fallback
- `stage-and-commit.sh`: `wc -c` fallback for `stat`, guard `file` command
- All scripts work on macOS, Linux, and Git Bash/WSL

#### Infrastructure
- `install.sh` with `--dry-run`, `--force`, backup with retention
- `uninstall.sh` with dirty-check worktree cleanup
- `manifest.yaml` with BMAD compatibility tracking
- 9 supported tools (Claude Code, Cursor, Windsurf, Cline, Roo, Trae, Kiro, GitHub Copilot, Gemini CLI)

#### Documentation
- README.md with quick start and skill overview
- Installation guide, usage guide, architecture docs
- Configuration reference, contributing guide
- Guide for adding new platforms and language linters
- GSD attribution for `bmad-ma-codebase-map` inspiration
