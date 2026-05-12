# PRD — Two-epic Calculator Service

> This is the **PRD** (Product Requirements Document) — the mandatory BMad
> authoring artifact consumed by `bmad-create-architecture` and
> `bmad-create-epics-and-stories`. There is no upstream brief for this
> fixture; the PRD is the starting point.

## Problem

A tiny HTTP service that demonstrates two independent endpoints. Chosen
intentionally simple so the **medium-parallel** e2e test focuses on the
orchestrator's `parallel_batch` dispatch behavior, not on LLM-level
reasoning about the product.

## Functional requirements

1. `POST /add  { a, b } → { sum }`
2. `POST /mul  { a, b } → { product }`
3. `/health` returns 200 with `{ ok: true }`.
4. Input validation: both `a` and `b` must be finite numbers; otherwise
   400 with `{ error: 'invalid_input' }`.

## Epic 1 — Adapter

Two **independent** stories within the epic (different files, different
test fixtures, no shared state):

- **S1.1** — HTTP server boilerplate. Read port from `PORT` env var;
  default 8080. Implement `/health`.
- **S1.2** — Input parser/validator. Pure function consumed by Epic 2
  endpoints.

## Epic 2 — Arithmetic

Depends on Epic 1 (uses the parser from S1.2). Within the epic, the two
stories are independent:

- **S2.1** — `/add` endpoint, wired through the S1.2 parser.
- **S2.2** — `/mul` endpoint, wired through the S1.2 parser.

## Non-functional requirements

- ~80 LOC total of product code + tests.
- Vitest for testing.
- No external dependencies beyond the repo's existing stack.

## What the e2e test verifies

- With `ma.parallel_stories: true`, S1.1 and S1.2 run concurrently in
  separate worktrees; same for S2.1 and S2.2.
- `parallel_batch.classifyResults` correctly aggregates per-child results
  when at least one fails.
- Three repeat runs produce semantically-equivalent artifacts (same
  commit count per branch, same files-changed lists, same ledger action
  sequence).
- On Gemini CLI without the experimental flag, the run silently
  serializes — produces the same artifacts (modulo timing).
