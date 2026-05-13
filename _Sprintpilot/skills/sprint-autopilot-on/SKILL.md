---
name: sprint-autopilot-on
description: 'Engage autonomous story execution for BMad Method with git workflow integration. Implements stories end-to-end with automatic branching (git worktrees), commits, linting, and PR creation. Uses standard git worktree commands for story isolation — works with any coding agent. Falls back to stock BMad behavior when git is disabled. Use when user says "/sprint-autopilot-on" or "start autopilot".'
---

## STOP — read this entire file before doing anything

Sprintpilot is driven by a deterministic Node.js state machine at
`_Sprintpilot/bin/autopilot.js`. The LLM owns in-skill execution,
diagnosis, triage, and small-judgment decisions — not the flow.

Follow **`./workflow.orchestrator.md`** verbatim. Flow control lives in
`_Sprintpilot/bin/autopilot.js` (a Node CLI you call via `autopilot next`
/ `autopilot record`). The orchestrator emits actions; you execute them.

### Never improvise

- Never decide which BMad skill runs next yourself — the state machine
  emits an `invoke_skill` action telling you.
- Never skip the `autopilot next` → `autopilot record` cycle. Even when
  a step feels "obvious," route through the CLI so the ledger, verify,
  and bookkeeping enforcement run.
- Do not search for `workflow.md` or reconstruct it from memory; do not
  read cached BMad legacy patterns and apply them ahead of the
  orchestrator's state machine.

`workflow.orchestrator.md` is the **sole authority** for the rest of the
session.
