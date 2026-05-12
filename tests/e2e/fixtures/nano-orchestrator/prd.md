# PRD — Number Guesser

> This is the **PRD** (Product Requirements Document) — the mandatory BMad
> authoring artifact consumed by `bmad-create-architecture` and
> `bmad-create-epics-and-stories`. The (optional) product brief lives
> upstream and was the discovery input for this PRD.

## Problem

Users learning a tutorial-grade project need a toy CLI game they can fully
understand in a single sitting. The product is intentionally trivial so the
**nano-orchestrator** e2e test focuses on orchestrator behavior, not on
LLM-level reasoning about the product.

## Goals

A CLI game: pick a random integer in [1, 100]; player enters guesses until
correct; program reports `higher` / `lower` / `correct`.

## Functional requirements

1. On start, the program selects a uniformly random integer in `[1, 100]`.
2. The program reads a guess from stdin, parses it as an integer.
3. For each guess, the program prints `higher`, `lower`, or `correct` on
   one line.
4. On `correct`, the program exits with status 0.
5. Non-numeric input prints a one-line error and prompts again (does not
   crash, does not exit non-zero on the first malformed line).

## Epic 1 — Number Guesser

Three stories. All three are independent within the epic.

### S1 — random target

Pick a random integer 1..100 at game start. Tests assert distribution
(not uniformity; just bounds) over 100 invocations.

### S2 — guess loop

Read a guess from stdin; print `higher` / `lower` / `correct` and exit on
`correct`. Tests use a piped input and assert stdout per round.

### S3 — bounds

Reject non-numeric input with a one-line error. The loop continues; only
`correct` causes exit 0.

## Non-functional requirements

- Single-file implementation; ≤80 LOC of product code.
- Vitest tests; pinned to the repo's test framework.

## What the e2e test verifies

- Every story enters `nano_quick_dev`, not `create_story`.
- No retrospective artifacts (`retrospective_mode: skip`).
- No worktrees (`git.worktree.enabled: false`).
- Each `bmad-quick-dev` invocation's `success.output` includes
  `tests_run > 0`, `tests_failed: 0`, `commit_sha`.
- If we synthetically force `tests_failed: 1` on S2, the session escalates
  to `small` for S3 — and the `complexity_profile` key in `config.yaml`
  is unchanged.
- After all stories complete, the orchestrator halts with state
  `sprint_finalize_pending`. Resuming runs the finalize step in a fresh
  context window.
