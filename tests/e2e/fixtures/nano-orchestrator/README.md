# nano-orchestrator fixture

E2E fixture for the orchestrator-driven autopilot under the **nano** profile.

This fixture is intentionally minimal — nano routes every story through
`bmad-quick-dev` so the project artifacts are correspondingly small.

## Usage

The fixture is consumed by a future Phase 7 e2e test that drives a live
LLM (Claude / Gemini / etc.) against `autopilot.execution_mode: orchestrator`
with `complexity_profile: nano`. The test asserts:

- Each story progresses through the NANO_QUICK_DEV state, not the full 7-step.
- `tests_failed > 0` from `bmad-quick-dev` triggers session-scoped escalation
  to the `small` profile — and the escalation is NOT written back to
  `_Sprintpilot/modules/autopilot/config.yaml`.
- Per-epic retrospectives are skipped (`retrospective_mode: skip`).
- A single commit per epic lands on the base branch (`git.granularity: epic`,
  `git.squash_on_merge: true`).
- The fingerprint-based resume detector handles a mid-sprint user edit
  to `sprint-status.yaml`.

Phase 2 ships the fixture skeleton; the live-LLM driver is Phase 7.

## Files

- `product-brief.md` — single epic, three stories. Trivial logic so the
  LLM's choices don't dominate runtime variance.
