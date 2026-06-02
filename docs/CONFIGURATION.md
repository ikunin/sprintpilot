# Configuration Reference

All configuration lives in `_Sprintpilot/modules/`. Changes take effect on the next `/sprint-autopilot-on` invocation.

## Autopilot Configuration (`modules/autopilot/config.yaml`)

### Complexity Profile (v2)

| Key | Default | Description |
|-----|---------|-------------|
| `complexity_profile` | `medium` | One of `nano`, `small`, `medium`, `large`, `legacy`. Selects the per-story flow + which v2 layers are enabled. Missing key falls back to `medium` with a stderr notice. |

Profile resolution happens at boot via `_Sprintpilot/scripts/resolve-profile.js`. Profile YAMLs live in `_Sprintpilot/modules/autopilot/profiles/` (`_base.yaml` shared by nano/small/medium/large; `legacy.yaml` stands alone with `version_pinned: "v1.0.5"`).

| Profile | Per-story flow | Branching | Worktrees | Parallel stories |
|---------|---------------|-----------|-----------|------------------|
| `nano` | `bmad-quick-dev` (one-shot) | `epic` | off | n/a |
| `small` | Full 7-step BMad cycle | `story` | on | off |
| `medium` *(default)* | Full 7-step BMad cycle | `story` | on | off |
| `large` | Full 7-step BMad cycle | `story` | on | on |
| `legacy` | v1.0.5 byte-for-byte | `story` | on | off |

### Session & Retrospective

| Key | Default | Description |
|-----|---------|-------------|
| `autopilot.session_story_limit` | `3` (nano: `5`; large/legacy: `3`) | Stories per session before checkpoint. `0` = unlimited. Retuned in 2.0.1 after context-rot exposure. |
| `autopilot.retrospective_mode` | `auto` | `auto` (deterministic artifact, continue) / `stop` (pause for `/bmad-retrospective`) / `skip` (no artifact). |
| `autopilot.implementation_flow` | `full` (nano: `quick`) | `full` runs the 7-step BMad cycle (create-story → check-readiness → dev-RED → dev-GREEN → code-review → patch → retrospective). `quick` routes every story through `bmad-quick-dev` and boots fresh sessions directly at `NANO_QUICK_DEV`. |

### Per-phase wall-clock budgets (v2.4.0)

| Key | Default | Description |
|-----|---------|-------------|
| `autopilot.phase_timeout_minutes` | profile-scaled (see below) | Map of phase → minutes. The state machine stamps `state.phase_started_at` on every phase advance and halts cleanly with `reason: 'phase_timeout_exceeded'` when the active phase has been running longer than its budget. Catches silent multi-hour DEV_GREEN hangs. |

Profile defaults:

| Profile | dev_red | dev_green | code_review | patch_apply | patch_retest | nano_quick_dev | create_story | check_readiness |
|---|---|---|---|---|---|---|---|---|
| `nano` | — | — | — | — | — | 15 | 5 | 5 |
| `small` | 10 | 20 | 10 | 10 | 10 | — | 5 | 5 |
| `medium` | 15 | 30 | 15 | 15 | 15 | — | 5 | 5 |
| `large` | 30 | 60 | 30 | 30 | 30 | — | 10 | 10 |
| `legacy` | disabled (preserves v1.0.5 behavior) |

Overrides:
```yaml
autopilot:
  phase_timeout_minutes: null              # disable all timeouts
  # or
  phase_timeout_minutes:
    dev_green: 45                          # raise one phase budget
    dev_red: null                          # disable one phase
```

The halts are recoverable `user_prompt`s — the next session resumes from the same phase, and the LLM can be re-prompted with the auto-attached context (see "Self-explaining halts" below).

### Self-explaining halts (v2.4.0)

No configuration knobs. Every `user_prompt` action emitted by the orchestrator now carries a `context` object:

```json
{
  "type": "user_prompt",
  "reason": "verify_reject_budget_exceeded",
  "prompt": "...",
  "context": {
    "recent_actions": [{ "seq": 42, "phase": "dev_green", "skill": "bmad-dev-story" }, ...],
    "verifier_check": { "issues": [...], "exit_code": 1, "command": "..." },
    "elapsed_in_phase": { "phase": "dev_green", "minutes": 27.4 },
    "similar_halt": { "seq": 18, "ts": "...", "phase": "dev_green", "reason": "..." }
  }
}
```

`verifier_check` is only populated when the halt reason is verify-related. `similar_halt` is null when no prior matching halt exists outside the current session.

### Background full-suite runner (v2.4.0)

