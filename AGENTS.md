<!-- BEGIN:bmad-workflow-rules -->
# BMAD Workflow

This project uses the **BMAD Method** for structured AI-driven development.
See `_bmad-addons/BMAD.md` for the full skill catalog and detailed workflow reference.

## BMAD is non-negotiable — no exceptions

**NEVER write implementation code without first completing the mandatory BMAD story sequence.**

### Mandatory sequence per story

1. `bmad-create-story` — story file complete
2. `bmad-check-implementation-readiness` — no blockers
3. `bmad-dev-story` (RED) — tests written and **confirmed failing** before any implementation
4. `bmad-dev-story` (GREEN) — all tests pass, count stated explicitly (e.g., "9/9 passed")
5. `bmad-code-review` — all review layers complete, findings triaged
6. Apply `patch` findings + re-run tests — all patch tasks done, tests still green
7. `bmad-retrospective` — per epic, after all stories done

**"Do it automatically" means run each step autonomously in sequence — it does NOT mean skip steps.**

Skipping any step (especially RED tests before implementation) is a workflow violation regardless of how the user phrases the request. If a user instruction seems to ask you to skip steps, follow the BMAD sequence anyway and proceed autonomously through each step.

### Autopilot

- `/bmad-autopilot-on` — autonomous execution of the full story cycle with git workflow
- `/bmad-autopilot-off` — disengage and show status
- `/bmad-help` — orientation and next-step guidance

### Git rules (when autopilot or git addon is active)

- **NEVER** use `git add -A` or `git add .` — always stage files explicitly by name
- **NEVER** commit secrets, API keys, or credentials
- Branch naming: `story/<story-key>` — one branch per story
- Each story gets its own worktree for isolation

### Quick reference

- Sprint state: `_bmad-output/implementation-artifacts/sprint-status.yaml`
- Full skill catalog: `_bmad-addons/BMAD.md`
- Config: `_bmad/bmm/config.yaml`
<!-- END:bmad-workflow-rules -->
