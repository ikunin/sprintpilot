# Sprintpilot — ON (Orchestrator Mode)

You are running under the **orchestrator-driven** autopilot. Flow control is
owned by `_Sprintpilot/bin/autopilot.js` — a deterministic Node.js
state machine that enforces the BMad 7-step sequence. You own the
*in-skill execution, diagnosis, triage, and small-judgment decisions* —
not the flow.

This file is the **≤150-line** authoritative workflow. It is the only
workflow shipped — the v2.0.x prose `workflow.md` is gone.

## The loop

Repeat until the orchestrator emits `halt`:

1. `node _Sprintpilot/bin/autopilot.js next` → JSON Action.
2. Execute the Action per the dispatch table below.
3. While executing, scan the host chat for user interjections. If
   present, record them via a `user_input` signal (step 4) and re-loop.
4. `node _Sprintpilot/bin/autopilot.js record --signal <json>` → JSON
   `{ action, verdict, phase, profile }`. Use the new action.
5. If `verdict: prompted` → ask the user the question in `action.prompt`.
   Apply their answer as a `user_input` signal and re-loop.
6. If `action.type: halt` → STOP. The orchestrator already wrote
   resume state and (when relevant) the fresh-context handoff flag.

Never improvise. Never skip a step. Never invent a next action: the
orchestrator emits it.

## Action dispatch

| `action.type`     | What you do                                                                                      |
|-------------------|--------------------------------------------------------------------------------------------------|
| `invoke_skill`    | Run the named BMad skill **verbatim from its own body** (e.g. `bmad-create-story`, `bmad-quick-dev`, `bmad-code-review`). `action.template_slots` is a parameter bag (story_key, prior_diagnosis, relevant_decisions, prior_signals_summary, …) — it's input context for BMad's skill, NOT a replacement for the skill's instructions. When `implementation_flow=quick`, you'll receive `invoke_skill: bmad-quick-dev` per story — follow BMad's `step-oneshot.md`. |
| `run_script`      | Execute `action.command` via the host's shell-equivalent. Argv-only — no shell interpolation.    |
| `git_op`          | Execute `action.steps` in order. The orchestrator pre-plans every git op (commit_and_push_story, merge_epic, push, fetch, create_branch) via `git-plan.js` and inlines the resulting argv sequence — each step has `args: [cmd, ...argv]`, a `description`, and optional metadata fields (see below). **Required**: run each step via `_Sprintpilot/scripts/run-step.js` (see "Step metadata" below) so the metadata contract is enforced uniformly. Argv-only — NO shell interpolation. Halt on first non-retryable failure. Never improvise the git commands or skip a step — `git push` lives in `steps`, not in `op`. Empty `steps: []` (e.g. when `git.enabled: false`) means "no work, signal success." |
| `parallel_batch`  | Dispatch each child action concurrently (M6+ hosts only — fall back to sequential otherwise).    |
| `user_prompt`     | Ask the user `action.prompt`. Pass the answer back via `user_input` signal.                      |
| `halt`            | Stop. Honor `action.handoff: 'sprint_finalize_pending'` by ending the session cleanly.           |
| `noop`            | Re-loop (state machine advancing without an external effect).                                    |

### Step metadata (git_op / run_script)

Each step in `action.steps` may carry these optional fields. They are
NOT defaults — only honor them when present:

| Field | Meaning |
|---|---|
| `retry` | `{ attempts: N, backoff_ms: [...], on: 'network' \| 'never' }`. Retry transient errors per the policy. `on: 'network'` covers e.g. `git push` to a flaky remote. |
| `optional: true` | Run the step; on non-zero exit, log a warning and **continue** to the next step rather than halting. Used for best-effort prefetches and pulls. |
| `tolerate_exit_codes: [N, M, ...]` | Treat any of these exit codes as success (equivalent to exit 0 for halt-detection). Used for idempotent commands like `gh pr merge` (which exits non-zero when the PR is already merged) and `create-pr.js` (which returns exit 2 SKIPPED when the platform CLI is unavailable). |
| `env: { KEY: "value", ... }` | Set environment variables for this step's process only (merged on top of inherited env). Used to target self-hosted platform instances: `GH_HOST` for GitHub Enterprise, `GITLAB_URI` for self-hosted GitLab. |
| `description` | Human-readable summary, surface in your own logs. |

