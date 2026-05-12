# Two-epic Calculator Service

Tiny HTTP service with two endpoints:

- `POST /add  { a, b } → { sum }`
- `POST /mul  { a, b } → { product }`

## Why this fixture exists

This is the **medium-parallel** e2e fixture. It exercises the
orchestrator's `parallel_batch` action on a host with parallel support.

The product is intentionally tiny — total LOC budget is ~80 lines of
service code + tests — so runtime variance is dominated by orchestration
overhead (the thing we care about) and not by LLM-level decisions.

## Epic layout

### Epic 1 — adapter
- **S1.1** — HTTP server boilerplate (port from env, /health endpoint).
- **S1.2** — input parser/validator.

### Epic 2 — arithmetic
- **S2.1** — /add endpoint.
- **S2.2** — /mul endpoint.

Within each epic, the two stories are independent (different files,
different test fixtures). Between epics, Epic 2 depends on Epic 1.

## What the e2e test verifies

- With `ma.parallel_stories: true`, S1.1 and S1.2 run concurrently in
  separate worktrees; same for S2.1 and S2.2.
- `parallel_batch.classifyResults` correctly aggregates the per-child
  results when at least one fails.
- Three repeat runs produce semantically-equivalent artifacts (same
  commit count per branch, same files-changed lists, same ledger
  action sequence).
- On Gemini CLI without the experimental flag, the run silently
  serializes — produces the same artifacts (modulo timing).
