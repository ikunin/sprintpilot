# Sprint Planning (`/sprintpilot-plan-sprint`)

The Sprintpilot sprint planner builds (or refreshes) an authoritative dependency-aware execution plan for a BMad sprint. It is **opt-in** — the default `autopilot start` still runs stories in `sprint-status.yaml` order.

> **Cross-references.** This page is the focused reference. For the long-form walkthrough see [`docs/USAGE.md` § Sprint Planning + DAG-Aware Execution](./USAGE.md#sprint-planning--dag-aware-execution-v230). For knobs, file paths, and concurrency semantics see [`docs/CONFIGURATION.md`](./CONFIGURATION.md). The LLM-facing contract lives at `_Sprintpilot/skills/sprintpilot-plan-sprint/`.

---

## TL;DR

```
# After bmad-sprint-planning has produced sprint-status.yaml:
/sprintpilot-plan-sprint
```

The skill reads `epics.md`, `architecture.md`, and `sprint-status.yaml`, infers per-epic + cross-epic dependencies, lets you curate which stories belong in the active sprint, and writes `_bmad-output/implementation-artifacts/sprint-plan.yaml` + `sprint-plan-dag.mmd`. The next `autopilot start` honors the plan.

---

## What it does

- **Dependency-aware ordering.** `1-3-add-auth` runs after `1-1-bootstrap` and `1-2-models`, not in alphabetical `sprint-status.yaml` order.
- **Cross-epic edges.** An epic-2 story that depends on something in epic-1 waits for it.
- **Sprint curation.** Pick which non-done stories belong in *this* sprint; leave the rest as context.
- **External tracker links.** Persist Jira / Linear / GitHub / GitLab IDs per story.
- **Mid-flight reordering** with DAG validation against the inferred graph.
- **Visual DAG render** — Mermaid by default, optional Graphviz.

---

## Prerequisites

| Artifact | Path | Produced by |
|---|---|---|
| BMad sprint status | `_bmad-output/implementation-artifacts/sprint-status.yaml` | `bmad-sprint-planning` |
| BMad epics | `_bmad-output/planning-artifacts/epics.md` | `bmad-create-epics-and-stories` |
| BMad architecture | `_bmad-output/planning-artifacts/architecture.md` | `bmad-create-architecture` |

If any is missing the skill halts with a `user_prompt` naming the missing file and the BMad skill that produces it. It will not attempt the workflow without them.

---

## Invocation

```
/sprintpilot-plan-sprint
```

No arguments — the skill is fully interactive in chat. It will:

1. Load the three input artifacts.
2. Pipe LLM-derived dependency envelopes through `infer-dependencies.js dry-run` per epic (server-side validated: schema, unknown-key, self-dep, cross-epic-isolation, missing-rationale, cycle checks).
3. Repeat for cross-epic edges.
4. Present the inferred DAG inline.
5. **Ask you which stories to include** (see Curation below).
6. Run DAG-consistency validation on your selection.
7. Atomically write `sprint-plan.yaml` and refresh `sprint-plan-dag.mmd`.

On three consecutive validation failures (for any epic), the skill writes `sprint-plan.yaml.partial` + a `.sprint-plan-validation-failed` sentinel and halts so you can inspect.

---

## The curation step

This is the part most users want to understand. After the DAG is inferred, you get this prompt:

```
Which stories do you want to run in this sprint?
Default: ALL non-done stories.
  [Enter]  accept default
  [e]      edit selection (toggle individual stories by number)
  [a:KEY]  add a specific story
  [r:KEY]  remove a specific story
```

**Included vs excluded:**

| Selection | `plan_status` | Picked by queue? | Visible in plan? |
|---|---|---|---|
| Included (default) | `pending` | Yes — runs in priority order | Yes |
| Excluded via `[r:KEY]` | `excluded` | No | Yes (kept for DAG context) |
| Not selected during `[e]` toggle | `excluded` | No | Yes |
| Added via `[a:KEY]` | `pending` | Yes | Yes |

Excluded stories aren't deleted — they stay in the plan so the DAG can still reason about their relationships. This matters when an excluded story is upstream of an included one (the validator catches it; see below).

**Three common curation patterns:**

```
# 1. Full sprint of all non-done stories
[Enter]

# 2. Focused mini-sprint (only the auth epic)
[e]
> deselect: 2-1, 2-2, 3-1, 4-1
> [Enter] to confirm

# 3. Cherry-pick specific stories
[a:1-3-add-auth]
[a:2-1-foo]
[Enter]
```

**Natural-language entry.** You can also just tell the chat what you want — the skill translates:

> "Only include the bootstrap and auth stories for this sprint."
> → deselects everything else, presents result, asks you to confirm.

> "Skip story 2-3-payments for now."
> → adds `2-3-payments` to the excluded set.

> "Add 4-1-admin-panel to the next sprint."
> → adds it as `plan_status: pending`.

---

## Validation pass

Before persisting, the skill walks every selected story's transitive upstreams. If an included story has an upstream that is both **excluded** AND **not done** in sprint-status, you see:

> "Story `1-3-add-auth` (included) depends on `1-1-bootstrap` which is not in the plan and not done. Options:
>   `[a]` add `1-1-bootstrap` to the plan
>   `[r]` remove `1-3-add-auth` from the plan
>   `[x]` exclude `1-3-add-auth` (keeps it visible but won't run)"

The loop continues until the selection is DAG-consistent. The autopilot will never start a story whose upstream isn't satisfied.

---

## Outputs

| File | Location | Purpose |
|---|---|---|
| `sprint-plan.yaml` | `_bmad-output/implementation-artifacts/` | Authoritative plan — drives the autopilot queue + DAG reasoning |
| `sprint-plan-dag.mmd` | `_bmad-output/implementation-artifacts/` | Rendered Mermaid DAG (refreshed on every plan write) |
| `.sprintpilot/plan.lock` | `<project>/.sprintpilot/` | Cross-process write lock (auto-managed) |
| `.archive/sprint-plan-<plan_id>.yaml` | `<project>/.archive/` | Written on plan exhaustion |

`sprint-plan.yaml` is tracked by git (it's a team artifact); the runtime lock and per-session shards are gitignored — `npx @ikunin/sprintpilot install` wires the entries.

---

## Mid-flight commands

After the plan exists, you usually don't need to re-run the full skill. Speak naturally in the autopilot chat and the LLM translates to structured `user_input`:

| Want to… | Command |
|---|---|
| Add stories to the active plan | `add_to_sprint { story_keys: [...], position?, issue_ids? }` |
| Remove stories (mark `skipped` / `deferred`) | `remove_from_sprint { story_keys: [...], mark_status? }` |
| Reorder execution priority | `reorder_queue { order: [...] }` *(DAG-validated)* |
| Rebuild the plan from scratch | `replan_sprint { reason? }` |

Reorders that violate the DAG don't silently apply — they surface as a `plan_reorder_rejected` halt with `suggestion` strings (e.g. *"insert `1-1-bootstrap` before `1-3-add-auth`"*).

Full natural-language → command vocabulary in [`docs/USAGE.md` § Mid-flight commands](./USAGE.md#mid-flight-commands).

---

## Auto-derive (optional)

Once a plan exists, subsequent `autopilot start` calls auto-detect staleness and re-run the planner when:

- A story was **added** to `sprint-status.yaml` but isn't in the plan (`reason: stale_added_stories`).
- A story was **removed** from `sprint-status.yaml` but still appears in the plan (`reason: stale_removed_stories`).

For greenfield projects (no plan yet), opt in by setting in `_Sprintpilot/modules/autopilot/config.yaml`:

```yaml
autopilot:
  auto_plan_on_start: true
```

Default is `false` — greenfield projects fall back to sprint-status execution order.

Skip auto-derive for a single run: `autopilot start --no-auto-plan`.

---

## Plan exhausted

When every story in the plan reaches a terminal `plan_status` (`done` / `skipped` / `excluded`), the autopilot emits a `user_prompt` halt:

> Sprint plan complete. All 8 planned stories are done (6 done, 1 skipped, 1 excluded). Run `/sprintpilot-plan-sprint` to build a new plan from remaining sprint-status stories, or run `autopilot start --no-auto-plan` to continue in sprint-status order.

The plan is archived to `.archive/sprint-plan-<plan_id>.yaml`. Choose:

1. **Re-plan** via `/sprintpilot-plan-sprint` to build a new plan from the remaining sprint-status stories.
2. **Drop planning** via `--no-auto-plan` to revert to sprint-status execution order.

---

## Companion skills

| Skill | Use it when |
|---|---|
| `/sprintpilot-sprint-progress` | One-shot health check. Classifies the sprint as `HEALTHY` / `STALLED` / `NEEDS-INPUT` / `EXHAUSTED` / `NO-PLAN` based on the last 40 ledger entries and recommends exactly one next action. Pass a story key to drill in (`/sprintpilot-sprint-progress 1-3-add-auth`). |
| `/sprintpilot-dependency-graph` | Render the DAG. Formats: `mermaid` *(default, inline + `.mmd` file)*, `graphviz` *(`.dot`, requires `dot` in PATH)*, `text` *(topological tree)*, `layers` *(JSON `[[layer1], [layer2], …]`)*, `json` *(raw `{nodes, edges, epic}`)*. Per-epic scope: `… mermaid epic 1`. |
| `autopilot progress` *(CLI)* | Live terminal snapshot. `--json` for IDE / dashboard integration; `--story <key>` for one-story detail. When `sprint-plan.yaml` has an `issue_tracker` block, output cross-references your tracker IDs inline. |

---

## When NOT to use sprint planning

- `sprint-status.yaml` is the single source of truth and stories have no inter-dependencies → stay with the default. Adding a plan layer just adds ceremony.
- You're upgrading from v2.2.x and want zero behavior change → leave `auto_plan_on_start: false` (the default).
- You want only to *see* the existing DAG without editing the plan → use `/sprintpilot-dependency-graph` directly.

---

## Configuration reference

| Key | Default | Effect |
|---|---|---|
| `autopilot.auto_plan_on_start` | `false` | When `true`, emit `invoke_skill: sprintpilot-plan-sprint` on greenfield projects (no `sprint-plan.yaml` yet). Once a plan exists, staleness detection auto-runs the planner regardless of this knob. |
| `autopilot.auto_infer_dependencies` | `false` | **Legacy / no-op** since v2.3.0; superseded by `auto_plan_on_start`. Safe to remove from your config. |

CLI overrides:

- `autopilot start --no-auto-plan` — skip auto-derive for one session.

---

## Migration from pre-v2.3.0

If your project has a legacy `_Sprintpilot/sprints/dependencies.yaml` sidecar (from the v2.0.2–v2.2.x `auto_infer_dependencies` flow), the autopilot auto-migrates it on the first `autopilot start` of v2.3.0+:

- `_Sprintpilot/sprints/dependencies.yaml` → archived to `.archive/dependencies.yaml.migrated`
- Stories + overrides imported into `sprint-plan.yaml`
- Legacy `epics: { independent: … }` block dropped with a warning (parallel execution moved to v2.4.0 mechanisms)

Or run the migration manually:

```bash
node _Sprintpilot/scripts/infer-dependencies.js migrate --project-root .
```

Idempotent — no-op when the legacy file is absent.

---

## Concurrent execution + safety

Every mutation of `sprint-plan.yaml` (`markDone`, `addStories`, `removeStories`, `reorder`, `setIssueId`, `setIssueTracker`, `refreshBmadStatus`, `archive`) acquires `.sprintpilot/plan.lock`. Two concurrent autopilot sessions, or an autopilot session running alongside `/sprintpilot-plan-sprint`, serialize their writes — first wins, the second waits up to 30 s and then errors with `lock_timeout`.

Stale-lock detection: 5 minutes (a session that crashed mid-mutate releases the lock automatically on the next acquire). Safe to `rm .sprintpilot/plan.lock` by hand if you killed a long-running operation hard.

Failure surfacing: when a `user_input` mid-flight command fails (DAG violation, missing keys, validation error, plan corruption), the autopilot halts with a structured diagnostic rather than silently logging it. Full failure → recovery matrix in [`docs/USAGE.md` § Concurrent execution + safety](./USAGE.md#concurrent-execution--safety).

---

## Further reading

- [`docs/USAGE.md` § Sprint Planning + DAG-Aware Execution](./USAGE.md#sprint-planning--dag-aware-execution-v230) — long-form walkthrough with worked examples.
- [`docs/CONFIGURATION.md`](./CONFIGURATION.md) — every config knob, file ownership table, concurrent-execution matrix.
- `_Sprintpilot/skills/sprintpilot-plan-sprint/workflow.md` — the 14-step deterministic flow the skill follows.
- `_Sprintpilot/scripts/infer-dependencies.js` — validator + LLM-envelope contract.
- `_Sprintpilot/scripts/sprint-plan.js` — atomic-write surface for the plan.
