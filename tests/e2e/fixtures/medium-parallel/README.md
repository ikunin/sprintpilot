# medium-parallel fixture

E2E fixture exercising the orchestrator's `parallel_batch` path under
the **medium** profile with `ma.parallel_stories: true` and
`ma.max_parallel_stories: 2`.

## Why this fixture exists

Medium is the default profile. With parallelism enabled, the orchestrator
dispatches independent stories concurrently — but only on hosts that
declare parallel support (Claude Code today; Gemini CLI behind the
`experimental_parallel_on_gemini` flag).

This fixture verifies:

- Independent stories run in parallel (per-story branches created
  concurrently, no serial waiting on the DAG resolver output).
- The classifier in `parallel-batch.js#classifyResults` aggregates
  per-child statuses into a single batch signal correctly.
- Conflict-detected pairs (per `preflight-merge.js`) are serialized.
- A failing child does NOT cancel siblings mid-flight (best-effort
  parallel — orchestrator collects all results before halting).
- On hosts WITHOUT parallel support, the batch silently degrades to
  sequential — same artifacts, no `parallel_stories=true` panic.

## Files

- `product-brief.md` — 2 epics × 2 stories each. Story dependencies
  laid out so stories within an epic are independent (can run in
  parallel) but the second epic depends on the first being done.
