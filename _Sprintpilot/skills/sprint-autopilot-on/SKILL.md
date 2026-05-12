---
name: sprint-autopilot-on
description: 'Engage autonomous story execution for BMad Method with git workflow integration. Implements stories end-to-end with automatic branching (git worktrees), commits, linting, and PR creation. Uses standard git worktree commands for story isolation — works with any coding agent. Falls back to stock BMad behavior when git is disabled. Use when user says "/sprint-autopilot-on" or "start autopilot".'
---

## Boot — pick the workflow

Sprintpilot ships two driver workflows. Pick the right one before doing anything else:

1. Read `_Sprintpilot/modules/autopilot/config.yaml` from the project root.
2. Find the value of `autopilot.execution_mode` (lines starting with `execution_mode:` under `autopilot:`).
   - If the key is missing, treat the value as `orchestrator` (v2.1+ default).
3. Dispatch:
   - `execution_mode: orchestrator` → **follow `./workflow.orchestrator.md`**.
     This is the deterministic, LLM-as-peer path. Flow control is owned
     by `_Sprintpilot/bin/autopilot.js`; you own in-skill execution,
     diagnosis, triage, and small judgment calls.
   - `execution_mode: legacy` → **follow `./workflow.md`**.
     This is the v2.0.x byte-for-byte path. Retained for one release
     cycle while users migrate. If you hit a regression on orchestrator
     mode, set this and open an issue at
     https://github.com/ikunin/sprintpilot/issues.

Do NOT read both files. Follow exactly one. The chosen workflow file is the
sole authority for the rest of the session.
