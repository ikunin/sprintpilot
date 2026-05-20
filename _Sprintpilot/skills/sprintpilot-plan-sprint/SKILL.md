---
name: sprintpilot-plan-sprint
description: 'Build (or refresh) the Sprintpilot sprint plan at _bmad-output/implementation-artifacts/sprint-plan.yaml. Infers per-epic + cross-epic dependencies from epics.md + architecture.md + sprint-status.yaml, presents the DAG, lets the user curate which stories belong in the active plan, and persists the result. Triggered by /sprintpilot-plan-sprint, by the autopilot when a stale plan is detected, or by `replan_sprint` mid-flight. Replaces the manual `infer-dependencies.js` workflow for end users.'
---

## STOP — read this entire file before doing anything

This skill writes the authoritative sprint plan at
`_bmad-output/implementation-artifacts/sprint-plan.yaml`. The plan
controls which story Sprintpilot runs next and in what order, with
dependency-aware priorities and optional external-tracker links.

Follow **`./workflow.md`** verbatim. The 14 steps it lists are not
suggestions — each one shells out to a primitive (`infer-dependencies.js`,
`resolve-dag.js`, `sprint-plan.js`) that validates inputs and updates
the plan atomically. Skipping a step or reordering them produces an
inconsistent plan that downstream phases (autopilot queue resolver,
reorder validator) will reject.

### Never improvise

- Never infer dependencies in chat — always pipe LLM JSON through
  `node _Sprintpilot/scripts/infer-dependencies.js dry-run --epic <id>`
  (or `--cross-epic`) first. The script enforces schema, unknown-key,
  self-dep, cross-epic-isolation, missing-rationale, and cycle checks.
  Hand-edited envelopes that bypass dry-run leave a plan that fails
  validation on the next read.
- Never write directly to `sprint-plan.yaml` — route every mutation
  through `node _Sprintpilot/scripts/sprint-plan.js` so atomic write,
  schema validation, and `generated`/`auto_inferred_at` stamping happen.
- Never call an LLM "to plan the sprint" outside this skill. The skill
  IS the LLM-driving layer; scripts never call models.

### Invocation modes

The skill responds to three callers:

1. **User-direct:** `/sprintpilot-plan-sprint` with no arguments.
   Build a plan from scratch (or refresh existing one).
2. **Auto-derive:** the autopilot emits
   `invoke_skill: sprintpilot-plan-sprint` with
   `template_slots: { auto: true, reason, missing_keys?, removed_keys? }`
   when a plan is missing/stale and the user opted in via
   `autopilot.auto_plan_on_start: true`.
3. **Replan:** the autopilot emits the same action with
   `template_slots: { replan: true, reason }` after the user issued
   `user_input { kind: 'replan_sprint' }` mid-flight.

In every mode the skill follows the same 14-step workflow — only the
"present results" tone differs (auto/replan modes assume the user wants
a brief summary; user-direct mode is more conversational).

### When NOT to invoke

- BMad's `sprint-status.yaml` is missing → run `bmad-sprint-planning`
  first; this skill has no work to do.
- `epics.md` or `architecture.md` missing in
  `_bmad-output/planning-artifacts/` → halt with a clear message
  asking the user to run `bmad-create-epics-and-stories` and
  `bmad-create-architecture` first.
- The user only wants to see the existing DAG without editing →
  use `node _Sprintpilot/scripts/resolve-dag.js render` directly;
  no need to invoke this full skill.

---

Follow the instructions in ./workflow.md.
