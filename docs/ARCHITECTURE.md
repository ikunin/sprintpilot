# Sprintpilot Architecture

> Authoritative architecture reference for Sprintpilot **v2.7.4** (BMad Method compatibility `>=6.2.1`, tested through v6.8.0; Node `>=20.12.0`).
> This document explains how Sprintpilot works end-to-end: the runtime model, the orchestrator's two-layer design, every major subsystem, and the on-disk contracts that hold it together.

---

## 1. What Sprintpilot Is

Sprintpilot is an **additive autopilot and multi-agent add-on for the [BMad Method](https://github.com/bmad-code-org/BMAD-METHOD)**. BMad gives a project its structured artifacts — a PRD, architecture, epics, and a sprint of stories each with acceptance criteria. Sprintpilot drives those stories through BMad's development cycle **autonomously**: it decides what runs next, invokes the right BMad skill, verifies the result against artifacts on disk, performs the git workflow (branches, commits, PRs, merges), and persists enough state to survive a crash and resume mid-story.

Two facts shape every design decision:

1. **Sprintpilot never invents BMad workflows.** It *composes* upstream BMad skills verbatim (`bmad-create-story`, `bmad-dev-story`, `bmad-code-review`, …). When BMad changes, Sprintpilot stays composable because it only orchestrates the public skills, never their internals.
2. **The LLM is a worker, not the planner.** A deterministic Node state machine decides the next action; the LLM executes it and reports a structured signal. This inverts the usual "LLM improvises" model and is what makes runs reproducible, auditable, and resumable.

### Two modes of using this repository

- **Driving a sprint** — running stories through the cycle. Governed by `AGENTS.md` (the runtime contract) and the orchestrator.
- **Developing Sprintpilot itself** — editing the orchestrator, scripts, skills, tests. Governed by `CLAUDE.md`. The 7-step BMad cycle does **not** apply here; this is plain Node development.

---

## 2. Design Principles

1. **Additive & survivable** — Sprintpilot lives entirely under `_Sprintpilot/` and writes only to its own artifacts. It never modifies BMad's files, so it survives BMad upgrades and re-plans.
2. **Pure core, impure edge** — all decision logic is deterministic and pure (no I/O); all side effects are isolated at the CLI boundary. This is the single most important structural rule (§4).
3. **Skills are prompts, scripts are logic** — anything requiring determinism, parsing, or git lives in zero-dependency Node scripts; anything requiring judgment is a markdown skill the LLM runs.
4. **Trust, but verify** — the LLM's claim that a phase succeeded is never taken at face value. `verify.js` re-checks it against on-disk artifacts before the state machine advances (§9).
5. **Everything is a file** — all state lives in files under `_bmad-output/implementation-artifacts/`, enabling crash recovery and cross-session resume.
6. **Graceful degradation** — no git? skip git ops. No platform CLI? print manual steps. No remote? local commits only. Missing profile key? default to `medium`. Every feature fails safe.
7. **Adaptive scaling** — a single `complexity_profile` knob (`nano` → `legacy`) reshapes the whole flow, from one-shot quick-dev to the full 7-step cycle with parallel stories.

---

## 3. The Runtime Model — the Orchestration Loop

Everything Sprintpilot does at runtime is a single loop, defined by the LLM-facing contract in `_Sprintpilot/skills/sprint-autopilot-on/workflow.orchestrator.md`. The LLM is told to follow it verbatim:

```
        ┌──────────────────────────────────────────────────────────────┐
        │  1. node _Sprintpilot/bin/autopilot.js next                   │
        │       → { action, phase, next_summary }                       │
        │                                                                │
        │  2. Surface next_summary to the user, then EXECUTE the action  │
        │       per its type (invoke_skill / git_op / run_script / …)    │
        │                                                                │
        │  3. Build a structured SIGNAL describing the outcome           │
        │       { status: success|failure|blocked|… , output, … }        │
        │                                                                │
        │  4. node autopilot.js record --signal '<json>'                 │
        │       → { action, verdict, phase, profile, next_summary }      │
        │                                                                │
        │  5. verdict=prompted? ask the user, feed answer as user_input  │
        │     action.type=halt? STOP (state + handoff already written)   │
        │     else → loop back to step 2 with the returned action        │
        └──────────────────────────────────────────────────────────────┘
```

The LLM **never decides what runs next** — `autopilot next`/`record` always hand it the next action. It only (a) executes actions, (b) reports outcomes, and (c) relays questions to the human.

### Action types the orchestrator emits

| Action | Meaning | How the LLM executes it |
|---|---|---|
| `invoke_skill` | Run a named BMad skill | Run the skill verbatim; `template_slots` carry context hints (story_key, prior_diagnosis, relevant decisions) |
| `git_op` | A git operation | Execute `action.steps` (pure argv arrays) in order via `run-step.js`; halt on first non-retryable failure |
| `run_script` | A Node helper (e.g. story landing) | Execute `action.command` (argv only, no shell interpolation) |
| `parallel_batch` | Concurrent child actions | Dispatch children concurrently (capable hosts); else fall back to sequential |
| `user_prompt` | A question for the human | Ask `action.prompt`; feed the answer back as a `user_input` signal |
| `halt` | Stop the session | Stop; honor `handoff: sprint_finalize_pending` for clean ends |
| `noop` | State advanced, no external effect | Loop again |

### Signal types the LLM reports

| Status | Required fields | Used when |
|---|---|---|
| `success` | `output?` (for `bmad-code-review` MUST carry `findings[]` with `action: block\|patch\|defer`) | A phase completed |
| `failure` | `reason`, `diagnosis`, `recoverable` | A phase failed |
| `blocked` | `blocker_kind`, `details`, `user_input_needed` | Work cannot proceed |
| `propose_alternative` | `reason`, `alternative` (a full Action), `urgency_hint?` | The LLM wants to deviate from the planned action |
| `user_input` | `commands: UserCommand[]` | The human interjected (§14) |
| `verify_override` | `evidence: { explanation, decision_log_ref?, expected_paths? }` | Override a verifier rejection with justification |

Any signal may also carry `decisions[]` to log judgment calls into the decision log.

---

## 4. The Two-Layer Architecture: Pure FSM + Impure CLI Edge

The orchestrator is deliberately split so that all *decisions* are pure and testable, and all *effects* are isolated.

```
        ┌─────────────────────────────────────────────────────────────────┐
        │  IMPURE EDGE — _Sprintpilot/bin/autopilot.js (~5,300 lines)       │
        │                                                                   │
        │  cmdStart · cmdNext · cmdRecord · composeRuntimeState ·           │
        │  applySideEffects · decorate{GitOp,TestScope,ReviewDepth,Resume}  │
        │                                                                   │
        │  Reads sprint-status, runs git probes, executes scripts, writes   │
        │  ledger/state/decision-log, dispatches side effects.              │
        └───────────────┬─────────────────────────────▲────────────────────┘
                        │ (state, signal)              │ (newState, action, sideEffects)
                        ▼                              │
        ┌─────────────────────────────────────────────────────────────────┐
        │  PURE CORE — _Sprintpilot/lib/orchestrator/ (22 modules)          │
        │                                                                   │
        │  state-machine.js   phase enum + transition tables + nextAction   │
        │  adapt.js           interpretSignal / advanceState (signal → state)│
        │  verify.js          per-phase trust boundary                      │
        │  profile-rules.js   typed profile + budgets + escalation          │
        │  state-store.js     the single state-write chokepoint             │
        │  …                  git-plan, land, sprint-plan, divergence, …    │
        │                                                                   │
        │  No I/O. Deterministic. (state, input) → (newState, descriptors)  │
        └───────────────────────────────────────────────────────────────────┘
```

**Decide which layer a change belongs in before editing.** Decision logic goes in the pure core (and gets unit-tested with no fixtures on disk). I/O goes in the edge. The pure core returns *descriptors* of side effects (e.g. "append these decisions", "remove these plan stories"); the edge *executes* them. This is why the core can be exhaustively tested (2,200+ tests) without touching a filesystem or git.

> The big CLI file `bin/autopilot.js` is intentionally **not** in Biome's lint scope and is hand-formatted CommonJS. The pure `lib/orchestrator/` modules are CommonJS too; Biome lints `bin/**`, `lib/**` (the npm-installer lib, not the orchestrator), `_Sprintpilot/scripts/**`, `_Sprintpilot/lib/runtime/**`, and `tests/**`.

---

## 5. The State Machine (`state-machine.js`)

A pure finite-state machine defines the per-story lifecycle. Phases and their successors live in transition tables; `nextAction(state, profile)` maps the current phase to an action descriptor.

### Phases

```
PREPARE_STORY_BRANCH  CREATE_STORY  CHECK_READINESS  DEV_RED  DEV_GREEN
CODE_REVIEW  PATCH_APPLY  PATCH_RETEST  STORY_DONE  STORY_LAND  MERGE_EPIC
EPIC_BOUNDARY_CHECK  RETROSPECTIVE  SPRINT_FINALIZE_PENDING  NANO_QUICK_DEV
```

### Full flow (profiles `small` / `medium` / `large` / `legacy`)

```
PREPARE_STORY_BRANCH                    → git_op: create_branch
  → CREATE_STORY                        → invoke_skill: bmad-create-story
  → CHECK_READINESS                     → invoke_skill: bmad-check-implementation-readiness
  → DEV_RED                             → invoke_skill: bmad-dev-story (tdd_phase=red)
  → DEV_GREEN                           → invoke_skill: bmad-dev-story (tdd_phase=green)
  → CODE_REVIEW                         → invoke_skill: bmad-code-review
     ├─ findings include action=patch → PATCH_APPLY → PATCH_RETEST → (re-review or STORY_DONE)
     ├─ findings include action=block → user_prompt (stop for human)
     └─ otherwise                      → STORY_DONE
  → STORY_DONE                          → git_op: commit_and_push_story
  → STORY_LAND   (only if merge_strategy = land_as_you_go) → run_script: land_story
  → EPIC_BOUNDARY_CHECK
     ├─ end of epic + granularity=epic → MERGE_EPIC (git_op)
     ├─ retrospective_mode ≠ skip      → RETROSPECTIVE → invoke_skill: bmad-retrospective
     └─ more stories                   → PREPARE_STORY_BRANCH (next story)
  → SPRINT_FINALIZE_PENDING (terminal) → halt
```

### Nano flow (profile `nano`, `implementation_flow = quick`)

Collapses `CREATE_STORY … CODE_REVIEW` into one phase:

```
PREPARE_STORY_BRANCH → NANO_QUICK_DEV → STORY_DONE → STORY_LAND? → EPIC_BOUNDARY_CHECK → …
                       (bmad-quick-dev: Implement → Review → Classify → Commit)
```

Quality gates are preserved inside quick-dev's own review step. If quick-dev's tests fail or its severity classification is `high`, the session **escalates** to the full flow (§8.4).

### Skill mapping per phase

| Phase | BMad skill | Template slot |
|---|---|---|
| CREATE_STORY | `bmad-create-story` | — |
| CHECK_READINESS | `bmad-check-implementation-readiness` | — |
| DEV_RED | `bmad-dev-story` | `tdd_phase: red` |
| DEV_GREEN | `bmad-dev-story` | `tdd_phase: green` |
| CODE_REVIEW | `bmad-code-review` | — |
| PATCH_APPLY | `bmad-dev-story` | `tdd_phase: patch` |
| PATCH_RETEST | `bmad-dev-story` | `tdd_phase: rereview` |
| RETROSPECTIVE | `bmad-retrospective` | — |
| NANO_QUICK_DEV | `bmad-quick-dev` | — |

### Phase timeouts & session limits

`nextAction` is also where two halts are computed purely:

- **`session_story_limit_reached`** — when `session_stories_completed >= profile.session_story_limit` and the phase is a story-boundary phase (EPIC_BOUNDARY_CHECK, RETROSPECTIVE, PREPARE_STORY_BRANCH, CREATE_STORY, NANO_QUICK_DEV). The boundary gating prevents a mid-resume infinite loop.
- **`phase_timeout_exceeded`** — when `phase_started_at + profile.phase_timeout_minutes[phase] < now`, emitted as a `user_prompt`. Timeouts are per-profile and per-phase (§8.3); `legacy` disables them.

---

## 6. Signal Interpretation (`adapt.js`)

`adapt.js` is the pure bridge from a reported signal to a new state. Two functions matter:

- **`interpretSignal(state, signal, profile, verifyResult) → { newState, newProfile, nextAction, sideEffects, verdict }`** — routes on `signal.status` to a handler. `verdict` is one of `advanced` / `retry` / `prompted` / `halt`.
- **`advanceState(state, profile, newPhase, signal) → newState`** — the pure transition: resets per-phase counters, carries story identity forward, manages the story queue and the session counter.

### Handlers

| Handler | Behavior |
|---|---|
| `handleSuccess` | If `verifyResult.ok === false`, re-emit the same phase and count a verify rejection (with verify-loop detection); else advance. For CODE_REVIEW, blocking findings divert to a `user_prompt`. For nano, checks escalation triggers. |
| `handleFailure` | Increments `retry_count_this_phase`; threads `diagnosis` into the retry; on test phases inserts a **diagnostic pass** (verbose run, no retry consumed) before prompting; halts to the user when the retry budget is spent. |
| `handleBlocked` | The 5 **TRUE BLOCKERS** (`creative_user_input_required`, `new_external_dependency`, `security_architectural_decision`, `contradictory_acceptance_criteria`, plus consecutive test failures) always prompt the human. Recoverable kinds (e.g. `missing_dependency`) emit a remediation `run_script`. |
| `handleProposeAlternative` | Classifies impact (§16); `low` auto-accepts, otherwise stores the alternative and prompts. |
| `handleUserInput` | Applies validated `UserCommand`s via the pure applier (§14); may halt, dispatch a stored alternative, or re-derive the next action. |
| `handleVerifyOverride` | Re-runs verification with the LLM's evidence; accepts or falls through to failure. |

### Counters and boundaries

- **Per-phase counters** reset on every phase advance: `retry_count_this_phase`, `verify_reject_count`, `consecutive_identical_rejections`.
- **Verify-loop detection**: `verifyIssuesSignature(issues)` hashes the rejection; identical signatures across retries increment `consecutive_identical_rejections`, which enriches the eventual halt diagnostic.
- **Story-boundary clear**: only on `STORY_DONE → EPIC_BOUNDARY_CHECK`, the queue head is popped and `story_key` / `story_file_path` / `ac_summary` are cleared, so the just-finished story is never re-picked. `current_epic` is intentionally retained for the retrospective.
- **Session counter**: `session_stories_completed` increments once per story when entering EPIC_BOUNDARY_CHECK **from either** `STORY_DONE` (stacked) **or** `STORY_LAND` (land-as-you-go). Both merge strategies count exactly once — a subtlety that, when it regressed, let sessions blow past their story limit.

### Side-effect descriptors

`interpretSignal` never performs I/O; it returns an ordered `sideEffects` array the edge dispatches: `append_decisions`, `record_flaky_tests`, `profile_escalated`, `apply_user_commands`, `dispatch_action`, `plan_add_stories`, `plan_remove_stories`, `plan_reorder`, and the various `log_*` audit entries.

---

## 7. The CLI Edge (`bin/autopilot.js`)

The impure boundary. Public subcommands:

```
start  next  record  state  report  validate-config  status
progress  heartbeat  tasks  quarantine  watch  resume
```

The three that drive the loop:

### `cmdStart` — boot, lock, resume

1. Build an explicit queue from `--stories` / `--epic` (validated against sprint-status).
2. **Resume reconciliation** — detect divergence between persisted state and reality; auto-reconcile when sprint-status drifted; guard against clearing a `current_story` whose commit was never pushed.
3. **Land-as-you-go auto-recovery** — if the FSM drifted past an un-landed predecessor, rewind to its missing phase (§11).
4. Acquire the session lock (`lock.js`, §10.6), storing the session id so a crash doesn't brick the project.
5. Background full-suite gate, worktree health check, sprint-plan integration (§12), auto-derive gate.
6. `composeRuntimeState` → decorate → emit the first action.

### `cmdNext` — emit the next action

Composes runtime state and emits `nextAction`. A decoration pipeline enriches the raw action: `decorateHaltContext → decorateReviewDepth → decorateTestScope → decorateRunScript → decorateResumeHint → decorateGitOp`. These fill template slots (test scope/command, review depth, resume hint) and inline concrete git argv steps.

### `cmdRecord` — consume a signal, advance, dispatch

Parses the signal → runs `verify.js` (for `success`) → `adapt.interpretSignal` → `applySideEffects` → persists state → emits transition ledger entries → handles plan sync, background-suite spawn, coalesce flush, sprint-health metrics, and **boundary-story settlement** (re-resolving the next queue head when a transition cleared `story_key`, so the follow-up `next` isn't needed).

### `composeRuntimeState` — the most consequential function

It turns persisted YAML into the runtime state the FSM expects. It:

- picks the **fresh-sprint default phase** (`NANO_QUICK_DEV` for quick flow; `PREPARE_STORY_BRANCH` when git creates branches; else `CREATE_STORY`);
- validates the persisted `current_story` via **`persistedStoryRejectionReason`** (below), dropping poisoned values;
- consumes the **story queue**, filtering poisoned entries, popping the head at story-start phases;
- falls back to **`resolveNextStoryKey(projectRoot, { preferEpic })`** to scan sprint-status when the queue is empty;
- recomputes `remaining_stories_in_epic`, backfills `story_file_path` by convention, applies catch-all guards (reset to flow-start if a story-bound phase has no story), and computes the human-readable `next_summary`.

**Read this function before changing any resolver behavior.**

#### Story rejection reasons (`persistedStoryRejectionReason`)

A persisted or queued story key is rejected (→ `null`, falls through to re-resolution) when it:

1. is not a string;
2. matches an epic-rollup header shape (`epic-N` or bare `N`);
3. matches a retrospective-entry shape (`-retrospective`);
4. is in the Sprintpilot **exclusion ledger** (§10.3);
5. is absent from `sprint-status.yaml`;
6. has status `done` (skipped while inside the story-bound phases, where `done` is expected);
7. has a terminal-non-done status (`skipped`, `wont_do`, `cancelled`, `deferred`, `abandoned`, …);
8. is marked done in the sprint plan.

#### `applySideEffects`

Dispatches the descriptors from `adapt`: appends decisions, applies user commands (and records to the exclusion ledger for `skip_story` / `remove_from_sprint`), records flaky-test flips, logs escalations/rejections, and performs DAG-validated plan mutations (`plan_reorder`, `plan_add_stories`, `plan_remove_stories`). A plan operation that fails is surfaced as a `user_prompt` halt rather than silently dropped.

> `TERMINAL_STATUSES` is duplicated in `bin/autopilot.js` and `scripts/sprint-plan.js`; a mirror test asserts they stay in sync.

---

## 8. The Verification Trust Boundary (`verify.js`)

`verify.js` is the structural complement to `adapt.js`: before a `success` signal advances the machine, the verifier inspects the filesystem (and optional runner callbacks) to confirm the claim. It returns `{ ok, issues }`. It also **auto-recovers** omitted fields (a recurring user pain): if the LLM did the work but forgot to echo `story_file_path` or `test_files`, the verifier derives them by convention / git diff rather than rejecting.

### Per-phase verifiers

| Phase | What it checks |
|---|---|
| CREATE_STORY | Story file exists; YAML front-matter (or override); `## Acceptance Criteria` with ≥1 item; `## Tasks` with ≥1 checkbox |
| CHECK_READINESS | Front-matter declares readiness (`true/false/ready/blocked`) |
| DEV_RED | Test files exist (auto-detected if omitted); runner exits **non-zero** (tests genuinely failing); no source files changed (tests only) |
| DEV_GREEN | Runner exits 0; `tests_run` is a positive number (recovered from runner if omitted); post-green lint gates pass when `lint_blocking` |
| CODE_REVIEW | A review artifact exists (in the story file's "Review Findings", `_bmad-output/reviews/<key>.md`, or `code-review-<key>.md`); `findings[]` carry valid triage (`id`, `action ∈ {block,patch,defer}`, rationale) |
| PATCH_APPLY | Every expected `patch` finding from `state.patch_findings` was applied; `commit_sha` when present |
| PATCH_RETEST | Runner exits 0; `tests_run` positive |
| STORY_DONE | `commit_sha` + `branch` present; `git_steps_completed: true` **or** a git probe confirms (local commit == `origin/<branch>`); sprint-status shows the story `done`; **no `[ ]` tasks remain** |
| STORY_LAND | `git_steps_completed: true` **or** a probe confirms the sha is an ancestor of `origin/<base>` |
| RETROSPECTIVE | Retro artifact exists at `_bmad-output/retrospectives/<epic>.md` |
| NANO_QUICK_DEV | `tests_run` positive, `tests_failed` present, `commit_sha` present; sprint-status shows `done` |
| EPIC_BOUNDARY_CHECK | Structural only — always passes |

After `verify_reject_budget` consecutive rejections (per profile), the orchestrator pauses for the human. The LLM can override a rejection with `verify_override` carrying `evidence` (e.g. `expected_paths` for renamed tests, `decision_log_ref` for a deliberate exception) — handled by `verifyWithOverride`.

---

## 9. Profiles & Adaptive Process Scaling

A single `complexity_profile` reshapes the whole flow. It lives in `_Sprintpilot/modules/autopilot/config.yaml`; when absent, Sprintpilot defaults to **`medium`**.

### 9.1 Resolution (`resolve-profile.js` + `profile-rules.js`)

1. Read `complexity_profile` (or `--profile` override; missing → `medium` with a notice).
2. Load `profiles/<name>.yaml`. Deep-merge over `profiles/_base.yaml` — **unless** the profile sets `version_pinned` (only `legacy`), which stands alone so refactors can't drift it.
3. Overlay the user's module configs (`autopilot`, `git`, `ma`, `testing`).
4. `flatToProfile()` converts the flat YAML tree into a typed `Profile` object with coerced types and per-profile defaults.

### 9.2 What each profile changes

| Setting | nano | small | medium | large | legacy |
|---|---|---|---|---|---|
| `implementation_flow` | quick | full | full | full | full |
| `session_story_limit` | 5 | 3 | 3 | 3 | 3 |
| `retrospective_mode` | skip | auto | auto | stop | auto |
| `granularity` | epic | story | story | story | story |
| `worktree.enabled` | false | true | true | true | true |
| `squash_on_merge` | true | false | false | false | false |
| `parallel_stories` | false | false | false | **true** | false |
| `max_parallel_stories` | 2 | 2 | 2 | 3 | — |
| `state_sharding` | auto | auto | auto | **always** | never |
| `conditional_boot_work` | true | true | true | false | false |
| `phase_timings` | true | true | true | true | false |
| `coalesce_state_writes` | true | true | true | true | false |
| `testing.scope` | affected | affected | affected | affected | full |

`small` and `medium` are essentially `_base` (medium is the default). `large` turns on intra-epic parallelism and always-on state sharding and uses an interactive (`stop`) retrospective. `legacy` is a frozen v1.0.5 snapshot — no timings, no coalescing, full-suite every phase, direct (non-sharded) writes.

### 9.3 Budgets & timeouts (`profile-rules.js`)

| Profile | retry budget / action | verify-reject budget | phase timeouts |
|---|---|---|---|
| nano | 1 | 2 | quick_dev 15m, create/check 5m |
| small | 2 | 3 | dev_red 10m, dev_green 20m, review/patch 10m |
| medium | 2 | 3 | dev_red 15m, dev_green 30m, review/patch 15m |
| large | 3 | 3 | dev_red 30m, dev_green 60m, review/patch 30m |
| legacy | 2 | 3 | disabled (preserves v1.0.5) |

### 9.4 Nano → full escalation (`escalateOnFailure`)

Only `nano` escalates. When a `NANO_QUICK_DEV` success reports `tests_failed > 0` (and `fallback_on_tests_fail`) or `severity = high` (and `fallback_on_quick_dev_high_severity`), the profile is replaced in-memory with the `fallback_target` (default `small`), switched to `implementation_flow = full`, and budgets upgraded. **Escalation is session-scoped — never written back to config.** The next session starts fresh as `nano`. A `profile_escalated` side effect records the reason.

---

## 10. State & Persistence

All durable state lives in `_bmad-output/implementation-artifacts/`. Both `_bmad/` and `_bmad-output/` are **gitignored** — only Sprintpilot's source tree is tracked.

### 10.1 File ownership

| File | Owner | Notes |
|---|---|---|
| `sprint-status.yaml` | **BMad** | Sprintpilot only READS. A re-plan can reset values — hence the exclusion ledger. |
| `<story-key>.md` | **BMad** | Sprintpilot reads AC and tasks for verifiers. |
| `autopilot-state.yaml` | Sprintpilot | Volatile per-session state; deep-merged, never wholesale-replaced. |
| `git-status.yaml` | Sprintpilot | Git metadata (branch, sha, PR URL, push/lint status) via `sync-status.js`. |
| `ledger.jsonl` | Sprintpilot | Append-only audit. |
| `excluded-stories.json` | Sprintpilot | Durable exclusion ledger; replace-on-write. |
| `sprint-plan.yaml` | Sprintpilot | Dependency-aware plan, validated against the DAG. |
| `decision-log.yaml` | Sprintpilot | Per-phase decisions audit. |
| `flaky-quarantine.yaml` | Sprintpilot | Flaky-test flip counts + quarantine. |

### 10.2 `state-store.js` — the single state-write chokepoint

All writes to `autopilot-state.yaml` go through here. Two classes of keys:

- **CRITICAL_KEYS** (write-through, crash-recovery semantics): `current_story`, `current_bmad_step`, `in_worktree`, `patch_commits`, `story_queue`, `last_verify_issues_signature`, `consecutive_identical_rejections`.
- **Everything else** (buffered when `coalesce_state_writes: true`): accumulates per-story and flushes at the story boundary / session checkpoint / sprint complete.

Writes are **atomic** (write tmp sibling, `rename()`), with a prototype-pollution guard that drops `__proto__` / `constructor` / `prototype` segments. The merge is a **deep-merge that cannot delete a nested key** — which is precisely why removable ledgers (exclusions) are separate files with replace-on-write semantics.

### 10.3 `excluded-stories.json` — the authoritative exclusion ledger

A BMad re-plan re-detects a parked story's file and bumps its status back up the ladder, which would re-activate it. Sprintpilot's exclusion ledger is consulted **after** reading sprint-status, so external re-plans cannot resurrect a story the user skipped. Populated from `skip_story` / `remove_from_sprint` commands; `reconcileFromSprintStatus` folds terminal-non-done sprint-status values in at boot. JSON (not YAML) because removal needs clean replace semantics the state-store can't provide.

### 10.4 `ledger.jsonl` — append-only audit

One JSON object per line at `_bmad-output/implementation-artifacts/ledger.jsonl`. Each entry is `{ seq, ts, kind, … }`. Kinds span actions/signals/transitions (`action_emitted`, `signal_recorded`, `verify_result`, `state_transition`, `halt`, `resume`, `state_reconciled`), planning (`plan_*`), testing/observability (`test_scope_decision`, `review_depth_decision`, `worktree_health_check`), and resume (`phase_resumed`, `skill_checkpoint`). **Consumers tolerate unknown kinds** — add new ones freely. The reader skips a corrupt trailing line; the `tail` iterator is inode-aware (survives rotation).

### 10.5 Decision log & flaky quarantine

- `decision-log.yaml` — validated `DEC-NNN` entries `{ id, timestamp, story, phase, category, impact, decision, rationale }`. Categories: architecture, test-strategy, dependency, review-triage, review-accept, halt-recovery, scope, workaround.
- `flaky-quarantine.yaml` — tracks per-test `flip_count`; `recordFlip` increments, `promoteToQuarantineMaybe` moves a test to quarantine at the threshold (default 3 flips); quarantined tests are excluded from the affected-test scope until manually ejected (`autopilot quarantine`).

### 10.6 Concurrency primitives

- **`lock.js`** — a session mutex. The lock file's *existence* is the lock (atomic exclusive-create); contents are `<epoch-seconds>\n<session-id>`. No PID (unreliable under coding agents) and no LLM time-math. Stale locks (>30 min, with 60s clock-skew tolerance) are reclaimed; corrupt or non-regular lock files are treated as locked so an operator investigates.
- **State sharding** (`state-shard.js` + `merge-shards.js`) — for parallel stories, each story writes its own shard under `.autopilot-state/<story>.yaml` / `.decision-log/<story>.yaml` (single-writer per story). `merge-shards.js` collapses shards into the authoritative YAMLs under a cross-process lock, last-writer-wins by `updated_at.monotonic` (NTP-safe), falling back to `.wall`; corrupt shards are archived (never deleted); merges are idempotent. Shards use flat dotted-keys + JSON flow-form so they round-trip without a YAML parser dependency.

---

## 11. Git Workflow & Story Landing

The state machine emits *abstract* git ops (`create_branch`, `commit_and_push_story`, `merge_epic`); `git-plan.js` (pure) compiles them into a sequence of **pure argv steps** (`{ args, description, retry?, env?, tolerate_exit_codes?, optional? }`) that `run-step.js` executes via `execFileSync` — no shell, no interpolation, no injection surface.

### Branch naming & granularity

`branchName()` derives the branch from `granularity`:

- **story** (default): `<branch_prefix><sanitized-story-key>`, e.g. `story/1-2-user-auth`.
- **epic**: `<branch_prefix>epic-<epic-id>`; all stories in the epic commit to one branch → one PR per epic.

`reuse_user_branch` short-circuits creation and commits onto the user's pre-created branch. Long keys are truncated to `max_branch_length` (default 60) with an 8-char hash suffix to avoid collisions (`sanitize-branch.js` enforces a git-safe charset and `git check-ref-format`).

`planCreateBranch` is **idempotent**: an upstream probe sets `branch_exists`, choosing `git switch` (exists) vs `git switch -c <branch> <base>` (create).

### Commit & push

`stage-and-commit.js` stages **explicitly by name** — never `git add -A` / `.` / `-u`. It collects changes via `git diff --name-only HEAD` + `git ls-files --others --exclude-standard`, runs pre-commit checks (secrets heuristic, file-size, binary detection, `.gitignore` audit, story File-List variance), then `git add -- <files>`. Commit messages come from templates (`feat({epic}): {story-title} ({story-key})`). Pushes retry with jittered backoff on network errors. After the story commit, BMad artifacts under `_bmad-output/` are synced back to the base branch so `git log <base>` is the canonical sprint audit trail.

### Merge strategies

- **`stacked`** (default) — open a PR per story (or per epic under epic granularity; `create-pr.js` is idempotent so repeated pushes yield one PR). Epic merge happens at `MERGE_EPIC`.
- **`land_as_you_go`** — `land.js` lands each story immediately after `STORY_DONE`: open PR → snapshot the stack → wait for CI/review per `land_when` (`no_wait` / `ci_pass` / `ci_and_review`, up to `land_wait_minutes`) → merge (`squash_on_merge`?) → rebase the remaining stack. On `ff-only` divergence it auto-rebases; on conflict it prompts the human. A **predecessor guard** + **auto-recovery** ensure a new story never starts until the previous one is actually merged into the base.

### PRs across platforms (`create-pr.js`)

Auto-detects the platform CLI in priority order `gh → glab → bb → tea → git_only` (each probe time-boxed). GitHub/GitLab use their CLIs; Bitbucket/Gitea prefer their CLI and fall back to REST (token-gated). CI polling (`--mode checks`) is GitHub-only today; other platforms return SKIPPED so the orchestrator surfaces a manual `user_prompt`. Self-hosted hosts are threaded via `GH_HOST` / `GITLAB_URI` env. Path segments are validated and tokens redacted from logs.

### Worktree isolation

Each story can run in its own worktree at `.worktrees/<story-key>/` (a real `git worktree` linked to the story branch), so parallel stories don't collide. `dispatch-layer.js` creates the worktrees for a parallel layer (rolling back cleanly on partial failure); a boot-time health check flags orphans; `cleanup-worktrees.js` prunes them after an epic merges when `worktree_cleanup_on_merge`. If `git worktree add` fails, the flow degrades to a plain branch.

### Graceful degradation

`git.enabled: false` makes every git op emit empty `steps: []` (the LLM "succeeds" trivially). No remote → push/fetch steps are dropped. No platform CLI → PR creation is SKIPPED with manual guidance.

---

## 12. Sprint Planning & the Dependency DAG

Sprintpilot can run stories in a plain sprint-status order, or in a **dependency-aware plan**.

### `sprint-plan.yaml`

Owned by Sprintpilot, validated against the DAG. Per-story entries carry `key`, `epic`, `title`, `bmad_status` (cached from sprint-status), `plan_status` (`pending` / `done` / `skipped` / `excluded`), `issue_id` (tracker linkage), `priority`, and dependency edges. `refreshBmadStatus` syncs the `bmad_status` cache from sprint-status and eagerly transitions a story to `done` when its bmad status becomes terminal (`TERMINAL_BMAD_STATUSES`, mirrored from the resolver). All read-modify-write mutators (`markDone`, `addStories`, `removeStories`, `reorder`, …) take the `plan.lock` to serialize concurrent writers. `composePlanQueue` yields pending stories ordered by priority; `shouldAutoDerive` decides whether to invoke `/sprintpilot-plan-sprint` (stale/greenfield); `planExhausted` halts when every story is terminal.

### `resolve-dag.js`

Builds the DAG with a strategy precedence (explicit `depends_on` + `force_sequential` chains > positional ordering), folds in `cross_epic_deps`, applies `force_independent` overrides, then runs **Kahn's algorithm** for topological layers and cycle detection. `validateOrdering` rejects a proposed reorder if any story is placed before an unsatisfied upstream (unless that upstream is already terminal). It renders the DAG to Mermaid (default) or Graphviz with per-status colors and dashed cross-epic edges.

### `infer-dependencies.js`

Produces a scaffold prompt for the LLM to infer edges (per-epic and cross-epic), then validates the returned JSON envelope strictly: keys must exist in sprint-status, no self-deps, rationale required, cross-epic edges must actually cross epics, and the combined graph must be acyclic. Valid edges are merged into `sprint-plan.yaml`. It also migrates the legacy `dependencies.yaml` format.

### `list-remaining-stories.js`

The indent-agnostic, shape-tolerant parser for BMad's `sprint-status.yaml`. `parseStatuses` handles dict/list/inline/block shapes; `remainingFrom` filters non-`done`; `looksLikeStoryKey` rejects epic-rollup and retrospective entries. This is the shared truth for "what stories exist and what's their status."

---

## 13. Multi-Agent & Parallelism

- **`dispatch-layer.js`** plans a parallel layer: it dedupes keys, caps concurrency at `max_parallel_stories`, creates a worktree + branch per dispatched story, and writes `.layer-plan.json`. It does **not** call any LLM — the host workflow reads the plan and spawns one sub-agent per worktree. (At the state-machine emission level, story emission remains sequential in this build; the NOTICE you may see — `ma.parallel_stories=true honored at the dispatch-layer level` — reflects exactly that.)
- **`parallel-batch.js`** composes a `parallel_batch` action (concurrency capped by profile and host capability; degrades to sequential when either is unavailable) and classifies aggregated child results (all-success / any-blocked / any-failure).
- **Background full suite** (`background-suite.js` + worker) — when `testing.full_suite_on_story_land: background`, a **detached, unref'd** subprocess runs the full suite after `STORY_DONE` and writes a sidecar JSON (status, exit code, log tail). It keeps running even if the session exits. `checkPriorRun` halts the **next** story's start if the prior suite failed and wasn't acknowledged. The alternatives are `ci` (trust `gh pr checks`) and `skip`.

Parallelism config lives in `modules/ma/config.yaml` (`parallel_stories`, `max_parallel_stories`, conflict thresholds, the experimental `parallel_epics` gated on `preflight-merge.js` reporting no cross-epic conflicts).

---

## 14. User Commands

The human can steer a run mid-flight. Interjections become a `user_input` signal carrying `commands: UserCommand[]`, validated by `user-commands.js` and applied by the **pure** `user-command-applier.js`: `apply(state, profile, commands) → { newState, newProfile, sideEffects }` (it touches only runtime state, never BMad's sprint-status; the edge runs the side effects).

| Command | Effect |
|---|---|
| `skip_story` | Drop the current story → next story start; record an exclusion |
| `remove_from_sprint` | Mark stories `skipped`/`deferred` in the plan; record exclusions |
| `add_to_sprint` | Add stories to the plan (validated against sprint-status) |
| `reorder_queue` | DAG-validated reorder of the plan |
| `replan_sprint` | Halt + invoke `/sprintpilot-plan-sprint`, preserving focus/scheduling intent |
| `change_profile` | Session-scoped profile change; re-seed budgets |
| `trigger_retrospective` | Force-route to RETROSPECTIVE |
| `force_continue` | Clear retry/verify counters and any pending alternative |
| `accept_alternative` | Dispatch a previously proposed alternative action |
| `override_decision` | Log an override of a prior decision (no state change) |
| `abort_sprint` | Halt; mark the sprint complete |
| `pause` | **Human-only** — set `halt_requested`; the orchestrator halts on the next turn |

---

## 15. Resume, Divergence & Recovery

Sprintpilot is built to be interrupted.

- **Resume mid-skill** (`resume-context.js`) — on `start`, the ledger is walked for an `invoke_skill` with no terminal entry after it (the skill was interrupted). A structured `resume_hint` is built: phase, elapsed minutes, the last `skill_checkpoint`, changed files since the phase started (capped), completed vs. total AC, last test result, patches landed. Long skills emit non-terminal checkpoints via `signal.output.checkpoint` so a resume picks up where they left off.
- **Divergence detection** (`divergence.js`) — a fingerprint of the world (sprint-status SHA, `_bmad-output/` tree, per-story branch HEADs, active worktrees) is captured at each halt. On resume, the current fingerprint is diffed against the baseline; a mismatch prompts the user with the exact differences. Heavy directories (`node_modules`, `.venv`, caches) and binary suffixes are pruned, with a hard 5,000-entry cap.
- **Land-as-you-go recovery** (`bin/autopilot.js`) — at a fresh story start under `land_as_you_go`, if the previous story was committed but never landed, the FSM rewinds to its missing phase (STORY_DONE or STORY_LAND) and records `state_reconciled` + `resume` ledger entries.

---

## 16. Observability

- **Phase timings** (`log-timing.js` / `summarize-timings.js`) — when `phase_timings: true`, per-story JSONL shards under `.timings/` record start/end events (interrupt-safe `mark` API with clock-skew and stale-marker anomaly flags). `summarize-timings` aggregates per-phase count / p50 / p95 / max and flags hotspots (>5% of total).
- **Sprint health** (`sprint-health.js`) — pure metrics from the ledger (stories completed, halts, verify rejections, retry rate, escalations, flaky tests, review-depth distribution, average phase minutes) appended idempotently to the per-epic retrospective.
- **Halt explainer** (`halt-explainer.js`) — enriches every `user_prompt` with recent actions, the last failed verifier check, elapsed-in-phase, and a pointer to a similar prior halt — so a human interruption arrives with context, not just a question.
- **Change-size classifier** (`change-size-classifier.js`) — classifies the diff (`trivial` / `normal` / `structural`) from `git diff --numstat`/`--name-status` plus structural signals (schema/migration, barrel index, dependency-manifest version edits, renames) and routes CODE_REVIEW to a proportional reviewer-layer count.
- **Impact classifier** (`impact-classifier.js`) — rates a `propose_alternative` `low` / `medium` / `high` (type change → high; skill/op change → medium; whitelisted args → low; `urgency_hint` can only raise). `low` auto-accepts; otherwise the human is asked.
- **Report** (`report.js`) + **`status` / `progress` / `watch`** subcommands render session state, ledger summaries, and a live tail for shell prompts and monitoring.
- **Heartbeats** — during long phases the LLM emits `autopilot heartbeat --message "<one-line status>"` (factual present-tense progress) every ~10 minutes, plus a portable `sprint-tasks.md` and the host's native task list after every transition.

---

## 17. Skills Sprintpilot Ships

Installed under `_Sprintpilot/skills/` (and into each tool's skills directory by `bin/sprintpilot.js install`):

| Skill | Purpose |
|---|---|
| `sprint-autopilot-on` | Engage autonomous execution: the orchestrator loop + git workflow. The LLM-facing contract is `workflow.orchestrator.md` — its sole authority. |
| `sprint-autopilot-off` | Disengage; print a sprint + git status report. |
| `sprintpilot-plan-sprint` | Build/refresh the DAG-aware plan (per-epic + cross-epic deps); curate stories; write `sprint-plan.yaml`. |
| `sprintpilot-sprint-progress` | Read-only diagnostic over `autopilot progress`; classify health (HEALTHY/STALLED/NEEDS-INPUT/EXHAUSTED/NO-PLAN) and suggest one next action. |
| `sprintpilot-dependency-graph` | Read-only DAG renderer (mermaid/graphviz/text/layers/json). |
| `sprintpilot-codebase-map` | 5-agent brownfield mapping (stack, architecture, quality, concerns, integrations). |
| `sprintpilot-assess` | 3-agent tech-debt assessment (dependency audit, debt classification, migration analysis). |
| `sprintpilot-reverse-architect` | 3-agent architecture extraction from existing code. |
| `sprintpilot-migrate` | 4-agent, 12-step migration planning (current → target stack). |
| `sprintpilot-research` | Parallel research fan-out with web search. |
| `sprintpilot-update` | In-IDE update flow. |

All multi-agent skills follow the same pattern: prepare context → launch N agents in one message → each agent gets inlined instructions (sub-agents can't invoke Skills) → collect → triage/synthesize.

---

## 18. Survivability & System-Prompt Enforcement

Sprintpilot must survive BMad upgrades, re-plans, and re-installs:

| Concern | Protection |
|---|---|
| A BMad update overwrites skills | Sprintpilot skills use `sprint-autopilot-*` / `sprintpilot-*` prefixes, absent from BMad's skill manifest |
| A BMad re-plan reactivates a parked story | The Sprintpilot-owned exclusion ledger is consulted after sprint-status |
| Source files modified | Source lives under `_Sprintpilot/`, never touched by BMad |
| Need to re-install | `npx @ikunin/sprintpilot@latest` restores everything |

**System-prompt enforcement** makes every agent session BMad-aware from the first message. A self-sufficient enforcement block (mandatory step sequence, git rules, autopilot commands) is wrapped in `<!-- BEGIN:sprintpilot-rules -->` / `<!-- END:sprintpilot-rules -->` markers so the installer can update it without touching user content. It's inlined (not `@include`d) because non-Claude tools can't include files. Per tool: Claude Code uses `CLAUDE.md → @AGENTS.md`; own-file tools (Cursor, Roo, Kiro, Trae) get a dedicated rules file; append tools (Windsurf, Cline, Gemini CLI, Copilot) get the block appended to their shared prompt.

---

## 19. Artifact Reference

Everything under `<project-root>/_bmad-output/implementation-artifacts/`:

```
autopilot-state.yaml          Sprintpilot — volatile session state (deep-merged, atomic)
ledger.jsonl                  Sprintpilot — append-only audit trail
excluded-stories.json         Sprintpilot — durable exclusion ledger (replace-on-write)
sprint-plan.yaml              Sprintpilot — dependency-aware plan (DAG-validated)
decision-log.yaml             Sprintpilot — DEC-NNN decision audit
git-status.yaml               Sprintpilot — branch / sha / PR / push / lint metadata
flaky-quarantine.yaml         Sprintpilot — flaky-test flip counts + quarantine
sprint-tasks.md               Sprintpilot — portable per-story task list (visibility)
sprint-status.yaml            BMad        — story statuses (Sprintpilot reads only)
<story-key>.md                BMad        — story spec (AC + tasks; read by verifiers)

.autopilot-state/<story>.yaml State shards (parallel mode)
.decision-log/<story>.yaml    Decision shards (parallel mode)
.pending/…                    Coalesced (buffered) non-critical writes
.timings/<story>.jsonl        Per-phase timing events
.background-suite/<story>.{json,log}  Background full-suite sidecar + log
.layer-plan.json              Parallel dispatch plan
.archive/                     Archived plans, corrupt shards, migrated legacy files
```

Locks: `.autopilot.lock` (session), `.sprintpilot/plan.lock` (plan), `.merge-shards.lock` (shard merge).

---

## 20. Quick Reference

- **Entry points:** `npx @ikunin/sprintpilot@latest install …` (setup) → `/sprint-autopilot-on` (run).
- **Orchestrator CLI:** `_Sprintpilot/bin/autopilot.js {start,next,record,state,report,validate-config,status,progress,heartbeat,tasks,quarantine,watch,resume}`.
- **Pure core:** `_Sprintpilot/lib/orchestrator/` (22 modules; fully unit-tested).
- **Helper scripts:** `_Sprintpilot/scripts/` (zero runtime deps).
- **Profiles:** `_Sprintpilot/modules/autopilot/profiles/` (`_base` + `nano/small/medium/large/legacy`).
- **Tests:** `cd tests && npm test` (2,200+ unit + integration; LLM e2e gated behind `RUN_LLM_E2E`).
- **The TRUE BLOCKERS** (the only legitimate autonomous stops): `creative_user_input_required`, `new_external_dependency`, `security_architectural_decision`, `contradictory_acceptance_criteria`, `consecutive_test_failures`.

### Related documents

- [Configuration Reference](CONFIGURATION.md) — every git/lint/push/PR/worktree/lock/platform setting
- [Adaptive Process Scaling](adaptive-process-scaling.md) — the profile concept and rollout
- [Usage Guide](USAGE.md) · [Installation](INSTALLATION.md) · [Extending](EXTENDING.md) · [Contributing](CONTRIBUTING.md)
- [AGENTS.md](../AGENTS.md) — the in-sprint runtime contract · [CLAUDE.md](../CLAUDE.md) — developing on Sprintpilot
```
