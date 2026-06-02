# Sprintpilot — Sprint Plan Generation

## Purpose

Build (or refresh) `_bmad-output/implementation-artifacts/sprint-plan.yaml`
— the authoritative sprint plan that drives autopilot story selection,
DAG-aware reordering, and external-tracker integration. Infers per-epic
+ cross-epic dependencies via piped LLM envelopes (validated server-side
by `infer-dependencies.js`), lets the user curate which stories belong
in the active plan, and persists everything atomically.

## Prerequisites

| Artifact | Path | Required |
|---|---|---|
| BMad sprint-status | `_bmad-output/implementation-artifacts/sprint-status.yaml` | yes |
| BMad epics | `_bmad-output/planning-artifacts/epics.md` | yes |
| BMad architecture | `_bmad-output/planning-artifacts/architecture.md` | yes |

If any required prerequisite is missing, halt with a `user_prompt`
naming the missing file and the BMad skill that produces it
(`bmad-sprint-planning`, `bmad-create-epics-and-stories`,
`bmad-create-architecture`). Do NOT attempt the workflow without them.

## Outputs

| File | Location | Purpose |
|------|----------|---------|
| `sprint-plan.yaml` | `_bmad-output/implementation-artifacts/` | Authoritative plan (read by autopilot + resolve-dag) |
| `sprint-plan-dag.mmd` | `_bmad-output/implementation-artifacts/` | Rendered mermaid DAG (refreshed on every plan write) |
| Archived legacy | `.archive/dependencies.yaml.migrated` | If a pre-v2.3.0 `_Sprintpilot/sprints/dependencies.yaml` existed |

## Conventions used below

- `<root>` = the project root passed via `--project-root` (or `cwd`).
- All scripts live under `_Sprintpilot/scripts/` — invoke via `node <path>`.
- LLM envelopes are JSON; you produce them, the script validates them.
- On any 3-iteration validation failure (per-epic OR cross-epic), the
  skill writes `_bmad-output/implementation-artifacts/sprint-plan.yaml.partial`
  with the last attempted envelope + errors header, writes the sentinel
  `.sprint-plan-validation-failed`, and halts with a `user_prompt`
  asking the user to inspect the partial.

---

## Step 0 — Capture Invocation Intent

<action>Determine the user's planning intent BEFORE reading any artifacts.
Three orthogonal signals contribute:

1. **`template_slots`** (when the orchestrator invoked the skill):
   - `auto: true` → background staleness reconciliation; preserve prior curation.
   - `replan: true` → user issued `replan_sprint`; treat as a full rebuild.
   - `focus_epics: [<id>, ...]` *(optional)* → user wants these epics emphasized.
   - `focus_stories: [<key>, ...]` *(optional)* → user wants these specific stories emphasized.
   - `scheduling: 'top' | 'focus_only' | 'append' | 'custom'` *(optional)* → explicit scheduling override; if omitted, Step 11 will ASK the user.

2. **Skill argument string** (when the user typed `/sprintpilot-plan-sprint <args>`):
   - `epic <id>` / `epic-<id>` / bare `<id>` → `focus_epics: ["<id>"]`.
   - Multiple comma-separated IDs → all of them in `focus_epics`.
   - A specific story key (e.g. `21-3-add-auth`) → `focus_stories: ["21-3-add-auth"]`.
   - `rebuild` / `from scratch` → force a full re-inference.