| Key | Default | Description |
|-----|---------|-------------|
| `testing.full_suite_on_story_land` | `ci` | `ci` (no-op; CI gates STORY_LAND) / `background` (detached worker after STORY_DONE; result gates next session's `autopilot start`) / `skip` (no full-suite gate). |

Sidecars live at `_bmad-output/implementation-artifacts/.background-suite/<story_key>.json` with a sibling `.log` file capturing stdout/stderr. CLI escape hatch: `autopilot start --ack-background-suite` skips the failure halt and acknowledges the latest sidecar.

### Flaky-test quarantine (v2.4.0)

No configuration knobs (threshold defaults to 3 flips across stories). Persistence at `_bmad-output/implementation-artifacts/flaky-quarantine.yaml`.

CLI:
- `autopilot quarantine list` — show quarantined tests + flip counters
- `autopilot quarantine add <test_id>` — manual quarantine
- `autopilot quarantine eject <test_id>` — manual removal

Auto-quarantine triggers when a `dev-story` / `quick-dev` signal carries `output.flaky_tests: [test_id, ...]` and the 3rd flip is recorded for a given test ID. Each newly-quarantined test gets an audit entry in `_bmad-output/implementation-artifacts/decision-log.yaml`. The scope resolver threads the quarantine list through the adapter (`vitest --exclude`, `jest --testPathIgnorePatterns`, `pytest --ignore=` / `--deselect`) so the recommended command skips them automatically.

### Change-size-scaled review depth (v2.4.1)

No configuration knobs. The orchestrator's `decorateReviewDepth` runs `git diff --numstat` + `git diff --name-status` against the base branch on every CODE_REVIEW emission, classifies the change, and threads slots into `bmad-code-review`:

| Slot | Type | Description |
|---|---|---|
| `review_depth` | `'trivial' \| 'normal' \| 'structural'` | The classification. |
| `recommended_reviewer_count` | int | 1 / 3 / 3 respectively. |
| `recommended_review_layers` | string[] | `['blind_hunter']` / `[blind, edge, auditor]`. |
| `extended_edge_case_hunter` | boolean | `true` for structural. |
| `review_depth_notes` | string | Human-readable explanation. |
| `change_size_summary` | object | `{ size, loc_added, loc_removed, files_touched, reason, structural_signals }`. |

Triggers for `structural`: any dep manifest with a version-pinning edit, any file under `migrations/`, `schema/`, `*.sql`, or `prisma/schema.prisma`, any `index.{js,jsx,ts,tsx,mjs,cjs}` (barrel), any `git diff` rename row, >500 total LOC, or >20 files. Trivial gates: ≤2 files AND ≤10 LOC AND no structural signals. Otherwise normal.

Audit trail: every emission writes a `review_depth_decision` entry to the ledger with the full classification.

### Diagnostic mode on consecutive failures (v2.4.1)

No configuration knobs. When a test phase (DEV_RED / DEV_GREEN / PATCH_APPLY / PATCH_RETEST / NANO_QUICK_DEV) is one failure away from `user_prompt` escalation, the orchestrator inserts a verbose-flag observation pass before giving up:

1. Attempt 1 fails → retry with `prior_diagnosis`.
2. Attempt 2 fails → retry budget would exhaust → orchestrator sets `state.diagnostic_pending = true` and re-emits the same phase.
3. Attempt 3 (diagnostic) sees `template_slots.diagnostic_mode = true` and `recommended_test_command` carrying adapter-specific verbose flags (`--reporter=verbose` / `--verbose` / `-v --tb=long`). The LLM runs it and returns the trace as `output.diagnostic_trace`.
4. Orchestrator stores the trace, escalates to `user_prompt` with `reason: 'retry_budget_exhausted_with_diagnostic'` and `diagnosis: <trace>`.

Skip conditions: non-test phases, non-recoverable failures (`signal.recoverable === false`), already-completed-this-phase (`state.diagnostic_completed`). One-shot per phase entry — phase advance clears the diagnostic state.

### V2 Optimization Layers

Every layer can be disabled in isolation. `legacy` profile pins all of these to `false` for v1.0.5 byte-for-byte behavior.

| Key | Default | Description |
|-----|---------|-------------|
| `autopilot.phase_timings` | `true` (legacy: `false`) | Emit `duration` records via `log-timing.js mark`. Mark is a single-call replacement for start/end pairs — missed bracket calls are impossible because there are no brackets. Three deterministic scripts auto-emit on success: `mark-done-stories-tasks.js`, `infer-dependencies.js write`, `inject-tasks-section.js`. |
| `autopilot.coalesce_state_writes` | `true` (legacy: `false`) | Buffer non-critical state in `.pending/<kind>/<story>.yaml`; flushed atomically at story boundary + session checkpoint + sprint complete. Crash-recovery keys (`current_story`, `current_bmad_step`, `in_worktree`, `patch_commits`) bypass the buffer. |
| `autopilot.conditional_boot_work` | `true` (large/legacy: `false`) | Skip health-check + branch reconciliation on a clean repo (main worktree only, no in-progress stories). Saves 8–30s per session. |
| `autopilot.cache_shared_reads` | `true` (legacy: `false`) | TTL + source-mtime aware file cache (`_Sprintpilot/scripts/cached-read.js`). Any writer's mtime advance forces a miss. |
| `autopilot.auto_infer_dependencies` | `false` (was `true` pre-v2.3.0) | **Legacy flag — superseded by `auto_plan_on_start` in v2.3.0.** Pre-v2.3.0 this triggered automatic LLM dependency inference writing to `_Sprintpilot/sprints/dependencies.yaml`. Now defaulted off across all profiles; the v2.3.0 plan-aware workflow takes its place. Existing projects with `auto_infer_dependencies: true` in their local config can leave it alone — auto-migration on first v2.3.0 `autopilot start` converts the legacy sidecar to `sprint-plan.yaml` once and archives the original. |
| `autopilot.auto_plan_on_start` | `false` (all profiles) | **v2.3.0** — when `true`, `autopilot start` emits `invoke_skill: sprintpilot-plan-sprint` on greenfield projects (no `sprint-plan.yaml`) so the LLM session builds a plan automatically. Default `false`: missing plan → fall back to sprint-status execution order (existing behavior). Once a plan exists, staleness is detected and re-derive runs automatically regardless of this knob — the opt-in only affects net-new projects. See `docs/USAGE.md#sprint-planning--dag-aware-execution-v230` for the full plan-aware workflow. |

### Profile Files

The profile system uses base + overlay (DRY). Files live in `_Sprintpilot/modules/autopilot/profiles/`:

- `_base.yaml` — shared defaults (inherited by nano, small, medium, large)
- `nano.yaml` — overrides for the quick-dev flow + epic granularity
- `small.yaml` / `medium.yaml` — minimal overlays
- `large.yaml` — enables `parallel_stories: true`, `state_sharding: always`, etc.
- `legacy.yaml` — standalone (no inheritance), `version_pinned: "v1.0.5"`

Re-run `sprintpilot install --profile <name>` to switch profiles non-destructively (your config values are preserved).

### Sprint Planning Artifacts (v2.3.0)

| Artifact | Path | Owner | Notes |
|---|---|---|---|
| Sprint plan | `_bmad-output/implementation-artifacts/sprint-plan.yaml` | Sprintpilot | Authoritative for queue order + dependencies + per-story plan_status. Atomic writes via `sprint-plan.js`. |
| Rendered DAG | `_bmad-output/implementation-artifacts/sprint-plan-dag.mmd` | Sprintpilot | Mermaid by default. Refreshed on every plan write. Optional graphviz output via `resolve-dag.js render --format graphviz`. |
| Plan lock | `.sprintpilot/plan.lock` | Sprintpilot | **Required for all sprint-plan.yaml writes.** Acquired by `mutate()`, `archive()`, and `refreshBmadStatus()` in `sprint-plan.js`. 5-min stale timeout (crashed sessions self-recover); 30-second acquire timeout (concurrent contention surfaces as `lock_timeout` error). Same `lock.js` primitive as `.merge-shards.lock` and submodule locks. Safe to `rm` manually if a session terminated abnormally. |
| Plan archive | `.archive/sprint-plan-<plan_id>.yaml` | Sprintpilot | Written on plan exhaustion. Live file deleted; next session sees no plan. |
| Legacy archive | `.archive/dependencies.yaml.migrated` | Sprintpilot | One-shot move of pre-v2.3.0 `_Sprintpilot/sprints/dependencies.yaml`. |

### Git tracking policy for `_bmad-output/`

`_bmad-output/` mixes two very different kinds of files. **Specs** (versioned, reviewable, team-shared) belong in git; **runtime artifacts** (per-session, machine-generated, high-churn) do not. Mixing the two — particularly tracking the append-only `ledger.jsonl` — causes two real problems:

1. **No semantic merge.** `ledger.jsonl` sequence numbers (`seq=N`) are local-monotonic. Two teammates running the autopilot on different branches both write `seq=N+1, N+2, ...`. Git produces conflict markers or an interleaved file that breaks `nextSeq()` (which reads the last line), `lastWithFingerprint()`, `readSince(afterSeq)`, and the v2.5.0 `autopilot watch` tail iterator.
2. **Inode churn breaks `tail -F` monitors.** Every `git checkout` / `git merge` / `git pull` that touches a tracked file rewrites the working-tree copy with a new inode. `tail -F` interprets this as log rotation and re-emits the file from byte 0 — flooding any monitoring pipe (your terminal, a CI dashboard, a `tail | grep` filter) with the entire ledger replayed.

**Track in git (specs — team needs these):**

| Artifact | Why tracked |
|---|---|
| `stories/*.md` | Story specs with AC, BMad context, reviewers' notes |
| `implementation-artifacts/sprint-plan.yaml` | Agreed DAG / queue order |
| `implementation-artifacts/sprint-status.yaml` | Story progress, who shipped what |
| `implementation-artifacts/sprint-tasks.md` | Human task board (mirrored to coding-agent TODOs) |
| `implementation-artifacts/decision-log.yaml` | Architectural decisions (audit + onboarding gold) |
| `implementation-artifacts/<story-key>.md` | Per-story readiness reports |
| `implementation-artifacts/sprint-plan-dag.mmd` | Rendered DAG (GitHub-renderable mermaid) |
| `retrospectives/*.md` | Epic retro notes + sprint-health metrics block |
| `reviews/*.md` | Code review findings per story |
| `planning-artifacts/*.md` | Planning-skill outputs |

**Don't track (runtime — per-session, regenerated locally):**

| Artifact | Why not |
|---|---|
| `implementation-artifacts/ledger.jsonl` | Sequence-number merge conflict + inode-churn replay (see above). Reconciliation works fine without it; teammates don't need each other's per-action audit tape. |
| `implementation-artifacts/autopilot-state.yaml` | Carries `current_story`, `phase_started_at`, `lock_session_id` — per-machine runtime, meaningless on another machine. |
| `implementation-artifacts/.timings/*.jsonl` | Per-skill duration shards, very high churn, only useful for local profiling. |
| `implementation-artifacts/.land-snapshots/` | Land-as-you-go workflow scratch state. |
| `implementation-artifacts/.autopilot-state/` | State-store coalesce-buffer shards (mirror of `autopilot-state.yaml`). |
| `implementation-artifacts/.background-suite/` | Per-story sidecar JSON + log from `background-suite-worker.js`. |
| `.autopilot.lock` | Per-session lock file. |
| `.worktrees/` | Per-story worktrees from `git worktree add`. |

**Recommended `.gitignore` block** (apply to any Sprintpilot-driven project):

```gitignore
# Sprintpilot runtime artifacts (per-session, regenerated each run)
_bmad-output/implementation-artifacts/ledger.jsonl
_bmad-output/implementation-artifacts/autopilot-state.yaml
_bmad-output/implementation-artifacts/.autopilot-state/
_bmad-output/implementation-artifacts/.timings/
_bmad-output/implementation-artifacts/.land-snapshots/
_bmad-output/implementation-artifacts/.background-suite/
.autopilot.lock
.worktrees/
```

**Untracking an already-tracked file** (e.g., a project installed before v2.5.x where the installer didn't yet include the runtime-artifact rules):

```bash
git rm --cached _bmad-output/implementation-artifacts/ledger.jsonl
# add the gitignore entry, then commit. The working-tree file stays on
# disk for the local autopilot to keep appending to.
```

**Team workflow stays clean:** Alice runs autopilot, finishes a story, commits — her commit updates the spec artifacts (sprint-status, decision-log, story file, review file). Bob pulls main, sees what shipped and why via the **tracked** files, runs the next story without inheriting Alice's per-action ledger noise. Cross-machine resume still works because `autopilot-state.yaml` is per-machine — each person's autopilot remembers its own current_story/phase locally.

### Concurrent execution semantics

Sprintpilot v2.3.0 supports concurrent autopilot sessions on the same project — they serialize their sprint-plan.yaml writes via `.sprintpilot/plan.lock`.

| Scenario | Behavior |
|---|---|
| Two `autopilot start` invocations on the same project | Both acquire `.autopilot.lock` first (one wins, other halts with `autopilot_lock_held`). Plan-aware steps inside the winner's cmdStart serialize via `.sprintpilot/plan.lock`. |
| `autopilot record` while `/sprintpilot-plan-sprint` is running | The skill holds plan.lock for its duration; record's `markDone` waits up to 30s. If the skill takes longer, record errors with `lock_timeout` and the user retries. |
| Manual edit of sprint-plan.yaml during an autopilot session | The session reads the current state on its next cmdStart; mid-flight edits aren't atomic against an in-flight `markDone` and may be partially overwritten. **Recommendation**: pause the session before hand-editing. |
| Session killed (`kill -9`) mid-mutate | `.sprintpilot/plan.lock` becomes stale after 5 minutes; next session takes over via the `ACQUIRED_STALE` path in `lock.js`. Disk-layer atomicity (tmp+rename) means the file is never in a torn state. |
| Concurrent `sprint-plan.js read` (read-only) | No lock acquired; readers see whatever the most recently completed atomic write produced. Stale reads possible during a write but never corrupt reads. |

### Verify-loop state persistence

The verify-loop detection (Phase 4.5 + Round 2 hardening) tracks two state fields:

| Field | Type | Persistence |
|---|---|---|
| `last_verify_issues_signature` | string \| null | CRITICAL_KEYS — write-through, survives crashes |
| `consecutive_identical_rejections` | integer | CRITICAL_KEYS — write-through, survives crashes |

These persist in both `_Sprintpilot/lib/orchestrator/state-store.js` (in-memory write coalescer) and `_Sprintpilot/scripts/state-shard.js` (file-level shard writer). A SIGKILL between two identical verify rejections does NOT reset the loop counter — the next session's first verify rejection picks up where the prior one left off, and the loop-detection halt prompt fires as if the crash never happened.

### CLI Flags (v2.3.0)

| Flag | Subcommand | Effect |
|---|---|---|
| `--no-auto-plan` | `start` | Suppresses the auto-derive trigger for this one invocation. Useful when a plan is stale but you want to run sprint-status order this session and re-plan later. |
| `--json` | `progress` | Machine-readable JSON output (for IDE extensions / dashboards). Carries `next_summary` (the authoritative "what runs next" line, same as the `start`/`next`/`record` envelopes), `issue_tracker`, `current_issue_id`, `issue_tracking` (coverage stats: `{provider, project_key, base_url, total, linked, coverage}`), and per-`recent_events[].issue_id` when set. Null when no `sprint-plan.yaml` issue_tracker block is configured. |
| `--once` | `progress` | Single snapshot to stdout (default mode — flag is for forward compatibility with a future `--watch` mode). |
| `--story <key>` | `progress` | Narrow output to a single story's plan entry. Renders a labeled detail block including `Issue ID:` (or `(not set)`). Falls back to `plan.stories[<key>].current_step` when no autopilot session is currently running. |
| `--format mermaid\|graphviz` | `resolve-dag render` | Render format. Mermaid (default) is GitHub-renderable with no system deps. Graphviz requires `dot` in PATH — falls back to mermaid with a stderr notice if missing. |
| `--output <path>` | `resolve-dag render` | Custom output path. Default: `_bmad-output/implementation-artifacts/sprint-plan-dag.{mmd,dot}`. |
| `--cross-epic` | `infer-dependencies scaffold-prompt`, `dry-run` | Switches to the cross-epic detection prompt (separate from per-epic inference). |

## Git Configuration (`modules/git/config.yaml`)

### Core Settings

| Key | Default | Description |
|-----|---------|-------------|
| `git.enabled` | `true` | Master switch. `false` disables all git operations. |
| `git.base_branch` | `main` | Base branch for worktrees and PRs. |
| `git.branch_prefix` | `story/` | Prefix for story branches (e.g., `story/1-3-add-auth`). |
| `git.max_branch_length` | `60` | Max chars before truncation + 6-char hash suffix. |

### Commit Templates

| Key | Default | Placeholders |
|-----|---------|-------------|
| `commit_templates.story` | `feat({epic}): {story-title} ({story-key})` | `{epic}`, `{story-title}`, `{story-key}` |
| `commit_templates.patch` | `fix({story-key}): {patch-title}` | `{story-key}`, `{patch-title}` |

Placeholder resolution chain: sprint-status.yaml → story file → fallback value.

### Staging

| Key | Default | Description |
|-----|---------|-------------|
| `staging.strategy` | `explicit` | Always explicit file names. Cannot be changed to `git add -A`. |
| `staging.source` | `git-diff-primary` | Primary source: `git diff --name-only HEAD` |
| `staging.cross_reference` | `story-file-list` | Cross-reference changed files against the story's "File List" section. Warns on unexpected files (changed but not in File List) and missing files (in File List but not changed). |
| `staging.max_file_size_mb` | `1` | Reject files larger than this with warning |

### Pre-Commit Checks

| Check | Behavior |
|-------|----------|
| `verify_no_secrets` | Grep for API_KEY, SECRET, TOKEN, PASSWORD, aws_access, private_key. WARN severity. |
| `verify_gitignore_covers_addon` | Verify .gitignore has .autopilot.lock and .claude/.sprintpilot-backups/ |
| `verify_file_size` | Reject files > `max_file_size_mb` |
| `verify_no_binaries` | Warn on binary files detected via `file --mime-encoding` |

### Secrets Scanning

| Key | Default | Description |
|-----|---------|-------------|
| `secrets_scan.patterns` | `[API_KEY, SECRET, TOKEN, ...]` | Patterns to search for |
| `secrets_scan.severity` | `WARN` | WARN = surface and continue. Does not block commit. |
| `secrets_scan.allowlist_file` | `.secrets-allowlist` | File with glob patterns exempt from scanning |

### Linting

| Key | Default | Description |
|-----|---------|-------------|
| `lint.enabled` | `true` | Enable/disable linting |
| `lint.auto_detect` | `true` | Detect language from manifest files |
| `lint.scope` | `changed-files` | Only lint files changed in the story |
| `lint.blocking` | `false` | Lint findings never halt the autopilot |
| `lint.output_limit` | `100` | Max lines injected into context |
| `lint.output_strategy` | `errors-first` | Show errors before warnings |
| `lint.full_output_file` | `true` | Save full output to file |
| `lint.linters.<language>` | (defaults below) | Per-language linter preference. Ordered list; first installed wins. Empty list disables linting for that language. `javascript` and `typescript` keys merge into a single `js-ts` bucket (both share eslint/biome tooling). |

The lint pipeline (`scripts/post-green-gates.js`) runs after `dev_green` verify passes when `lint.enabled: true`. It composes three gates: `lint-changed.js` (per-language linter), `lint-test-pitfalls.js` (LLM-test smell scan), and `scan.js` (CI-only failure pattern scan). `lint.blocking: true` rejects verify on any failed gate; `false` records the failure but doesn't gate the autopilot.

Default linter preferences:

| Language | Linters (first found wins) |
|----------|---------------------------|
| Python | ruff, flake8, pylint |
| JavaScript/TypeScript | eslint, biome |
| Rust | cargo clippy |
| Go | golangci-lint |
| Ruby | rubocop |
| Java | checkstyle, pmd |
| C/C++ | cppcheck, clang-tidy |
| C# | dotnet format |
| Swift | swiftlint |
| PL/SQL | sqlfluff |
| Kotlin | ktlint, detekt |
| PHP | phpstan, phpcs |

Override example:

```yaml
git:
  lint:
    linters:
      python: [pylint]       # skip ruff/flake8, always use pylint
      typescript: [biome]    # prefer biome over eslint
      go: []                 # disable go linting entirely
```

See [Extending](EXTENDING.md) to add more languages.

### Push & PR

| Key | Default | Description |
|-----|---------|-------------|
| `push.auto` | `true` | Auto-push after commit |
| `push.create_pr` | `true` | Auto-create PR/MR after push |
| `push.pr_body` | `heredoc` | Use shell HEREDOC for PR body |

### Merge

| Key | Default | Description |
|-----|---------|-------------|
| `merge.timing` | `epic-retrospective` | Suggest merge after epic retrospective |
| `merge.require_user_confirm` | `true` | Always ask before merging |
| `git.reuse_user_branch` | `false` | When `true`, autopilot detects the current non-base branch on boot and commits **every** story onto it. No per-story / per-epic branches are created; one PR opens at sprint-end. Suppresses `git.granularity`. |
| `git.merge_strategy` | `stacked` | `stacked` keeps every story branch open until sprint-end. `land_as_you_go` runs a `STORY_LAND` state after `STORY_DONE` to merge the PR immediately. |
| `git.land_when` | `ci_pass` | Under `land_as_you_go`: `no_wait` (sync merge), `ci_pass` (after CI green), or `ci_and_review` (after CI + approved review). |
| `git.land_wait_minutes` | `30` | Max wait for CI / review under `land_as_you_go`. After this the orchestrator halts and prompts. |

Under `land_as_you_go`, the orchestrator verifies the merge (`STORY_LAND` requires `git_steps_completed: true` or a confirmed `git merge-base --is-ancestor <commit_sha> origin/<base>`) and refuses to start a new story while the previous one is unlanded — auto-recovering by rewinding to the predecessor's missing `STORY_DONE` / `STORY_LAND` phase. See USAGE.md → "Land-completion guard + auto-recovery". Scoped to per-story branches (`reuse_user_branch: false`).

### Worktree

| Key | Default | Description |
|-----|---------|-------------|
| `worktree.submodule_init` | `auto` | `auto` = only if `.gitmodules` exists |
| `worktree.submodule_timeout` | `30` | Seconds before timeout on submodule init |
| `worktree.cleanup_on_merge` | `true` | Remove worktree after story is merged |
| `worktree.health_check_on_boot` | `true` | Check for orphaned worktrees at startup |

### Lock File

| Key | Default | Description |
|-----|---------|-------------|
| `lock.enabled` | `true` | Prevent concurrent autopilot sessions |
| `lock.file` | `.autopilot.lock` | Lock file path (in project root) |
| `lock.stale_timeout_minutes` | `30` | Auto-take-over locks older than this. `0` disables auto-takeover entirely (locks are never considered stale; manual `/sprint-autopilot-off` required to release). |

### Platform Detection

| Key | Default | Description |
|-----|---------|-------------|
| `platform.provider` | `auto` | `auto`, `github`, `gitlab`, `bitbucket`, `gitea`, or `git_only` |

Auto-detection priority: explicit config > CLI detection > remote URL regex.

For self-hosted instances:
```yaml
platform:
  provider: gitea
  base_url: https://git.example.com
```

### Authentication Tokens

Platforms with API fallback require environment variables when their CLI is not installed:

| Platform | Env Var | Required When |
|----------|---------|---------------|
| Bitbucket | `BITBUCKET_TOKEN` | `bb` CLI not installed |
| Gitea | `GITEA_TOKEN` | `tea` CLI not installed (also needs `base_url` in config) |

GitHub and GitLab require their CLIs (`gh`, `glab`). No API fallback is available.

## Multi-Agent Configuration (`modules/ma/config.yaml`)

| Key | Default | Description |
|-----|---------|-------------|
| `multi_agent.enabled` | `true` | Enable multi-agent skills |
| `multi_agent.max_parallel_review_layers` | `3` | Always 3 (blind, edge-case, acceptance) |
| `multi_agent.max_parallel_research` | `3` | Max concurrent research agents per batch |
| `multi_agent.max_parallel_analysis` | `5` | Max concurrent codebase analysis agents |

### V2 Parallelism & Sharding

| Key | Default | Description |
|-----|---------|-------------|
| `ma.state_sharding` | `auto` (large: `always`; legacy: `never`) | `auto` / `always` / `never`. Per-story state shards live under `.autopilot-state/<story>.yaml` and `.decision-log/<story>.yaml`; merged into the project YAMLs by `merge-shards.js`. |
| `ma.parallel_stories` | `false` (large: `true`) | Dispatch independent stories from a DAG layer concurrently. Requires Claude Code (or Gemini CLI w/ `experimental_parallel_on_gemini: true`). |
| `ma.max_parallel_stories` | `2` (large: `3`) | Cap on concurrent stories per layer. |
| `ma.experimental_parallel_on_gemini` | `false` | Opt-in parallel dispatch under Gemini CLI. Worktree-scoped subagents are still upstream (`gemini-cli#22967`) — at-your-own-risk. |
| `ma.parallel_epics` | `false` | EXPERIMENTAL — cross-epic parallelism with merge-conflict preflight. Off on every profile by default. |
| `ma.min_epic_duration_for_parallel_sec` | `300` | Don't bother spinning up parallel infrastructure if the epic is shorter than this. |
| `ma.baseline_story_duration_sec` | `180` | Used to estimate epic duration for the gate above. |
| `ma.max_consecutive_conflicts` | `2` | After this many consecutive merge conflicts mid-session, parallel dispatch flips a session-scoped disable flag. |
| `ma.effective_parallel_floor` | `1` | Don't engage parallel dispatch unless at least this many stories run in parallel. The orchestrator independently short-circuits on `active_layer.length < 2`, so this floor is a defensive backstop. |

## Tiered Testing Configuration (`modules/testing/config.yaml`)

Per-phase test scope. Defaults to **affected-only** in the inner loop (`DEV_RED` / `DEV_GREEN` / `PATCH_APPLY` / `PATCH_RETEST` / `NANO_QUICK_DEV`); CI remains the full-regression safety net via `gh pr checks` on `STORY_LAND` under `merge_strategy: land_as_you_go`. The autopilot computes the recommended test command per emission using a framework adapter (`vitest --changed`, `jest --findRelatedTests`, `pytest --testmon`) and threads it into the dev-story template via `recommended_test_command`.

| Key | Default | Description |
|-----|---------|-------------|
| `testing.scope` | `affected` (legacy: `full`) | Per-phase test scope. `affected` uses the framework adapter to derive a change-aware command. `full` runs the project's full suite (the pre-v2.3.18 behavior). |
| `testing.fallback` | `full` | What happens when affected-detection fails (no adapter match, no git diff, no `test_files`). `full` is safe-by-default. `directory` falls back to dir-mapped tests (pytest only). `halt` returns a `user_prompt` so you can intervene. |
| `testing.full_suite_on_story_land` | `ci` | Where the regression-net full suite runs. `ci` trusts `gh pr checks`. `background` spawns the full command after `STORY_DONE` and blocks the next story on failure (**deferred to v2.3.19** — emits a warning when set today). `skip` disables the gate entirely (speed > safety, prototypes only). |
| `testing.commands.affected` | `null` | Verbatim override for the adapter-built affected command. Useful for monorepos (`nx affected --target=test`, `turbo run test --filter=...[origin/main]`, `lerna run test --since`). |
| `testing.commands.full` | `null` | Verbatim override for the full-suite command. Default falls through to the adapter (e.g. `npx vitest run`, `npx jest`, `pytest`). |

Adapter detection order: **vitest** → **jest** → **pytest** → **generic**. First match wins; generic always matches and either returns the user override or signals "no recommendation, fall back to full" so the resolver can downgrade per `testing.fallback`.

Story-level widening: dev-story / quick-dev signals may echo `test_scope_hint: { scope: 'full' }` or `test_scope_hint: { include_dirs: [...] }` to widen the scope for the next phase in the same story. Use this when the change is structural (shared util refactor, dep bump, schema migration, renamed exported symbol). The hint clears at the story boundary.

CLI override: `autopilot next --test-scope full` forces a full run for one emission without editing config.

Every emission is audited in the ledger as a `test_scope_decision` entry: adapter, command, reason, fallback flag, changed-files count, test-files count.

## Secrets Allowlist (`.secrets-allowlist`)

One glob pattern per line. Files matching these patterns are skipped during secrets scanning.

```
# Test files
test/**
tests/**
**/test_*

# Example files
*.example
*.sample
.env.example

# Documentation
docs/**
*.md

# Fixtures
**/fixtures/**
**/mocks/**
```

## Platform Commands (`modules/git/platform.yaml`)

Defines CLI commands for each platform. Uses `{placeholders}` filled at runtime:
- `{base_branch}` — from config
- `{branch}` — story branch name
- `{title}` — PR title
- `{body}` — PR body content

Commands use YAML `|` literal blocks to preserve HEREDOC formatting.

## System Prompt Files

These are created by `bin/sprintpilot.js install` and enforce BMad Method workflows from the first agent message.

### Source Files (in `_Sprintpilot/`)

| File | Purpose | Editable? |
|------|---------|-----------|
| `Sprintpilot.md` | Comprehensive skill reference by lifecycle phase | Yes — add skills, update descriptions |
| `templates/agent-rules.md` | Enforcement block injected into system prompts | Yes — add constraints, update rules |

### Generated Files (per tool)

| Tool | Generated File | Strategy |
|------|---------------|----------|
| Claude Code | `CLAUDE.md` + `AGENTS.md` | `@AGENTS.md` include |
| Cursor | `.cursor/rules/bmad.md` | Own file |
| Windsurf | `.windsurfrules` | Append with markers |
| Cline | `.clinerules` | Append with markers |
| Roo | `.roo/rules/bmad.md` | Own file |
| Gemini CLI | `GEMINI.md` | Append with markers |
| GitHub Copilot | `.github/copilot-instructions.md` | Append with markers |
| Kiro | `.kiro/rules/bmad.md` | Own file |
| Trae | `.trae/rules/bmad.md` | Own file |

### Customizing Rules

Edit `_Sprintpilot/templates/agent-rules.md` to change enforcement rules. Keep the `<!-- BEGIN:sprintpilot-rules -->` and `<!-- END:sprintpilot-rules -->` markers — they are required for idempotent updates and clean uninstall.

After editing, re-run `bin/sprintpilot.js install` to propagate changes to all tool system prompts.

## Git Status File (`git-status.yaml`)

The addon tracks git metadata in its own file at `_bmad-output/implementation-artifacts/git-status.yaml`. It never modifies BMad Method's `sprint-status.yaml`.

Example schema:

```yaml
# Sprintpilot — Git Status
git_integration:
  enabled: true
  base_branch: main
  platform: github

stories:
  1-1-add-login:
    branch: story/1-1-add-login
    worktree: .worktrees/1-1-add-login
    story_commit: abc1234
    patch_commits: [def5678, ghi9012]
    lint_result: "2 warnings — non-blocking"
    push_status: pushed
    pr_url: https://github.com/user/repo/pull/42
    worktree_cleaned: false
  1-2-user-profile:
    branch: story/1-2-user-profile
    push_status: pending
```

| Field | Type | Description |
|-------|------|-------------|
| `branch` | string | Git branch name (`story/<key>`) |
| `worktree` | string | Worktree path (`.worktrees/<key>`) |
| `story_commit` | string | SHA of the main story commit |
| `patch_commits` | list | SHAs of code review patch commits |
| `lint_result` | string | Lint summary (non-blocking) |
| `push_status` | string | `pushed`, `failed`, `skipped`, `pending` |
| `pr_url` | string | PR/MR URL (if created) |
| `worktree_cleaned` | boolean | Whether worktree has been removed |
