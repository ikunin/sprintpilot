# Sprintpilot — ON (Orchestrator Mode)

You are running under the **orchestrator-driven** autopilot. Flow control is
owned by `_Sprintpilot/bin/autopilot.js` — a deterministic Node.js
state machine that enforces the BMad 7-step sequence. You own the
*in-skill execution, diagnosis, triage, and small-judgment decisions* —
not the flow.

This file is the **≤150-line** replacement for the legacy
`workflow.md`. It is only consulted when
`autopilot.execution_mode: orchestrator` in `modules/autopilot/config.yaml`
(the v2.1+ default). Until that flips, the legacy 1,388-line prose
workflow remains authoritative.

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
| `invoke_skill`    | Run the named BMad skill. Pass `action.template_slots` as context — DO read `prior_diagnosis`, `relevant_decisions`, and `prior_signals_summary`. |
| `run_script`      | Execute `action.command` via the host's shell-equivalent. Argv-only — no shell interpolation.    |
| `git_op`          | Perform `action.op` (commit_and_push_story, merge, etc.) per `action.profile`'s git policy.      |
| `parallel_batch`  | Dispatch each child action concurrently (M6+ hosts only — fall back to sequential otherwise).    |
| `user_prompt`     | Ask the user `action.prompt`. Pass the answer back via `user_input` signal.                      |
| `halt`            | Stop. Honor `action.handoff: 'sprint_finalize_pending'` by ending the session cleanly.           |
| `noop`            | Re-loop (state machine advancing without an external effect).                                    |

## Signals you emit

Wrap everything in `{ "status": "...", ... }` and pass to
`autopilot record --signal '<json>'`. Optional `decisions[]` on any signal.

| `status`              | Required fields                                                                                  |
|-----------------------|--------------------------------------------------------------------------------------------------|
| `success`             | `output?: object` (for `bmad-code-review` MUST include `findings[]` with `action: 'block'\|'patch'\|'defer'`); `next_skill_hint?` |
| `failure`             | `reason`, `diagnosis` (first-class — fed back into next retry), `recoverable: boolean`           |
| `blocked`             | `blocker_kind` (one of the 5 TRUE BLOCKERS or recoverable kinds), `details`, `user_input_needed`, `consecutive_count?` |
| `propose_alternative` | `reason`, `alternative` (full Action object), `urgency_hint?` (raises impact only)               |
| `user_input`          | `commands: UserCommand[]` (validated server-side; see user-commands.js)                          |
| `verify_override`     | `evidence: { decision_log_ref?, explanation, expected_paths? }` — used when verify.js is wrong   |

## TRUE BLOCKER kinds (per AGENTS.md)

`creative_user_input_required`, `new_external_dependency`,
`consecutive_test_failures` (carry `consecutive_count`),
`security_architectural_decision`, `contradictory_acceptance_criteria`.

Plus recoverable kinds the orchestrator handles deterministically:
`missing_dependency`, `failed_invariant`, `external_service`, `unknown`.

## Decision audit channel

Include `decisions[]` on ANY signal to log small judgment calls without
round-tripping through `propose_alternative`. Each decision:

```json
{
  "category": "test-strategy",        // architecture | test-strategy | dependency | review-triage | review-accept | halt-recovery | scope | workaround
  "impact": "low",                    // low | medium | high
  "phase": "dev-story:RED",
  "decision": "use vitest for new tests",
  "rationale": "matches repo convention"
}
```

The orchestrator stamps id + timestamp + story automatically and appends
to `_bmad-output/implementation-artifacts/decision-log.yaml`.

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
| `create_story` | Story file has `## Acceptance Criteria` (≥1 bullet) AND a `## Tasks` (or `## Tasks/Subtasks`) section with at least one `[ ]` or `[x]` checkbox. |
| `dev_red` / `dev_green` | Test files exist on disk; runner exit codes match the phase contract; `tests_run` matches the runner's count. |
| `code_review` | `_bmad-output/reviews/<story_key>.md` exists; `findings[]` carries `{id, severity, category, action: 'block'\|'patch'\|'defer', rationale}` for every finding. |
| `patch_apply` | Every `patch_finding` id present in `state.patch_findings` is included in `applied_finding_ids`. |
| `story_done` (and `nano_quick_dev`) | sprint-status.yaml shows this story as `done` (under `development_status.<story_key>` or inline). Story file has zero remaining `[ ]` task boxes — dev-story is responsible for flipping them to `[x]`. `commit_sha` and `branch` reported; `story_key` matches. |
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

## Resume

On the next `autopilot start`, the orchestrator fingerprints
`_bmad-output/`, sprint-status.yaml, and per-story branch HEADs against
the fingerprint recorded at the last halt. Any divergence is emitted as
`{ kind: 'resume_divergence', differences: ... }`. Forward the diff to
the user; let them resolve via `user_input` (`force_continue` or
`override_decision`).

## What you must NEVER do

- Decide the next BMad step yourself.
- Skip BMad steps. Step 6 patch loop is a first-class state pair; never
  inlined into `bmad-code-review`.
- Auto-accept a `propose_alternative` you submitted. Orchestrator decides.
- Write `_Sprintpilot/manifest.yaml`, `autopilot-state.yaml`, or
  `ledger.jsonl` directly. Route writes through the CLI.
- Commit secrets, skip `git push` retries, or use `--no-verify`.
- Drift from the typed Signal schema. The orchestrator validates every
  field; malformed signals exit non-zero.
