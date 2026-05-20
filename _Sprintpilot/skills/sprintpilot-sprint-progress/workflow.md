# Sprintpilot — Sprint Progress Check

## Purpose

Produce a concise health check of the current sprint's autopilot
execution. Reads the structured progress snapshot, recent halts /
verify failures, and step-level events; layers brief judgment on top
to highlight what (if anything) needs attention.

## Outputs

- A ≤15-line human-readable summary printed to chat.
- A single recommended next action (or "nothing to do — autopilot is
  healthy / idle").

No file writes. No state mutations.

## Conventions

- `<root>` = project root (where `_bmad-output/` lives).
- All shell-outs use `node` (no global install assumed).
- On any error (no plan, missing ledger, etc.), degrade gracefully —
  print what you DO know and skip the parts you don't. The user gets
  a partial answer rather than a halt.

---

## Step 1 — Collect the Structured Snapshot

<action>Run the progress CLI in JSON mode:
```
node _Sprintpilot/bin/autopilot.js progress --project-root <root> --json
```
Parse the response. Key fields:
- `plan_present` — false → project running in sprint-status order; the
  rest of the analysis is naturally lighter.
- `plan_id`
- `current_story` / `current_step`
- `sprint_progress` — `{ total, done, pending, skipped, excluded, source }`
- `recent_events` — last 3 `story_step_*` ledger entries.

Don't fail if the command exits non-zero (e.g., missing project root).
Capture stderr and treat as "unknown progress" — proceed with Step 2
which still produces useful output.</action>

---

## Step 2 — Pull Recent Halt / Verify Context

<action>Read the tail of the ledger to identify any unresolved
halts, verify rejections, or repeated step-failure loops. Inline node
is the lightest path:

```
node -e "
const l = require('./_Sprintpilot/lib/orchestrator/action-ledger.js');
const entries = l.read({projectRoot: process.cwd()}, {limit: 40});
const interesting = entries.filter(e =>
  e.kind === 'halt' ||
  e.kind === 'verify_rejected' ||
  e.kind === 'plan_exhausted' ||
  e.kind === 'plan_reorder_rejected' ||
  e.kind === 'auto_derive_emitted' ||
  e.kind === 'plan_migrated'
);
process.stdout.write(JSON.stringify(interesting));
"
```

Look for:
- **`halt` with reason in {`autopilot_lock_held`, `worktree_orphans_detected`,
  `plan_exhausted`, `user_pause`, `user_replan_sprint`, `user_abort_sprint`}**
  — autopilot is stopped and needs user attention.
- **`verify_rejected` with `consecutive >= 3`** — autopilot is stuck in
  a retry loop; the LLM may need to re-read the failing artifact.
- **`plan_reorder_rejected`** — a recent reorder violated the DAG;
  the user has unresolved input pending.
- **Repeated `story_step_started` for the same story+phase without
  matching `story_step_completed`** — phase entered but never finished;
  could indicate a wedged session.

Don't fail if the ledger is empty (greenfield project, never run).
Just note "no execution history yet" and proceed.</action>

---

## Step 3 — Synthesize the Report

<action>Render a single brief block to chat following this template
(omit any line that doesn't apply):

```
Sprint progress
  Plan:     <plan_id> — <done>/<total> done (<pending> pending,
            <skipped> skipped, <excluded> excluded)
  Bar:      [=====     ] <pct>%
  Tracker:  <linked>/<total> stories linked to <provider> (<project_key>)   ← only when issue_tracker set
  Current:  <story_key> [<issue_id>] (step: <phase>)   OR   "idle"
            ↑ issue_id bracket only when set on this story
  Recent:   <kind> <story> [<issue_id>] / <phase> (<elapsed>s ago)
            <kind> <story> [<issue_id>] / <phase> (<elapsed>s ago)

Health:    <one of: HEALTHY | STALLED | NEEDS-INPUT | EXHAUSTED | NO-PLAN>
Reason:    <one short sentence>
Suggest:   <one concrete next action OR "continue running">
```

The `autopilot progress --json` response carries the lookup data:
- `current_issue_id` — the issue_id of the currently-running story (or null).
- `issue_tracking` — `{provider, project_key, base_url, total, linked, coverage}`
  when an issue_tracker is configured; null otherwise (omit the Tracker
  line entirely when null — don't surface zeros as noise).
- Each `recent_events[]` entry carries an `issue_id` field (or null).

Always include the `[<issue_id>]` bracket when the field is non-null;
omit it when null. Don't write "[no issue]" or similar — silence
communicates "not tracked" cleanly.

**Health classification:**

| Signal | Health | Suggest |
|---|---|---|
| `plan_present=false` AND no halts in last 40 | NO-PLAN | "Continue in sprint-status order, or run /sprintpilot-plan-sprint to enable dependency-aware ordering." |
| Most-recent halt is `plan_exhausted` | EXHAUSTED | "Run /sprintpilot-plan-sprint to add more stories, or `autopilot start --no-auto-plan` to continue in sprint-status order." |
| Most-recent halt is `user_pause` | NEEDS-INPUT | "Resume with `autopilot start`." |
| Most-recent halt is `user_replan_sprint` | NEEDS-INPUT | "Next `autopilot start` will invoke /sprintpilot-plan-sprint." |
| `verify_rejected` with `consecutive >= 3` in last 5 entries | STALLED | "Inspect the failing artifact named in `verify_result.issues`; consider `user_input { kind: 'force_continue' }` only if you've manually resolved the issue." |
| `plan_reorder_rejected` more recent than any subsequent reorder_queue | NEEDS-INPUT | "Reorder violations exist; revise the order to respect the DAG before sending another reorder_queue." |
| No halts, current_story present, current_step is a valid phase | HEALTHY | "Continue running; nothing requires attention." |
| No halts, no current_story, sprint_progress.pending > 0 | HEALTHY | "Run `autopilot start` to pick up the next pending story." |
| No halts, no current_story, sprint_progress.pending == 0 | HEALTHY | "Sprint complete; consider running the bmad-retrospective skill if not already done." |

Default to HEALTHY when classification is ambiguous — don't manufacture
alarm.</action>

<action>If the user invoked the skill with a story name argument
(e.g., `/sprintpilot-sprint-progress 1-3-add-auth`), also call:
```
node _Sprintpilot/bin/autopilot.js progress --project-root <root> --story <story-key> --json
```
And append a one-block "Story detail" section showing that story's
plan entry. When `issue_id` is non-null, prominently display it on its
own line (it's the primary cross-reference back to the user's issue
tracker):

```
Story: <story_key>
  Issue:        <issue_id>       ← omit line when null
  Epic:         <epic>
  Plan status:  <plan_status>
  BMad status:  <bmad_status>
  Priority:     <priority>
  Current step: <current_step>   ← omit when not running
  Completed:    <completed_at>   ← omit when not done
```

Do not repeat the full sprint summary in this mode — just the focused
story block.</action>

---

## Failure modes

| Symptom | Recovery |
|---|---|
| `autopilot progress` exits non-zero (missing project root, etc.) | Capture stderr; print "Progress CLI unavailable: <stderr first line>"; still attempt Step 2. |
| Ledger file missing | Print "No execution history yet — sprint hasn't started"; skip Step 2 analysis; suggest `autopilot start`. |
| Plan file corrupt | Print "sprint-plan.yaml unreadable (run `node _Sprintpilot/scripts/sprint-plan.js read --project-root .` to inspect)"; do NOT auto-archive — that's user's call. |
| Recent ledger has 0 entries | Note "Ledger is empty — autopilot hasn't run yet or was reset"; skip halt analysis. |