**Use the runner — direct argv execution is not equivalent.** A step
that carries ANY of `retry`, `optional`, `tolerate_exit_codes`, or
`env` MUST be executed via `_Sprintpilot/scripts/run-step.js`. The
runner is the source of truth for the metadata contract; honoring
those fields by hand drifts and loses retries, env scoping, and
exit-code tolerance. Direct execution is only acceptable for steps
that have none of those fields.

```
echo '<step-json>' | node _Sprintpilot/scripts/run-step.js
```

Path resolution: the orchestrator runs from the project root, so the
relative path `_Sprintpilot/scripts/run-step.js` is correct in normal
invocations. If running from a different cwd (e.g. a worktree
subdirectory), resolve the absolute path from the autopilot's
`--project-root` argument.

When you signal `success` after a `git_op`, include `git_steps_completed: true` only if every step ran via the runner (or hand-executed in a way equivalent to it) and either exited 0 or matched its `tolerate_exit_codes`. A step that needed `optional: true` to pass still counts as not-completed for stricter sub-steps' purposes; `git_steps_completed` reflects the strict run.

## Signals you emit

Wrap everything in `{ "status": "...", ... }` and pass to
`autopilot record --signal '<json>'`. Optional `decisions[]` on any signal.

| `status`              | Required fields                                                                                  |
|-----------------------|--------------------------------------------------------------------------------------------------|
| `success`             | `output?: object` (for `bmad-code-review` MUST include `findings[]` with `action: 'block'\|'patch'\|'defer'`); `next_skill_hint?` |
| `failure`             | `reason`, `diagnosis` (first-class — fed back into next retry), `recoverable: boolean`           |
| `blocked`             | `blocker_kind` (one of the 5 TRUE BLOCKERS or recoverable kinds), `details`, `user_input_needed`, `consecutive_count?` |
| `propose_alternative` | `reason`, `alternative` (full Action object), `urgency_hint?` (raises impact only). Low impact → auto-accepted; medium / high → orchestrator stores the alternative in `state.pending_alternative` and emits `user_prompt`. The user accepts via `user_input` `{ kind: 'accept_alternative' }` or rejects via `force_continue` (both clear `pending_alternative`). |
| `user_input`          | `commands: UserCommand[]` (validated server-side; see user-commands.js). Kinds: `skip_story`, `abort_sprint`, `force_continue`, `override_decision`, `change_profile`, `pause` (cleanly halts THIS session; next `/sprint-autopilot-on` resumes), `accept_alternative` (dispatches the stored `pending_alternative`). |
| `verify_override`     | `evidence: { decision_log_ref?, explanation, expected_paths? }` — used when verify.js is wrong   |

## TRUE BLOCKER kinds (per AGENTS.md)

`creative_user_input_required`, `new_external_dependency`,
`consecutive_test_failures` (carry `consecutive_count`),
`security_architectural_decision`, `contradictory_acceptance_criteria`.

Plus recoverable kinds the orchestrator handles deterministically:
`missing_dependency`, `failed_invariant`, `external_service`, `unknown`.

## Decision audit channel

Include `decisions[]` on ANY signal to log small judgment calls without
round-tripping through `propose_alternative`. Each entry has
`category` (one of: architecture, test-strategy, dependency,
review-triage, review-accept, halt-recovery, scope, workaround), `impact`
(low/medium/high), `phase` (e.g. `dev-story:RED`), `decision`, and
`rationale`. The orchestrator stamps id + timestamp + story
automatically and appends to `decision-log.yaml`.

## Code-review triage

When `bmad-code-review` completes, `success.output.findings[]` MUST
classify each finding:

- `action: 'block'`   → orchestrator pauses the autopilot. Manual decision required.
- `action: 'patch'`   → orchestrator enters PATCH_APPLY (step 6a) then PATCH_RETEST (step 6b).
- `action: 'defer'`   → recorded but not blocking; story proceeds.

This is LLM intelligence the orchestrator routes on — you own the triage.

## BMad bookkeeping is enforced

`verify.js` checks more than artifact existence — it enforces the BMad
bookkeeping you'd otherwise be tempted to skip:

| Phase | Bookkeeping that MUST be true before you signal `success` |
|---|---|
| `prepare_story_branch` | Every step in `action.steps` exited 0 — HEAD is on `action.branch` (verify with `git rev-parse --abbrev-ref HEAD`). Emitted only when `git.granularity ∈ {story, epic}` AND `git.reuse_user_branch=false`. Under `reuse_user_branch=true` this phase is skipped — the user-locked branch is detected at cmdStart instead. |
| `create_story` | Story file has `## Acceptance Criteria` (≥1 bullet) AND a `## Tasks` (or `## Tasks/Subtasks`) section with at least one `[ ]` or `[x]` checkbox. |
| `dev_red` / `dev_green` | Test files exist on disk; runner exit codes match the phase contract; `tests_run` matches the runner's count. |
| `code_review` | `_bmad-output/reviews/<story_key>.md` exists; `findings[]` carries `{id, severity, category, action: 'block'\|'patch'\|'defer', rationale}` for every finding. |
| `patch_apply` | Every `patch_finding` id present in `state.patch_findings` is included in `applied_finding_ids`. |
| `story_done` (and `nano_quick_dev`) | sprint-status.yaml shows this story as `done` (under `development_status.<story_key>` or inline). Story file has zero remaining `[ ]` task boxes — dev-story is responsible for flipping them to `[x]`. `commit_sha` and `branch` reported; `story_key` matches. **`git_steps_completed: true` in success output** — set this ONLY after every step in `action.steps` (the orchestrator's decorated git plan: `git add`, `git commit`, `git push -u origin <branch>`) has exited 0. Skipping `git push` and reporting success leaves the branch unpushed and trips this check. |
| `retrospective` | `_bmad-output/retrospectives/<epic>.md` exists. |

Skipping any of these — even when the code is "obviously done" — produces
`verify_rejected` in the ledger and the orchestrator re-emits the same
action with the verifier's issues threaded into the template slot. After
the per-profile `verify_reject_budget` is exhausted, the session pauses
for the user.

If you're confident verify is wrong (e.g. you renamed a test file per a
logged decision), emit `verify_override` with `evidence.expected_paths`
and a `decision_log_ref`. The orchestrator re-runs verify with augmented
expectations.

After N consecutive verify rejections on the same state (profile-
configured budget), the orchestrator escalates to `user_prompt`.

## Git workflow knobs

These knobs in `_Sprintpilot/modules/git/config.yaml` change what the
orchestrator emits as `git_op` / `run_script` actions. Always read them
from the action payload — do NOT improvise.

| Knob | Values | Behavior |
|---|---|---|
| `granularity` | `story` (default) / `epic` | Per-unit branch creation (default). Suppressed when `reuse_user_branch=true`. |
| `reuse_user_branch` | `false` (default) / `true` | If `true`, autopilot detects the current non-base branch on boot and commits **every** story onto it. No `story/*` or `epic/*` branches are created. PR is opened from this branch at sprint-end. |
| `merge_strategy` | `stacked` (default) / `land_as_you_go` | `stacked` keeps every story-branch open until sprint-end. `land_as_you_go` runs the new `STORY_LAND` state right after STORY_DONE to merge the PR immediately. |
| `land_when` | `no_wait` / `ci_pass` (default) / `ci_and_review` | Under `land_as_you_go`, when to merge: synchronously, after CI is green, or after CI + an approved review. |
| `land_wait_minutes` | int (default 30) | Max wait for CI / review under `land_as_you_go`. After this the orchestrator halts and prompts. |

On `STORY_LAND` rebase conflicts (base moved during the story), the
orchestrator auto-rebases the story branch onto latest base. If the
rebase has conflicts, the orchestrator halts with a `user_prompt`. You
resolve conflicts manually, then resume autopilot — it retries the
land step from `state.land_pending`.

## Resume

On the next `autopilot start`, the orchestrator fingerprints
`_bmad-output/`, sprint-status.yaml, and per-story branch HEADs against
the fingerprint recorded at the last halt. Any divergence is emitted as
`{ kind: 'resume_divergence', differences: ... }`. Forward the diff to
the user; let them resolve via `user_input` (`force_continue` or
`override_decision`).

## What you must NEVER do

- Decide the next BMad step yourself; skip step-6 patch loop; auto-accept
  your own `propose_alternative`; write `autopilot-state.yaml` /
  `ledger.jsonl` directly; commit secrets; use `git push --no-verify`;
  drift from the typed Signal schema.
