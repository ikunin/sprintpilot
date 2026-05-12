# Number Guesser

A toy CLI game: pick a random integer in [1, 100]; player enters guesses
until correct; program reports `higher` / `lower` / `correct`.

## Why this fixture exists

This is the **nano-orchestrator** e2e fixture. It exists to exercise the
deterministic orchestrator (`autopilot.execution_mode: orchestrator`)
under the `nano` profile, where each story routes through
`bmad-quick-dev` rather than the full 7-step cycle.

The product itself is intentionally trivial so test runtime variance
isn't dominated by LLM-level reasoning about the product.

## Epic — single epic, three stories

1. **S1 — random target**: pick a random integer 1..100 at game start.
2. **S2 — guess loop**: read a guess from stdin; print `higher` / `lower`
   / `correct` and exit on `correct`.
3. **S3 — bounds**: reject non-numeric input with a one-line error.

## Acceptance criteria — per story

Each story has 2–3 unit tests. The full epic should land as a single
squashed commit (per `git.squash_on_merge: true`, `git.granularity: epic`).

## What the e2e test verifies

- Every story enters `nano_quick_dev`, not `create_story`.
- No retrospective artifacts produced (`retrospective_mode: skip`).
- No worktrees created (`git.worktree.enabled: false`).
- Each `bmad-quick-dev` invocation's `success.output` includes
  `tests_run > 0`, `tests_failed: 0`, `commit_sha`.
- If we synthetically force `tests_failed: 1` on S2 (by injecting a
  failing test), the session escalates to `small` for S3 — and the
  `complexity_profile` key in `config.yaml` is unchanged.
- After all stories complete, the orchestrator halts with state
  `sprint_finalize_pending`. Resuming runs the finalize step in a
  fresh context window.
