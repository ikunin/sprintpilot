# Adaptive Process Scaling — Reducing Sprintpilot Development Time

Status: Concept / Design doc
Branch: `claude/optimize-dev-workflow-D0U4w`
Constraint: All optimizations live in Sprintpilot-owned code (`_Sprintpilot/*`, configs, `AGENTS.md`). BMAD skill internals are off-limits. Sprintpilot supports **9 coding agents** (Claude Code, Cursor, Windsurf, Gemini CLI, Cline, Roo, Trae, Kiro, GitHub Copilot); no optimization may depend on agent-specific APIs.

> **Historical note (v2.1+):** This doc was authored when the concept was still numbered "v4" and the `legacy` profile was planned to pin `version_pinned: v0.9.0`. The shipped numbering is **v2.x**, and the `legacy` profile pins **`v1.0.5`** (see `_Sprintpilot/modules/autopilot/profiles/legacy.yaml`). Treat the body below as the design record — the behaviors landed roughly as described, but the numbering, profile snapshots, and the locus of enforcement (now `_Sprintpilot/bin/autopilot.js` + `_Sprintpilot/lib/orchestrator/` rather than `workflow.md` prose) have moved on. For the current truth on knobs and defaults, see [CONFIGURATION.md](./CONFIGURATION.md) and [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## 1. Problem

A trivial project (tic-tac-toe, 4 epics × 3–4 stories) currently takes ~4h under Sprintpilot autopilot. The bulk of that time is orchestration overhead, not implementation work:

- 7 sequential BMAD skill invocations per story (~84 calls for a tic-tac-toe)
- Worktree create/teardown per story (~12 worktrees)
- One PR per story (~12 PRs)
- Session checkpoint forced every 3 stories (~4 session restarts)
- Per-epic retrospectives (~4 retrospectives)
- Constant state-file / decision-log YAML churn

The per-story BMAD cycle is the right unit of rigor for a production team product. It is not the right unit for a toy, nor is it maximally efficient for larger projects where independent work could run in parallel.

## 2. Constraint: BMAD is off-limits

The autopilot (`_Sprintpilot/bin/autopilot.js` driving `_Sprintpilot/skills/sprint-autopilot-on/workflow.orchestrator.md`) is Sprintpilot's. It decides **which** BMAD skills to invoke and **when**. Everything in this document is implemented through:

- Autopilot routing changes
- Sprintpilot module configs (`_Sprintpilot/modules/{autopilot,git,ma}/config.yaml`)
- Git workflow (worktrees, branching, PRs)
- `AGENTS.md` / `CLAUDE.md` policy
- New Sprintpilot-owned helper scripts under `_Sprintpilot/scripts/`

No `bmad-*` skill is modified.

## 3. Core concept: Adaptive Process Scaling

A `complexity_profile` dimension (`nano | small | medium | large | legacy`) governs two things:

1. **Flow selection** — which BMAD flow runs per work unit.
2. **Orchestration envelope** — everything around the flow (worktrees, PRs, parallelism, session management, retrospectives).

Quality gates inside each flow are unchanged. `bmad-code-review` runs wherever the flow includes it. Profiles do not tune quality; they tune ceremony and parallelism.

## 4. Profile definitions

| Profile | Target project | Flow |
|---|---|---|
| `nano` | Toy, tutorial, solo learning. <20 stories, no external integrations | `bmad-quick-dev`, one call per epic |
| `small` | Solo-built MVP, internal tool, prototype | Full 7-step BMAD cycle per story |
| `medium` | Team-built product with real users | Full 7-step cycle per story, parallelism available |
| `large` | Production system, compliance/uptime stakes | Full 7-step cycle per story, stricter safety, parallelism on |
| `legacy` | Rollback to pre–v4 behavior | Full 7-step cycle, all v4 optimizations disabled |

`medium` is the default for `sprintpilot install` unless the user opts otherwise.

## 5. Nano flow

Nano routes each story through `bmad-quick-dev`'s one-shot path, which internally performs Implement → Review → Classify → Commit (`step-oneshot.md:44`). Quick-dev **rejects multi-goal input** (`step-01-clarify-and-route.md:81-86` runs a Multi-Goal HALT check), so the unit of work is **one story per quick-dev call**, not one epic.

Per story:

1. Autopilot resolves `{{story_key}}` from `sprint-status.yaml` (e.g. `1-2-user-auth`).
2. Autopilot invokes `bmad-quick-dev` with the story reference. Quick-dev:
   - Creates a spec file at `_bmad-output/implementation-artifacts/spec-<slug>.md` (its own template — not the story template).
   - Implements, runs its internal review step, classifies findings, commits locally.
   - Updates `sprint-status.yaml`: `ready-for-dev → in-progress → review` via its `sync-sprint-status.md` helper.
3. Autopilot runs the project's test suite — `N/N passed`.
4. When all stories in an epic complete, stage → commit → PR for the epic, squash-merge.

Skipped vs full cycle: `bmad-create-story`, `bmad-check-implementation-readiness`, `bmad-dev-story`, `bmad-code-review` (quick-dev has its own internal review step). Quality handling is what quick-dev does in one-shot mode.

### 5.1 Retrospective compatibility for nano

`bmad-quick-dev` writes **spec files**, not story files. `bmad-retrospective` reads **story files** via loose pattern matching (`bmad-retrospective/SKILL.md:246-282` — scans for `## Dev Notes`, `## Implementation Notes`, `## Lessons Learned`, `## Testing`, etc.).

**Default behavior:** nano sets `retrospective_mode: skip` — no issue.

**If user overrides nano to `retrospective_mode: auto`:** autopilot writes a minimal story-shaped file per completed epic at `_bmad-output/implementation-artifacts/<epic-id>-nano-retrospective-source.md` with the pattern-matched sections retrospective expects:

```markdown
# Epic <id>: <epic-title>

## Dev Notes
Implementation via bmad-quick-dev one-shot flow. Spec files: spec-<slug-1>.md, spec-<slug-2>.md, ...

## Implementation Notes
<copy the "Spec Change Log" sections from each spec file>

## Testing
<N>/<N> passed — <test command>

## File List
<aggregated from spec files' Code Map sections>
```

No BMad change required — retrospective's pattern matching accepts this structure.

### 5.2 Nano fallback (quality safety net)

```yaml
autopilot:
  nano:
    fallback_triggers:
      - tests_fail: true
      - quick_dev_classify_severity: high   # quick-dev's Classify step surfaced high-severity findings
    on_fallback: escalate_to_small          # next story runs full cycle
```

Quick-dev's one-shot Classify step (`step-oneshot.md`) already categorizes findings. If severity is high or tests fail, autopilot escalates the next story to `small` profile and logs the escalation.

### Nano safety net

```yaml
autopilot:
  nano:
    fallback_triggers:
      - tests_fail: true
      - quick_dev_error: true
    on_fallback: escalate_to_small   # next epic runs full cycle
```

If an epic's `bmad-quick-dev` output fails tests or the skill errors, the autopilot escalates the next epic to `small` and logs the escalation. Quality failures become loud, not silent.

## 6. Small / Medium / Large flow

All three run the identical 7-step BMAD cycle per story:

`bmad-create-story` → `bmad-check-implementation-readiness` → `bmad-dev-story` RED → GREEN → `bmad-code-review` → patches → re-invoke `bmad-code-review` (BMAD owns the `done` transition)

Differences are orchestration-only:

| Dimension | small | medium | large |
|---|---|---|---|
| Worktrees | optional (usually off for solo) | on | on |
| Branching / PR granularity | per-story | per-story | per-story |
| Retrospective mode | `auto` | `auto` | `stop` (interactive) |
| Session story limit | 0 (no cap) | 5 | 3 |
| M2: parallel intra-epic stories | off | opt-in, default 2 | on, default 3 |
| M3: coalesce state writes | on | on | on |
| M4: conditional boot work | on | on | **off** (always full reconcile) |
| M5: cached per-iteration reads | on | on | on |
| Cross-epic parallelism | off | off | experimental opt-in |

M1 (skip redundant re-review) is not in the table — it was dropped after research found it unsafe AND redundant with BMad's own "Clean Review Shortcut" (`bmad-code-review/step-04-present.md:15-17`).

### Why large turns safety knobs back on

`large` assumes rollback is expensive. Full boot reconciliation (~10–30s) is cheap insurance against drifted refs. Not worth cutting when downside is customer-visible.

## 7. Parallelism design

### 7.1 Scope

- **Within-epic story parallelism** — primary mechanism. Independent stories in the same epic run concurrently in separate worktrees. Available on `medium` (opt-in) and `large` (on).
- **Cross-epic parallelism** — experimental only. Demoted from "opt-in on large" after adversarial review (R5). Behind a separate flag with explicit warning.
- **Not parallelized** — planning skills (sequential by BMAD contract). The 3 adversarial layers inside `bmad-code-review` are already parallel internally.

### 7.2 Dependency detection (multi-signal)

BMad story files carry **no formal `depends_on:` field** (confirmed: canonical schema in `bmad-create-story/template.md`). Dependencies are implicit via sprint-status ordering + "Previous Story Intelligence" + `## References` citations. Sprintpilot adds its own explicit mechanism without modifying BMad artifacts.

The autopilot builds a per-epic DAG using four sources, in priority order:

1. **Sprintpilot sidecar declaration** (highest confidence, user-authored). New file `_Sprintpilot/sprints/dependencies.yaml`:
   ```yaml
   # Sprintpilot-owned; BMad never reads this
   stories:
     "1-3-user-profile":
       depends_on: ["1-1-data-model", "1-2-auth"]
     "1-4-avatar-upload":
       depends_on: ["1-3-user-profile"]
   ```
2. **Sprint-status ordering.** If the sidecar is absent, autopilot honors the order stories appear in `sprint-status.yaml` as a linear chain (safe default — matches BMad's own "first-to-last" iteration rule in `bmad-create-story` and `bmad-dev-story`).
3. **Predicted file touches.** Parse the story's `## Tasks/Subtasks` section for file paths. Two stories touching the same file become conflict-edges (block parallel execution even when logically independent).
4. **LLM graph inference** (last resort, fires only if sidecar is absent AND user opts in). One inference call per epic via the host agent's skill mechanism — never a direct Sprintpilot LLM call. Emits a proposed DAG for user review; autopilot does not auto-apply it.

**Default behavior without configuration:** linear chain from sprint-status ordering. Parallelism runs exactly one story per layer. This is safe but gives zero speedup — users who want parallelism must author the sidecar or enable option (3)/(4) explicitly.

User overrides in the same sidecar file:

```yaml
overrides:
  - epic: 2
    force_sequential: ["2-3", "2-4"]     # known conflict
    force_independent: ["2-1", "2-2"]    # detection was wrong
```

### 7.3 Execution model

```
Epic 1 DAG:                Execution:
  1-1 ──┐                   Layer 0: [1-1]               (1 agent)
  1-2 ──┼── 1-4             Layer 1: [1-2, 1-3]          (2 agents)
  1-3 ──┘                   Layer 2: [1-4]               (1 agent)
```

Per layer: spawn N sub-agents (one per story, each in its own worktree), await all, sequential merge in dependency order, then next layer.

### 7.4 Per-story state sharding (R1, R10)

Parallel sub-agents cannot share `autopilot-state.yaml` or `decision-log.yaml` — concurrent writes corrupt YAML. Design uses per-agent shards merged at layer boundary by the coordinator (the parent autopilot), never by sub-agents.

**Directory layout:**

```
_bmad-output/implementation-artifacts/
  autopilot-state.yaml              # merged, authoritative
  decision-log.yaml                 # merged, append-only (timestamp-ordered)
  .autopilot-state/
    <story-key>.yaml                # per-agent shard, single-writer
  .decision-log/
    <story-key>.yaml                # per-agent append-only log
  .timings/
    <story-key>.yaml                # M0 per-agent phase timings
  .archive/
    layer-<id>/                     # post-merge shard archive for debugging
```

**Sub-agent write protocol (no locking required):**

1. Each sub-agent is the only writer of its `<story-key>.yaml` shard.
2. Writes are atomic: write to `.<filename>.tmp`, then `rename` to the target path (POSIX atomic).
3. Sub-agents never read or write the merged project-level files.

**Coordinator merge protocol (at layer boundary):**

1. Read all shards in `.autopilot-state/`, `.decision-log/`, `.timings/`.
2. State: merge by story-key — no overlap expected since each agent owns its key; conflict logged as an integrity error.
3. Decision log: concatenate all entries, sort by timestamp, dedupe by `id`.
4. Timings: concatenate, preserve per-phase rows.
5. Write merged result atomically (`.tmp` + rename) into the project-level files.
6. Move shards to `.archive/layer-<id>/` (never delete — cheap audit trail).

**Crash recovery:**

- If the coordinator crashes mid-merge, shards survive. The next session's coordinator re-runs the merge idempotently.
- If a sub-agent crashes, its shard may be partial YAML; the coordinator validates each shard with a YAML parser before merging and skips/reports invalid shards (the story is then treated as failed at that layer).
- Shards are never pruned during a sprint, so any rerun has full history.

**Sequential-execution path:** when `parallel_stories: false`, sharding is skipped and the autopilot writes directly to the merged files (today's behavior preserved).

### 7.4a Worktree cost mitigation (R3)

**Correction:** `git worktree add --reference` does not exist as a flag. `--reference` is available on `git clone` and `git submodule update`. The correct recipe uses submodule-level referencing.

**Submodule reference clone for new worktrees.** After `git worktree add`, run submodule init with `--reference <base-repo>` pointing at the parent checkout. Submodule objects are reused from the existing `.git/modules/<name>/` rather than re-fetched.

```bash
git worktree add .worktrees/<story-key> <branch>
git -C .worktrees/<story-key> submodule update \
    --init --recursive \
    --reference <project-root> \
    --jobs=4
```

Cuts submodule init from ~30s to ~2-5s depending on network. Requires **git ≥ 2.18** for `--jobs` and stable `--reference` on submodule update.

**Concurrent worktree discipline (new).** When multiple worktrees operate against the same repo, enforce:

- **One branch per worktree** (already the Sprintpilot rule).
- **Per-submodule serialization.** Concurrent `submodule update` on the same submodule can corrupt the shared `.git/modules/<sub>/index`. Autopilot acquires `.git/modules/.sprintpilot-submodule-lock` via `lock.js` semantics before each submodule update.
- **Disable auto-gc during runs.** `git config gc.auto 0` for the session. Restore on session end.
- **Never prune while peers active.** `git worktree prune` only runs during boot health-check (§boot) or sprint teardown, never during active story execution.
- **Retry on ref-lock errors.** Contention on `.git/packed-refs.lock` is transient; retry up to 3× with 500ms–2s jittered backoff. Fail otherwise.

```yaml
multi_agent:
  submodule_reference: true            # use --reference on submodule init
  submodule_jobs: 4                    # --jobs=N on submodule init
  gc_auto_disable: true                # git config gc.auto 0 during runs
  ref_lock_retry_attempts: 3
  ref_lock_retry_base_ms: 500
```

**Skip-parallelism for small epics.** Parallel worktree overhead exceeds sequential execution time for tiny epics. Autopilot estimates epic wall-clock as `story_count × baseline_story_duration` (default 180s pre-M0 calibration). Below threshold → sequential, logged.

```yaml
multi_agent:
  min_epic_duration_for_parallel_sec: 300
  baseline_story_duration_sec: 180   # overwritten by M0 data after first sprint
```

### 7.5 Failure modes

| Failure | Response |
|---|---|
| Test fail in one parallel story | Isolate; continue others; block stories depending on the failed one; report at batch end |
| Merge conflict at layer boundary | Retry once after rebase; on second failure, abort that story and force sequential for rest of epic |
| `max_consecutive_conflicts` reached | Auto-disable parallelism for remainder of session, log to decision-log |
| Worktree disk/permission failure | Fall back to sequential for that story (orchestrator's `parallel_batch` resolver downgrades to sequential per profile) |
| Rate-limit / 429 from provider | Exponential backoff, reduce effective concurrency for this session |

### 7.6 Cost and rate-limit handling — delegated to host agent (R2, revised)

**Cannot live in Sprintpilot.** Confirmed by architecture research: Sprintpilot never talks to LLM APIs; all model interaction is through the host agent (one of 9 supported: Claude Code, Cursor, Windsurf, Gemini CLI, Cline, Roo, Trae, Kiro, GitHub Copilot). No cross-tool telemetry convention exists (only Claude Code has hooks).

**Design:** Sprintpilot relies on the host agent's built-in retry. Parallel execution's failure mode handles rate-limit backpressure indirectly:

1. If a sub-agent's skill invocation fails (the host agent surfaces any rate-limit error through its own retry logic or ultimately through a non-zero exit or an error message in the skill output), the coordinator detects the failure at the layer boundary.
2. On detected failure, the coordinator:
   - Reduces `effective_parallel` by 1 for subsequent layers in this session.
   - Retries the failed story sequentially before continuing.
   - Persists the reduced concurrency in session state.
3. After `max_consecutive_conflicts` (§7.5 existing) of any failure type, parallelism is disabled for the remainder of the session.

**Optional Claude Code fast path.** For installs on Claude Code only, a future Sprintpilot release MAY offer a hook-based observer that consumes Claude Code's lifecycle events for earlier rate-limit detection. Opt-in, not default, and never required. Documented as an advanced feature, not in the installer.

**Pre-session cost awareness** is delegated to the user — they know their API tier; Sprintpilot displays a one-line warning before parallel sprints:

```
Sprintpilot parallelism: N concurrent stories.
Check your AI provider's rate limits (requests/min, tokens/min)
and billing tier can absorb ~3N concurrent skill invocations.
```

That's the entire R2 mechanism. No cost cap. No 429 regex scraping. No circuit breaker. All of those would violate tool-agnosticism.

### 7.7 M1 dropped — superseded by BMad's own "Clean Review Shortcut" (R7, revised)

**M1 is unsafe and unnecessary.** Confirmed: `bmad-code-review/steps/step-04-present.md:83-105` (section 6) is the only code path that transitions `sprint-status.yaml[story] → done`. Skipping the second invocation leaves the story permanently at `in-progress`.

Also unnecessary: `step-04-present.md:15-17` contains a **"Clean review shortcut"**: *"If zero findings remain after triage (all dismissed or none raised): state that and proceed to section 6 (Sprint Status Update)."* BMad already short-circuits the heavy review work when there's nothing to re-review.

M1 is removed from the concept entirely. **Keep the second `bmad-code-review` invocation always.** BMad handles the optimization internally.

## 8. Configuration reference

All parameters live in Sprintpilot-owned YAMLs. Defaults shown per profile.

### 8.1 `_Sprintpilot/modules/autopilot/config.yaml`

| Parameter | Purpose | nano | small | medium | large | legacy |
|---|---|---|---|---|---|---|
| `complexity_profile` | Profile selector | nano | small | medium | large | legacy |
| `implementation_flow` | Routing override | `quick` | `full` | `full` | `full` | `full` |
| `session_story_limit` | Story count before checkpoint (0 = disabled) | 5 | 3 | 3 | 3 | 3 |
| `retrospective_mode` | Retrospective handling | `skip` | `auto` | `auto` | `stop` | `auto` |
| `auto_escalate_on_failure` | Nano escalation | true | n/a | n/a | n/a | false |
| `skip_redundant_rereview` (M1) | Skip post-patch re-review when findings empty | n/a | true | true | false | false |
| `coalesce_state_writes` (M3) | Batch state/decision-log/git-status commits | on | on | on | on | off |
| `conditional_boot_work` (M4) | Skip health-check when no worktrees present | on | on | on | off | off |
| `cache_shared_reads` (M5) | Read sprint-status/decision-log once per loop iter | on | on | on | on | off |
| `phase_timings` (M0) | Emit per-phase duration logs | on | on | on | on | off |
| `auto_infer_dependencies` (2.0.2) | LLM-infer story DAG after planning, write dependencies.yaml | off | on | on | on | off |

**Session budget** is `session_story_limit` only (R8). Token estimation was researched and removed — it would require LLM observability Sprintpilot doesn't have (host agent owns all model interaction; no tool-agnostic API). Story count per profile is the entire mechanism. Users tune by changing the numeric limit.

Defaults were retuned in 2.0.1 to mitigate context rot observed in end-to-end testing. Nano previously ran unlimited (`0`) and medium was `5`; both exposed step 10's CRITICAL cleanup actions to late-session instruction decay. All non-nano profiles now cap at 3 stories per session; nano at 5 (quick-dev is cheap enough to fit more, but unlimited is off the table). Independently, the autopilot forces a one-session fresh-context handoff for finalization regardless of where `session_story_limit` landed — enforced by the `sprint_finalize_pending` terminal state in `_Sprintpilot/lib/orchestrator/state-machine.js`.

**M1 removed.** `skip_redundant_rereview` is gone from the concept entirely. BMad's own "Clean Review Shortcut" (`step-04-present.md:15-17`) handles this optimization internally; the autopilot always runs the second `bmad-code-review` invocation.

### 8.2 `_Sprintpilot/modules/ma/config.yaml` (multi-agent / parallelism)

| Parameter | nano | small | medium | large |
|---|---|---|---|---|
| `parallel_stories` | false | false | **opt-in** (default false) | true |
| `max_parallel_stories` | — | — | 2 | 3 |
| `parallel_epics` | false | false | false | **experimental** (default false) |
| `max_parallel_epics` | — | — | — | 2 |
| `dependency_source` | — | — | `explicit,files,llm` | `explicit,files,llm` |
| `dependency_llm_model` | — | — | `haiku-4.5` | `haiku-4.5` |
| `max_consecutive_conflicts` | — | — | 2 | 3 |
| `conflict_resolution` | — | — | `rebase_retry` | `rebase_retry` |
| `state_sharding` | on whenever `parallel_*` is true — otherwise off |
| `submodule_reference` | n/a | n/a | true | true |
| `submodule_jobs` | n/a | n/a | 4 | 4 |
| `gc_auto_disable` | n/a | n/a | true | true |
| `ref_lock_retry_attempts` | n/a | n/a | 3 | 3 |
| `ref_lock_retry_base_ms` | n/a | n/a | 500 | 500 |
| `min_epic_duration_for_parallel_sec` | n/a | n/a | 300 | 300 |
| `baseline_story_duration_sec` | n/a | n/a | 180 (M0-calibrated) | 180 (M0-calibrated) |
| `on_subagent_failure_reduce_parallel` | n/a | n/a | true | true |
| `max_consecutive_conflicts` | — | — | 2 | 3 |

Cost/rate-limit knobs (`cost_cap_*`, `rate_limit_*`) are removed. Sprintpilot has no LLM observability; parallelism backpressure is implicit via failure-driven concurrency reduction (§7.6).

### 8.3 `_Sprintpilot/modules/git/config.yaml`

| Parameter | nano | small | medium | large | legacy |
|---|---|---|---|---|---|
| `granularity` | `epic` | `story` | `story` | `story` | `story` |
| `worktree.enabled` | false | optional | true | true | true |
| `squash_on_merge` | true | false | false | false | false |
| `push.auto` | true | true | true | true | true |
| `push.create_pr` | true | true | true | true | true |

## 9. Installer UX — minimize prompts

Design principle: **one new question during install**. Everything else uses per-profile defaults that the user can edit later in the YAMLs. The existing installer already asks about tools and BMad detection (`bin/sprintpilot.js`); the v4 change adds just one question.

### 9.1 The one new question

Added to the existing installer flow after tool selection:

```
Sprintpilot v4 introduces complexity profiles to tune ceremony + parallelism
to your project size. Which profile fits?

  1) nano    — toy / tutorial / learning project, solo, small codebase
               (uses bmad-quick-dev; fastest; drops ceremony you don't need)
  2) small   — MVP / internal tool / prototype, solo or 1-2 devs
  3) medium  — team product with real users  (default, recommended)
  4) large   — production system, compliance or uptime requirements
  5) legacy  — pre-v4 behavior (rollback option)

[3]:
```

That's it. All other dimensions (parallelism, retrospectives, session limits, worktree settings) come from per-profile defaults. A parallelism + retrospective + session prompt appears only in `--advanced` mode.

### 9.2 What the profile choice sets

| User chooses | Profile sets |
|---|---|
| `nano` | `implementation_flow: quick`, no worktrees, retrospective skipped, squash-merge per epic, session limit 0 |
| `small` | Full BMad cycle, worktrees optional, retrospective `auto`, session limit 5 |
| `medium` | Full BMad cycle, worktrees on, retrospective `auto`, session limit 5, parallelism opt-in (see advanced) |
| `large` | Full BMad cycle, worktrees on, retrospective `stop`, session limit 3, parallelism on, safety knobs max |
| `legacy` | Pre-v4 behavior pinned to `v0.9.0` snapshot |

The installer's success message shows the user what was set:

```
✓ Sprintpilot installed with profile: medium
  - BMad cycle: full (create-story → dev-story → code-review → retrospective)
  - Parallelism: opt-in (edit _Sprintpilot/modules/ma/config.yaml to enable)
  - Worktrees: enabled
  - Retrospectives: auto (deterministic, non-blocking)

Rollback: set complexity_profile: legacy in _Sprintpilot/modules/autopilot/config.yaml
Full config reference: docs/adaptive-process-scaling.md §8
```

### 9.3 Non-interactive / CI

The existing installer already supports `--tools <list>`, `--yes`, `--dry-run`, `--force`, `--migrate-v1` (see `bin/sprintpilot.js`). The v4 change adds only one new flag for the common case:

```
sprintpilot install --tools cursor,windsurf --profile medium --yes
```

That's the minimal CI command: pick tools, pick profile, done. All per-profile defaults apply automatically.

### 9.4 Advanced / override

Power users who want to tune beyond profile defaults:

```
sprintpilot install \
  --tools claude-code \
  --profile medium \
  --parallel 3 \
  --retrospective-mode stop \
  --session-story-limit 0 \
  --yes
```

Plus two new flags for reproducibility:

- `--from-config <path>` — load all settings from a file; per-flag overrides allowed
- `--dry-run` — print resolved YAMLs, exit 0

**Validation (fail closed):**

| Combination | Behavior |
|---|---|
| `--parallel > 0` with `--profile nano\|small` | error (parallelism not supported for this profile) |
| `--profile legacy` with any other v4 flag | error (legacy pins all settings) |
| `--parallel N` with `N > 4` | error (supported range 0–4) |
| Missing `--profile` in `--yes` mode | warn + default to `medium` (safe default; not fail-closed to preserve current install script compatibility) |
| `--dry-run` + `--yes` | `--dry-run` wins, no files written |

All CLI flags have a one-to-one mapping to YAML keys; `sprintpilot install --help` prints both.

### 9.5 Interactive advanced mode

`sprintpilot install --advanced` adds three extra prompts after the profile question:

```
Enable parallel story execution within epics?  (medium/large only)
  1) No — sequential (safest)
  2) Yes — max 2 concurrent
  3) Yes — max 3 concurrent (recommended)
  4) Yes — max 4 concurrent (aggressive)
[2 for medium, 3 for large]:

How should epic retrospectives be handled?
  1) skip — no artifact
  2) auto — deterministic artifact, non-blocking
  3) stop — pause for interactive /bmad-retrospective
[auto for small/medium; stop for large]:

How frequently should autopilot checkpoint?
  1) Never (0)
  2) Every 5 stories (medium default)
  3) Every 3 stories (large default)
[per profile default]:
```

Standard install skips all three — profile defaults apply.

## 10. Estimated time reduction

Structure is reliable; exact percentages are not, until M0 measurement lands. Reproduced here for planning only.

| Project size (current baseline) | nano | small | medium sequential | medium parallel=2 | medium parallel=3 | large sequential | large parallel=3 |
|---|---|---|---|---|---|---|---|
| Toy, 12–16 stories (~4h) | ~30–45 min | ~2h | ~2.5h | ~2h | — | — | — |
| MVP, 20–40 stories (~12h) | n/a | ~7h | ~9h | ~6h | ~5h | — | — |
| App, 40–80 stories (~30h) | n/a | n/a | ~22h | ~14h | ~10h | ~24h | ~12h |
| Large, 80+ stories (~70h) | n/a | n/a | n/a | n/a | n/a | ~55h | ~25h |

Parallelism scales with **DAG width**, not story count. A fully serial DAG gets zero benefit from `parallel=N`. Expected average benefit: 40–60% of linear N-speedup on typical apps.


## 11. Adversarial review findings — resolutions (post-research)

Each finding's resolution was revised after comprehensive research into BMad skill contracts, Sprintpilot's architecture (9 supported coding agents), and cross-tool patterns.

| ID | Finding | Post-research resolution |
|---|---|---|
| R1 | State/decision-log race under parallel execution | Per-story shards, atomic `.tmp` + rename writes, coordinator-only merges at layer boundary, crash-safe idempotent recovery (§7.4) |
| R2 | LLM cost + rate-limit blast radius | **Cannot live in Sprintpilot** (tool-agnostic, 9 supported agents, no LLM visibility). Design delegates to host agent's retry behavior; failure-driven concurrency reduction replaces cost caps and 429 regex. One-line pre-sprint warning for user awareness (§7.6) |
| R3 | Worktree setup cost (submodule init ~30s × N) | **Corrected**: `git worktree add --reference` doesn't exist. Actual recipe uses `git submodule update --reference <base> --jobs=4` after `git worktree add`. Plus concurrent-worktree discipline: per-submodule lock, `gc.auto 0`, ref-lock retry. Requires git ≥ 2.18 (§7.4a) |
| R4 | Nano artifact incompatibility with downstream skills | **Revised**: quick-dev writes its own spec files (not story files). Nano default `retrospective_mode: skip` eliminates the issue. If user overrides, autopilot writes a pattern-matched story-shaped file (retrospective's schema is loose per `bmad-retrospective/SKILL.md:246-282`) (§5.1) |
| R5 | Cross-epic parallelism too risky for large default | Experimental flag, off by default, requires explicit per-epic `independent: true` + pre-flight dry-run merge, max 2 concurrent hardcoded, no LLM fallback (§7.1, §11a) |
| R6 | Installer must support non-interactive / CI | CLI flags + `--dry-run` + `--from-config` + explicit validation matrix with fail-closed semantics (§9.2). Flags merge into the existing `--tools`, `--yes`, `--force` installer surface |
| R7 | M1 depends on BMAD contract we haven't verified | **M1 dropped entirely.** BMad's `step-04-present.md:15-17` already has a "Clean Review Shortcut" that short-circuits when findings are empty; M1 would have been unsafe (skipping also skips the `done` transition) AND redundant (§7.7) |
| R8 | `session_budget_fraction` has no measurement API | Token-estimation mode removed entirely (would require LLM observability Sprintpilot doesn't have). Only `session_story_limit` per profile (§8.1) |
| R9 | No rollback path | `legacy` profile pinned by config version, not tracking latest; installer refuses silent migration; documented one-line escape hatch (§14) |
| R10 | M0 phase timings race under parallel execution | Per-story `.timings/<story-key>.yaml` shards, same merge protocol as state sharding (§7.4) |

### 11a. Cross-epic parallelism safety rails (R5 detail)

Cross-epic parallelism is retained as experimental only, with four hard gates:

1. Each participating epic must carry explicit `independent: true` in `sprint-status.yaml` — no LLM inference.
2. **Pre-flight dry-run merge**: before starting, autopilot checks out `origin/<base>`, creates a throwaway branch, attempts `git merge --no-commit --no-ff` of each epic branch sequentially. If conflicts, epic parallelism aborts for that pair.
3. Maximum 2 epics concurrent, hardcoded. No `max_parallel_epics` tuning above 2.
4. Disabled entirely if `consecutive_epic_merge_conflicts ≥ 1` in the current session.

## 12. Open questions — research findings

All previous open questions have been answered via upstream BMad source research (repo `github.com/bmad-code-org/BMAD-METHOD`, main branch as of 2026-04-22):

| Question | Answer | Source |
|---|---|---|
| Does `bmad-quick-dev` handle epic-sized briefs? | **No — HALTs on multi-goal input.** Design revised: quick-dev runs per story, not per epic | `bmad-quick-dev/steps/step-01-clarify-and-route.md:81-86` |
| Does `bmad-quick-dev` write a story file? | **No — spec files at `{implementation_artifacts}/spec-<slug>.md`** with a different schema | `bmad-quick-dev/workflow.md`, `spec-template.md` |
| Does the second `bmad-code-review` call do something different? | **No different logic, but owns the `done` transition in `sprint-status.yaml`.** BMad already optimizes via "Clean Review Shortcut" when findings empty | `bmad-code-review/steps/step-04-present.md:15-17`, 83-105 |
| Do BMAD story files carry `depends_on:`? | **No formal field.** Dependencies are implicit via sprint-status ordering | `bmad-create-story/template.md` |
| Does `bmad-retrospective` accept arbitrary schemas? | **Yes — loose pattern matching** on `## Dev Notes` / `## Testing` / `## Lessons Learned` etc. | `bmad-retrospective/SKILL.md:246-282` |
| Does `bmad-code-review` work without prior `bmad-dev-story`? | **Yes — standalone supported.** If no spec file set, findings not persisted and sprint sync skipped | `bmad-code-review/workflow.md:42-49`, `step-04-present.md:85` |
| Does `git worktree add --reference` work? | **The flag doesn't exist on worktree.** Use `git submodule update --reference <base> --jobs=N` after `git worktree add` | `git-worktree` man page; Git 2.18+ |
| Can Sprintpilot observe LLM cost/rate-limit across 9 agents? | **No common mechanism.** Only Claude Code has hooks; all others: stderr + exit code only. Design delegates to host agent retry behavior | Multi-agent SDK survey (LiteLLM, Vercel AI SDK, LangChain) |

**Remaining genuinely open (require M0 measurement to answer, not research):**

1. **What is realistic DAG width per epic?** Affects parallelism ROI. M0 instrumentation measures it.
2. **What is `baseline_story_duration_sec` in practice?** Default 180s is placeholder; M0 calibrates.
3. **Does quick-dev's one-shot path scale to complex single stories?** Validated once we run it on the tic-tac-toe baseline.

## 13. Rollout plan (post-research)

Each step is validated before the next. No step ships without measurement from the previous. Revised after research — M1 track removed, nano restructured, cost controls delegated.

1. **M0 — phase-timing instrumentation.** ~20 lines in `workflow.md`; per-story `.timings/` shards per §7.4. Baseline run on current settings. Publish hotspot breakdown. Seeds `baseline_story_duration_sec` (§7.4a).
2. **State-shard infrastructure.** Build `.autopilot-state/`, `.decision-log/`, `.timings/` shard-and-merge machinery (§7.4). Prerequisite for parallel work and for M0 under parallel execution.
3. **Git version check.** Add `git --version` preflight in installer; minimum 2.18 for submodule `--jobs` / `--reference`. Warn (don't fail) on 2.5–2.17 — features degrade gracefully.
4. **Nano routing.** Implement `implementation_flow: quick`, route per-story to `bmad-quick-dev` via its story-key-aware path (`step-01-clarify-and-route.md:40-44`). Run tic-tac-toe sprint; compare wall-clock and test count against M0 baseline.
5. **Nano orchestration cuts.** PR-per-epic, no worktrees, `retrospective_mode: skip`, squash-merge. Measure incremental saving.
6. **M3 / M4 / M5 — orchestration overhead cuts.** Coalesce writes, conditional boot, cached reads. Small per-step savings that compound.
7. **Dependency sidecar (§7.2).** Ship `_Sprintpilot/sprints/dependencies.yaml` schema + parser. Default linear chain from sprint-status ordering. Document.
8. **Submodule reference + concurrent worktree discipline (§7.4a).** Build reference-clone recipe, submodule serialization lock, `gc.auto 0` during runs, ref-lock retry. Measure actual submodule init time in a fresh worktree.
9. **M2 — parallel intra-epic stories.** Build behind `parallel_stories: false` default. Opt-in for one medium project, measure conflict rate and DAG width, then decide default for medium.
10. **Cross-epic parallelism (§11a).** Experimental only. Only after M2 is proven on several projects with zero corruption incidents in state merge.

## 14. Rollback path (R9)

Any user can revert to pre–v4 behavior at any time:

```yaml
# _Sprintpilot/modules/autopilot/config.yaml
autopilot:
  complexity_profile: legacy
```

### 14.1 Version-pinned legacy profile

`legacy` is not "whatever the current defaults with v4 disabled look like" — that would silently drift with future changes. It is pinned to a named config version:

```yaml
# _Sprintpilot/modules/autopilot/profiles/legacy.yaml
version_pinned: "v0.9.0"    # last pre-v4 release
settings:
  session_story_limit: 3
  retrospective_mode: auto
  skip_redundant_rereview: { mode: off }
  coalesce_state_writes: false
  conditional_boot_work: false
  cache_shared_reads: false
  phase_timings: false
  # … full pre-v4 snapshot frozen at v0.9.0
```

The autopilot loads `legacy` by reading this frozen snapshot, not by interpreting current defaults with everything turned off. Future refactors cannot silently affect `legacy` behavior.

### 14.2 Upgrade migration check

On `sprintpilot install` against an existing legacy config:

1. Installer detects `complexity_profile: legacy` + `version_pinned: v0.9.0`.
2. Installer checks whether all settings in the frozen snapshot are still supported in the current code.
3. If all supported → keep legacy as-is, no changes.
4. If any setting was renamed or removed → prompt the user:
   ```
   Your legacy profile uses setting <name> which has been renamed to <new-name>.
     1) Keep legacy (use v0.9.0 snapshot; renamed settings fall back to defaults with a warning)
     2) Upgrade to <closest-compatible-profile>
     3) Switch to a different profile
   ```
5. Never silently migrate.

### 14.3 Scope guarantee

`legacy` guarantees:

- No M0/M1/M3/M4/M5 optimizations run
- No parallelism (story-sharding infrastructure disabled even if built)
- Per-story branches and PRs
- Full boot reconciliation and health-check every session
- BMAD skill invocation pattern is identical to pre-v4 autopilot

The installer's final success message documents this escape hatch for every profile.

## 15. Summary

- **Quality is invariant.** `bmad-code-review` runs wherever the chosen flow includes it; profiles do not turn it off.
- **Speed comes from orchestration.** Worktree overhead, session checkpoints, redundant calls, state-file churn, sequential execution of independent work — all are orchestration, not quality.
- **Nano uses the quick flow; everything else uses the full cycle.** This is the cleanest carve-out and the only place ceremony is reduced at the skill level.
- **Parallelism is the main medium+ lever.** DAG-aware intra-epic story execution with per-story state shards.
- **Every optimization has a fallback.** Nano → small on failure. M1 gated on BMAD contract read. `legacy` profile as universal rollback.
- **Measurement gates every deployment.** M0 first. Percentages in §10 are estimates for planning, not promises.

The expected outcome for the originating complaint — a tic-tac-toe that took 4h — is **~30–45 minutes on the nano profile**, with no change to BMAD and no loss of the quality handling inside the quick flow.
