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

1. **User-direct:** `/sprintpilot-plan-sprint [<focus>] [<scheduling>]`.
   Build a plan from scratch OR refresh + (re-)curate an existing one.
   Optional focus / scheduling hints:
   - `/sprintpilot-plan-sprint epic 21` → `focus_epics: ["21"]`
   - `/sprintpilot-plan-sprint 21-3-add-auth, 21-4-router` → `focus_stories: [...]`
   - `/sprintpilot-plan-sprint rebuild` → force full re-inference
   - Natural-language ("focus on epic 21", "prioritize 21-3") works too —
     Step 0 parses it from the surrounding chat message.
2. **Auto-derive:** the autopilot emits
   `invoke_skill: sprintpilot-plan-sprint` with
   `template_slots: { auto: true, reason, missing_keys?, removed_keys? }`
   when a plan is missing/stale and the user opted in via
   `autopilot.auto_plan_on_start: true`. Preserves prior curation.
3. **Replan:** the autopilot emits the same action with
   `template_slots: { replan: true, reason }` after the user issued
   `user_input { kind: 'replan_sprint' }` mid-flight. Treated as a full
   rebuild.

In every mode the skill follows the same workflow — only the "present
results" tone differs (auto mode assumes the user wants a brief summary;
user-direct and replan modes are more conversational and ALWAYS reach
the curation step, even when nothing has gone stale).

### Scheduling contract

When the user signals focus (`focus_epics` or `focus_stories`), the skill
ASKS how the focus should be scheduled relative to existing pending
stories — it does NOT assume. Step 11a presents four options:

| Mode | Behavior |
|---|---|
| `top` | Bump focus stories to the head of the queue; keep other pending stories below. The "do this next" mode. |
| `focus_only` | Exclude all non-focus pending stories from this sprint (they stay in the plan as `plan_status: excluded` for context). The "single-epic mini-sprint" mode. |
| `append` | Keep current priorities; focus stories run last. Today's legacy behavior — rarely what a user wants when they say "focus on X". |
| `custom` | Skip the preset, drop into per-story curation in Step 11b. |

If the orchestrator emits `template_slots.scheduling`, the skill honors
it without prompting. If not, Step 11a is mandatory — silently picking
`append` (the historical default) is the bug fixed in this revision.

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