3. **Surrounding chat message** (when the user typed the slash command
   alongside a natural-language directive in the same turn):
   - "focus on epic 21" / "only epic 21" / "narrow to epic 21" / "plan for epic 21"
     → `focus_epics: ["21"]`
   - "prioritize 21-3 and 21-4" → `focus_stories: ["21-3", "21-4"]`
   - "skip / exclude epic X" → leave for per-story curation in Step 11; do NOT
     auto-translate to `focus_epics` (that's a scope directive, not an exclusion).
   - "rebuild from scratch" / "re-plan everything" → `rebuild: true`.

Resolve these signals into an `intent` object kept in scratch state for
the rest of the workflow:
```
intent = {
  mode:           'user-direct' | 'auto' | 'replan',
  focus_epics:    string[] | null,    // e.g. ["21"]
  focus_stories:  string[] | null,    // e.g. ["21-3-add-auth"]
  scheduling:     'top' | 'focus_only' | 'append' | 'custom' | null,
  rebuild:        boolean,
  raw_directive:  string | null       // user's verbatim text, for echo-back
}
```
If `focus_epics` or `focus_stories` references an ID/key that is NOT in
`epics.md` / `sprint-status.yaml`, halt with a `user_prompt` listing the
valid IDs and asking the user to pick one — do NOT guess.</action>

<action>Echo the resolved intent back to the user in one line BEFORE
proceeding, so a misparse is caught immediately:

| Resolved intent | Echo |
|---|---|
| `focus_epics: ["21"]`, `scheduling: null` | "Planning intent: focus on epic 21 — Step 11 will ask how to schedule it (top / focus-only / append / custom)." |
| `focus_epics: ["21"]`, `scheduling: 'top'` | "Planning intent: focus on epic 21, scheduled at the top of the queue (other pending stories preserved, ranked below)." |
| `focus_epics: ["21"]`, `scheduling: 'focus_only'` | "Planning intent: focus on epic 21 ONLY — all other pending stories will be excluded from this sprint (they remain in the plan as `plan_status: excluded` for context)." |
| no focus, no plan | "Planning intent: fresh plan, all non-done stories included by default." |
| no focus, plan exists | "Planning intent: refresh existing plan — you'll be prompted to re-curate the included set in Step 11." |

This echo is the user's "are you sure" moment. They can correct in chat
before the skill proceeds.</action>

---

## Step 1 — Load Inputs

<action>Verify the three required artifacts exist:
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `_bmad-output/planning-artifacts/epics.md`
- `_bmad-output/planning-artifacts/architecture.md`

If any is missing, halt with a `user_prompt` naming what's missing.</action>

<action>Read each into memory. Parse epics.md for the list of epic IDs.
Parse sprint-status.yaml for the list of story keys under
`development_status:` (or `stories:` for the alternate shape).</action>

<action>Read the existing plan if present:
```
node _Sprintpilot/scripts/sprint-plan.js read --project-root <root>
```
Note: `exists: true/false` + the full plan body when present. Used by
Step 3 to compute staleness and decide which epics need re-inference.</action>

---

## Step 2 — Migrate Legacy Dependencies (One-Shot)

<action>Check whether a pre-v2.3.0 sidecar exists at
`_Sprintpilot/sprints/dependencies.yaml`. If it does AND `sprint-plan.yaml`
is absent OR has an empty `dependencies.stories` block, run the
one-shot migration:
```
node _Sprintpilot/scripts/infer-dependencies.js migrate --project-root <root>
```
The migrate command imports the legacy `stories:` + `overrides:` blocks
into the new plan, drops the legacy `epics:` block with a warning,
and moves the old file to `.archive/dependencies.yaml.migrated`.

If `migrated: false` and `reason: 'no_legacy_file'` — proceed silently.
If `migrated: false` for any other reason — surface the message in a
`user_prompt` and ask whether to continue with a fresh plan.</action>

---

## Step 3 — Staleness Check

<action>Compute which epics need re-inference. The cheap way is to
ask the orchestrator helper:
```
node -e "
const m = require('./_Sprintpilot/lib/orchestrator/sprint-plan.js');
console.log(JSON.stringify(m.planStaleness({projectRoot: process.cwd()})));
"
```
Returns `{ stale: bool, reason, missing_keys?, removed_keys? }`.

Decision matrix:

| stale | reason | action |
|---|---|---|
| false | — | Skip Step 4 entirely (plan is fresh). For `intent.mode === 'auto'` you may go directly to Step 5 / 13. For `'user-direct'` or `'replan'` you MUST still proceed to Step 10 → Step 11 — the user invoked the slash command on purpose; the only way for them to (re-)scope, prioritize, or focus the sprint is via Step 11's prompts. Skipping curation on a non-stale plan is the bug that caused users to type `/sprintpilot-plan-sprint epic 21` and get their queue topped by an unrelated leftover story. |
| true | `missing` | Run Step 4 for EVERY epic in epics.md. |
| true | `migration_needed` | Step 2 should have handled this — re-check; if still missing, run Step 4 for every epic. |
| true | `added_stories` | Run Step 4 only for the epics whose stories appear in `missing_keys`. |
| true | `removed_stories` | Run Step 4 for the epics affected (a missing story means the per-epic graph for that epic is stale). |
| true | `corrupt` | Halt with a `user_prompt` showing the corruption error + offering archive+regenerate. |

For hand-authored plans (no AUTO-INFERRED marker AND user-direct invocation
of /sprintpilot-plan-sprint without explicit "rebuild" intent), confirm
with a `user_prompt` before regenerating: "An existing plan has hand
edits in the `dependencies` block. Proceed with regeneration (loses the
edits) or skip per-epic inference and just refresh DAG render?"</action>

---

## Step 4 — Per-Epic Inference

<action>For each epic that needs (re-)inference, run a tight loop:

1. Generate the prompt:
   ```
   node _Sprintpilot/scripts/infer-dependencies.js scaffold-prompt --epic <id> --project-root <root>
   ```
   Stdout is the literal prompt — feed it back to yourself in chat as
   the "next user message" to infer the dependencies. Read the four
   files the prompt names; do not improvise based on memory.

2. Produce a JSON envelope of the EXACT shape:
   ```json
   {
     "version": 1,
     "epic": "<id>",
     "dependencies": { "<story-key>": ["<dep-key>", ...] },
     "rationale":   { "<story-key>": "1 sentence quoting the AC/file/architecture line" }
   }
   ```
   Stories with NO inbound deps are omitted from `dependencies`. Every
   listed key needs a non-empty rationale. Cross-epic edges go through
   Step 5 — don't put them here.

3. Validate via dry-run:
   ```
   echo '<envelope>' | node _Sprintpilot/scripts/infer-dependencies.js dry-run --epic <id> --project-root <root>
   ```
   On `valid: true`, proceed. On `valid: false`, the response carries
   an `errors[]` array — fix the envelope and retry. Max 3 iterations
   per epic. On 3rd failure, save the partial + sentinel and halt
   (see "Conventions" above).

4. Commit the envelope:
   ```
   echo '<envelope>' | node _Sprintpilot/scripts/infer-dependencies.js write --epic <id> --project-root <root>
   ```
   `wrote: true, edges_inferred, edges_added, edges_removed` confirms
   success. The script writes into `plan.dependencies.stories.*` while
   preserving entries for other epics and the `overrides:` block.</action>

---

## Step 5 — Cross-Epic Detection

<action>Now that per-epic edges are in place, ask the LLM whether
any edges cross epic boundaries:

1. Generate the cross-epic prompt:
   ```
   node _Sprintpilot/scripts/infer-dependencies.js scaffold-prompt --cross-epic --project-root <root>
   ```

2. Produce a JSON envelope:
   ```json
   {
     "version": 1,
     "cross_epic_deps": [
       { "from_story": "<key>", "to_story": "<key>", "rationale": "<≤200 chars>" }
     ]
   }
   ```
   `from_story` depends on `to_story`. Both keys must belong to
   DIFFERENT epics. If no cross-epic deps detected, send
   `cross_epic_deps: []`.

3. Validate via dry-run:
   ```
   echo '<envelope>' | node _Sprintpilot/scripts/infer-dependencies.js dry-run --cross-epic --project-root <root>
   ```
   Validator checks: keys exist in sprint-status, from/to epics differ,
   rationale present (≤200 chars), no duplicate of per-epic edges,
   no cycle in the combined graph. Max 3 iterations.

4. Present each surviving edge to the user with its rationale:
   ```
   Cross-epic edge detected:
     2-1-foo depends on 1-3-add-auth
     Rationale: needs auth context from 1-3 before integration
     [a] accept  [r] reject  [s] skip remaining edges
   ```
   Accept-all, reject-all, or per-edge. Rejected edges drop out;
   accepted edges go through to write.

5. Commit accepted edges:
   ```
   echo '<accepted envelope>' | node _Sprintpilot/scripts/infer-dependencies.js write-cross-epic --project-root <root>
   ```</action>

---

## Step 6 — Issue Tracker Setup (Optional)

<action>Ask the user (single user_prompt):
> "Do you want to link stories to an external issue tracker
> (Jira / Linear / GitHub / GitLab)? [y/N]"

On `n` or skip — proceed to Step 7 without writing the `issue_tracker:`
block.

On `y` — collect:
- `provider`: one of `jira`, `linear`, `github`, `gitlab`
- `base_url`: full URL prefix (e.g., `https://co.atlassian.net`)
- `project_key`: the tracker's project key (e.g., `PROJ` for Jira)

Then call the sprint-plan primitive. Currently the simplest path is
to read the plan, set `plan.issue_tracker = { provider, base_url, project_key }`,
and write the whole plan back via `node _Sprintpilot/scripts/sprint-plan.js write`
(piping the modified plan to stdin). The script validates schema and writes
atomically.</action>

---

## Step 7 — Issue ID Capture (Optional)

<action>Ask the user (single user_prompt):
> "Capture external issue IDs for each epic/story? [Y]es / [n]o
>  / [s]kip remaining for this epic / [p]attern (sequential IDs)"

On `n` — proceed to Step 8 without setting any `issue_id` fields.

On `Y` — loop through epics and stories. For each entity:
> "Issue ID for epic 1 (or skip)?"
> "Issue ID for story 1-3-add-auth (or skip)?"

`p` mode prompts once for a prefix (e.g., `PROJ-`) + starting number;
the skill assigns sequential IDs (`PROJ-100`, `PROJ-101`, …).

**Validation rules** — `setIssueId` rejects these inputs (re-prompt if
they appear; don't retry the same value):
- Any of: `[ ] < > | ; & \n \r` or ASCII control characters
- Any Unicode RTL/LTR override marks (`‪`–`‮`, `⁦`–`⁩`)
- Length > 200 chars

Legitimate tracker IDs from Jira (`PROJ-101`), Linear (`LIN-42`),
GitHub (`org/repo#123`), and GitLab don't contain any of these. If a
user enters something like `PROJ;101` or pastes a URL with embedded
brackets, the validator throws — show the error and ask for a clean
ID. Don't loop on the same broken input.

For each captured ID, update the plan via read → mutate → write. The
relevant primitive is `setIssueId(entity_key, issue_id, { projectRoot })`
in `sprint-plan.js`; from this skill the simplest path is to bulk-edit
the plan in memory and write it once at the end of the loop.

Bulk skip options ensure this step doesn't become tedious on sprints
with many stories.</action>

---

## Step 8 — Finalize Dependencies in Plan

<action>By this point Steps 4 + 5 have written `plan.dependencies.stories`
and `plan.cross_epic_deps`. Step 6/7 may have edited `issue_tracker`
and per-entity `issue_id`. Re-read the plan once to confirm:
```
node _Sprintpilot/scripts/sprint-plan.js read --project-root <root>
```
The plan should validate cleanly. If `exists: true, error: ...` →
something went wrong; halt with the error.</action>

---

## Step 9 — Build the Sprint-Wide DAG

<action>Compute the topological layering for presentation:
```
node _Sprintpilot/scripts/resolve-dag.js graph --project-root <root>
```
Returns `{ nodes, edges, layers, width, cycle }`. If `cycle.length > 0`,
the combined intra + cross-epic graph has a cycle (validator should
have caught this earlier; if reached, halt with the offending nodes
and ask the user to remove the bad edge).</action>

---

## Step 10 — Present the DAG

<action>Render a text-mode topological tree to the user:
```
Layer 1 (parallel-eligible width: <N>):
  - 1-1-bootstrap
  - 2-1-foo                          ← cross-epic upstream of 1-3
Layer 2:
  - 1-2-models
Layer 3:
  - 1-3-add-auth  (depends on: 1-1, 1-2, 2-1)
...
```

Highlight cross-epic edges with `←` or `cross-epic →` annotations.
Show summary stats: total stories, total epics, max layer width
(indicates parallel potential for v2.4.0), count of missing issue IDs.</action>

<action>Also write the mermaid DAG file for visual review:
```
node _Sprintpilot/scripts/resolve-dag.js render --format mermaid --project-root <root>
```
Report the path to the user:
> "DAG rendered to `_bmad-output/implementation-artifacts/sprint-plan-dag.mmd`
> — preview in any markdown viewer (GitHub, VS Code with Mermaid Preview, etc.)."</action>

---

## Step 11 — Schedule + Curate

This step has TWO sub-prompts. The first (11a) only fires when the user
expressed a focus (`intent.focus_epics` or `intent.focus_stories`) and
didn't pre-set `intent.scheduling`. The second (11b) is the curation
prompt, with the default selection driven by the scheduling choice.

### Step 11a — Scheduling question (conditional)

<action>If `intent.focus_epics` or `intent.focus_stories` is set AND
`intent.scheduling` is null, ASK the user how the focus should be scheduled.
This is REQUIRED — do not assume. The four modes are mutually exclusive
and produce visibly different plans:

> "You asked to focus on epic 21. How should it be scheduled relative
>  to the 14 other pending stories in the existing plan?
>
>    [1] **Top-prioritize epic 21** *(recommended for "do this next")* —
>        bump epic-21 stories to priorities 1..N at the head of the
>        queue; keep the other 14 pending stories below (they still
>        run after the epic-21 batch).
>    [2] **Focus only on epic 21** — exclude the other 14 pending
>        stories from this sprint. They stay in the plan as
>        `plan_status: excluded` for DAG context but the autopilot
>        won't run them. Pick this for a single-epic mini-sprint.
>    [3] **Append epic 21 at end** — keep current priorities; epic 21
>        runs last after every existing pending story. Today's default
>        behavior. Rarely what you want when you say 'focus on X'.
>    [4] **Custom** — proceed to per-story curation (11b) with no
>        scheduling preset; pick stories individually."

Wait for the user's choice. Echo it back in one line:
> "Scheduling: top-prioritize epic 21. Stepping into curation..."

Persist the choice into `intent.scheduling`. From here forward the
curation default + Step 13 priority computation honor this directive.</action>

### Step 11b — Curation

<action>Ask the user to confirm or edit the selection. The default
**changes based on `intent.scheduling`**:

| `intent.scheduling` | Default selection | What happens on Enter |
|---|---|---|
| `null` (no focus) or `append` | ALL non-done stories included | Same as the legacy behavior — everything pending gets `plan_status: pending`. |
| `top` | ALL non-done stories included; focus stories will be moved to the head in Step 13 | Same set as `append`, but priority recomputation in Step 13 puts focus-epic/story entries first. |
| `focus_only` | ONLY focus-epic / focus-story entries included; all OTHER previously-pending stories default to `excluded` | Sprint narrows to the focus set; other stories stay visible in the plan as `excluded` for context. |
| `custom` | ALL non-done stories included | User edits the selection by hand. |

Show the prompt with the count of stories that would change and the
scheduling line:

> "Curation — scheduling: **top-prioritize epic 21**.
>  Default selection: 14 epic-21 stories (focus) + 14 other pending (kept).
>  Priorities will be reordered so epic-21 stories run first.
>
>    [Enter] accept default  [e] edit selection  [a:KEY] add  [r:KEY] remove"

For `focus_only` make the consequences explicit:

> "Curation — scheduling: **focus only on epic 21**.
>  Default selection: 14 epic-21 stories included; 14 other previously-pending
>  stories will be EXCLUDED from this sprint (they stay in the plan as
>  `plan_status: excluded` for DAG context but the autopilot won't run them).
>
>    [Enter] accept default  [e] edit selection  [a:KEY] add  [r:KEY] remove"

`Default: ALL non-done` means every story in sprint-status whose status
is not `done`. Excluded stories carry `plan_status: excluded` in the plan
— they remain visible in the file for context (e.g., as upstreams of
included stories) but are NOT picked by the queue resolver.</action>

<action>On `e` (edit), present a numbered list with `[x]` for included
and `[ ]` for excluded; the user toggles entries by number. The user can
also override individual entries via `[a:KEY]` (re-include something the
scheduling default excluded) or `[r:KEY]` (exclude something the default
included).</action>

---

## Step 12 — Validate Selection

<action>For each story marked included, every transitive upstream
(intra-epic AND cross-epic) must be either ALSO included OR already
done in sprint-status. Compute via the orchestrator helper:
```
node -e "
const m = require('./_Sprintpilot/lib/orchestrator/sprint-plan.js');
const plan = require('./_Sprintpilot/scripts/sprint-plan.js').read({projectRoot: process.cwd()});
const proposed = [/* user-selected keys */];
console.log(JSON.stringify(m.validateOrdering(proposed, plan, {projectRoot: process.cwd()})));
"
```
Returns `{ valid, violations: [{story, upstream, suggestion}] }`.

On `valid: false`, present each violation:
> "Story `1-3-add-auth` (included) depends on `1-1-bootstrap` which is
>  not in the plan and not done. Options:
>  [a] add `1-1-bootstrap` to the plan
>  [r] remove `1-3-add-auth` from the plan
>  [x] exclude `1-3-add-auth` (keeps it visible but won't run)"

Loop until `valid: true`. Excluded stories carry `plan_status: excluded`
and the validator treats them as terminal.</action>

---

## Step 13 — Write Plan

<action>Build the final plan object in memory:
- `schema_version: 1`
- `source: 'skill' | 'auto' | 'cli'` (use `auto` when invoked via
  `template_slots.auto: true`, `skill` otherwise)
- `plan_id`: keep existing if re-running; generate fresh on first
  curation
- `epics: []` — per-epic metadata captured in Step 1 (id, title)
- `stories: []` — per-story entries with `key`, `epic`, `title`,
  `plan_status` (`pending` for included, `excluded` for excluded),
  `issue_id` (from Step 7), `priority` (see priority rule below),
  `upstream` (denormalized from `plan.dependencies.stories.<key>.depends_on`),
  `cross_epic_upstream` (denormalized from `plan.cross_epic_deps`),
  `added_by: 'skill'`, `added_at`

**Priority rule (driven by `intent.scheduling`):**

| `intent.scheduling` | Priority computation |
|---|---|
| `null` / `append` / `custom` | 1-indexed in topological order across the full included set. Today's default. |
| `top` | Two-pass topological sort: first pass over focus-epic / focus-story stories (assigned priorities `1..N`), second pass over the remaining included stories (assigned `N+1..M`). Both passes still respect dependency edges — an upstream from a non-focus epic that a focus story needs gets pulled into the first pass so the focus story isn't blocked. |
| `focus_only` | Equivalent to `top` with all non-focus entries excluded; priorities run `1..N` across the focus set only. |

The priority ordering is what the autopilot queue resolver consumes — so
"top" really does mean the focus epic runs first.
- `dependencies`, `cross_epic_deps`, `overrides`, `notes` — preserved
  from Steps 4-7
- `status.last_run_outcome: 'success'`, `status.last_run_at: <now>`,
  `status.last_error: null`

Pipe to write:
```
echo '<plan-json>' | node _Sprintpilot/scripts/sprint-plan.js write --project-root <root>
```
The script validates schema, stamps `generated`, and atomically writes
via tmp+rename.</action>

<action>Re-render the DAG to reflect any curation changes:
```
node _Sprintpilot/scripts/resolve-dag.js render --format mermaid --project-root <root>
```</action>

---

## Step 14 — Report

<action>Summarize what was written:
> "Sprint plan written to
> `_bmad-output/implementation-artifacts/sprint-plan.yaml`.
>
> - **N** stories planned (M epics)
> - **X** cross-epic edges
> - **Y** stories excluded (kept for context)
> - **Z** stories without issue IDs
>
> First 5 in execution order:
>   1. 1-1-bootstrap
>   2. 1-2-models
>   3. ...
>
> Run `/sprint-autopilot-on` to begin execution, or
> `/sprintpilot-plan-sprint` again to refine."</action>

<action>End the report with the single authoritative "what runs next"
line, read straight from the autopilot so it matches exactly what
`/sprint-autopilot-on` will do — never hand-compute it. Run the
read-only progress command and surface its `next_summary`:
```
node _Sprintpilot/bin/autopilot.js progress --json --project-root <root>
```
Echo the `next_summary` field verbatim as the closing line, e.g.:
> **NEXT:** `21-1-http-mcp-wrapper-for-memory` · step `create_story` · #1 of 18 in epic 21 — run `/sprint-autopilot-on` to begin.

This closes the loop between "I planned epic 21 first" and "the autopilot
will actually start 21-1": the user sees one reconciled statement instead
of having to trust the plan ordering and the resume pointer separately.
`progress` is read-only — it never mutates state or emits a skill action,
so it's safe to call here. If `next_summary` is null (e.g. the plan is
empty or the next pick can't resolve yet), say so plainly rather than
inventing a story key.</action>

<action>If invoked via `template_slots.auto: true` or `replan: true`,
keep the summary shorter (1-2 sentences) and return cleanly so the
autopilot session resumes; do not block on confirmation. Still include
the NEXT line — it's the most useful single line for the user.</action>

---

## Failure modes

| Symptom | Recovery |
|---|---|
| Prerequisite artifact missing | Halt with `user_prompt` naming the missing file + the BMad skill that produces it. |
| 3 consecutive validation failures (per-epic OR cross-epic) | Save `sprint-plan.yaml.partial` + `.sprint-plan-validation-failed` sentinel; halt asking the user to inspect. |
| Cycle in combined intra+cross graph | Halt with the offending nodes; ask the user to remove or re-rationalize the bad edge. |
| Plan write fails (disk full, permission) | The atomic tmp+rename is all-or-nothing — no torn state. Halt with the error message. |
| `sprint-plan.yaml` corrupt on entry to Step 3 | Offer archive+regenerate via `user_prompt`. |
| Skill invoked but `sprint-status.yaml` is empty | No stories to plan; halt and ask the user to run `bmad-sprint-planning` first. |
