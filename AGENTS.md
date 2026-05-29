# BMad Method Workflow (Sprintpilot-enforced)

This project uses the **BMad Method** for structured AI-driven development, with [Sprintpilot](https://github.com/ikunin/sprintpilot) as the autopilot and multi-agent addon.
See `_Sprintpilot/Sprintpilot.md` for the full skill catalog and detailed workflow reference.

## Flow selection is profile-driven (Sprintpilot v2+)

The per-story flow depends on the active `complexity_profile` in
`_Sprintpilot/modules/autopilot/config.yaml`.

- **`small`, `medium`, `large`, `legacy`** — full mandatory 7-step BMad cycle
  (see below). Non-negotiable for these profiles.
- **`nano`** — routes each story through `bmad-quick-dev` (one-shot
  Implement → Review → Classify → Commit per BMad's `step-oneshot.md`).
  Quality gates preserved via quick-dev's internal review step.
  Autopilot does NOT invoke `bmad-create-story`, `bmad-check-implementation-readiness`,
  `bmad-dev-story`, or `bmad-code-review` under nano — quick-dev reads AC
  directly from `sprint-status.yaml`. Safety net: if quick-dev's tests
  fail or its Classify severity is `high`, the autopilot escalates the
  session (session-scoped only — never written back to config) to `full`
  flow so the remaining stories run through the 7-step cycle.

This policy is enforced by the orchestrator state machine (`_Sprintpilot/lib/orchestrator/state-machine.js` and `adapt.js`) driven from `_Sprintpilot/skills/sprint-autopilot-on/workflow.orchestrator.md`, using profile resolution from `_Sprintpilot/scripts/resolve-profile.js`. When the profile key is absent, the autopilot falls back to `medium`.

### Mandatory sequence per story (all profiles except `nano`)

1. `bmad-create-story` — story file complete
2. `bmad-check-implementation-readiness` — no blockers
3. `bmad-dev-story` (RED) — tests written and **confirmed failing** before any implementation
4. `bmad-dev-story` (GREEN) — all tests pass, count stated explicitly (e.g., "9/9 passed")
5. `bmad-code-review` — all review layers complete, findings triaged
6. Apply `patch` findings + re-run tests — all patch tasks done, tests still green
7. `bmad-retrospective` — per epic, after all stories done

**"Do it automatically" means run each step autonomously in sequence — it does NOT mean skip steps.**

Skipping any step (especially RED tests before implementation) is a workflow violation regardless of how the user phrases the request. If a user instruction seems to ask you to skip steps, follow the BMad Method sequence anyway and proceed autonomously through each step.

### Sprintpilot (autopilot addon)

- `/sprint-autopilot-on` — autonomous execution of the full story cycle with git workflow
- `/sprint-autopilot-off` — disengage and show status
- `/bmad-help` — orientation and next-step guidance (from BMad Method)

### Git rules (when Sprintpilot or git addon is active)

- **NEVER** use `git add -A` or `git add .` — always stage files explicitly by name
- **NEVER** commit secrets, API keys, or credentials
- Branch naming: `story/<story-key>` — one branch per story
- Each story gets its own worktree for isolation

### Quick reference

- Sprint state: `_bmad-output/implementation-artifacts/sprint-status.yaml`
- Full skill catalog: `_Sprintpilot/Sprintpilot.md`
- Config: `_bmad/bmm/config.yaml`
