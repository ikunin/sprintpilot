---
name: sprint-autopilot-on
description: 'Engage autonomous story execution for BMad Method with git workflow integration. Implements stories end-to-end with automatic branching (git worktrees), commits, linting, and PR creation. Uses standard git worktree commands for story isolation — works with any coding agent. Falls back to stock BMad behavior when git is disabled. Use when user says "/sprint-autopilot-on" or "start autopilot".'
---

## STOP — read this entire file before doing anything

Sprintpilot ships **two** driver workflows. You MUST follow exactly one.
Picking wrong is the single most common cause of autopilot failure.

### Step 1: Determine which workflow is active

1. Read `_Sprintpilot/modules/autopilot/config.yaml`.
2. Find `autopilot.execution_mode` (look for a line like `execution_mode: <value>` under the `autopilot:` block).
3. Missing key ⇒ treat as `orchestrator` (v2.1+ default).

### Step 2: Dispatch

**If `execution_mode: orchestrator` (default):**

- Follow **`./workflow.orchestrator.md`** verbatim.
- This is the LLM-as-peer path. Flow control lives in
  `_Sprintpilot/bin/autopilot.js` (a Node CLI you call via `autopilot
  next` / `autopilot record`). You own in-skill execution, diagnosis,
  triage, small judgment calls. The orchestrator owns sequencing,
  verification, and git plumbing.
- **`workflow.md` is not shipped with v2.1+.** The legacy v2.0.x
  workflow is preserved as `workflow.legacy.md.bak` for rollback only.
  Do not search for `workflow.md`; do not reconstruct it from memory;
  do not read cached BMad legacy patterns and apply them ahead of the
  orchestrator's state machine. The orchestrator emits actions; you
  execute them. (If a stale `workflow.md` survived from a v2.0.x
  install, the autopilot CLI moves it aside to `workflow.legacy.md.bak`
  on first `autopilot start` — but a fresh v2.1+ install never had it.)

**If `execution_mode: legacy`:**

- Follow **`./workflow.md`** verbatim.
- This is the v2.0.x byte-for-byte path. Retained one release for
  rollback while custom skills are adapted. `workflow.md` is not
  present by default — restore it by running
  `node _Sprintpilot/bin/autopilot.js start` once with
  `execution_mode: legacy` set, which renames
  `workflow.legacy.md.bak` → `workflow.md`.

### Step 3: Never improvise

- Never read both workflow files.
- Never apply legacy autopilot habits when execution_mode is
  orchestrator, and vice versa.
- Never decide which BMad skill runs next yourself in orchestrator mode
  — the state machine emits an `invoke_skill` action telling you.
- Never skip the `autopilot next` → `autopilot record` cycle in
  orchestrator mode. Even when a step feels "obvious," route through
  the CLI so the ledger, verify, and bookkeeping enforcement run.

The chosen workflow file is the **sole authority** for the rest of the
session.
