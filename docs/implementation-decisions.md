# Implementation decisions — Adaptive Process Scaling

A running log of non-obvious implementation choices made during the v2 rollout. Each entry: PR, category, decision, rationale, impact. Referenced by `docs/implementation-plan.md` cross-cutting section.

## PR 1 — Foundation

### D1.1 — architecture / config
**Decision:** `resolve-profile.js` reads autopilot config via regex, not via `readYaml()`.
**Rationale:** `workflow.md` uses `{{variable}}` placeholders that the YAML parser could technically interpret but the existing install.js path relies on preserving them verbatim. Following the precedent of `readExistingAutopilotConfig` (install.js:621) keeps a single code path for all write-back-preserving autopilot-config reads.
**Impact:** Low. The resolver's other reads (profile YAMLs, module YAMLs) use `js-yaml` normally since those files don't carry workflow placeholders.

### D1.2 — architecture / profile
**Decision:** `legacy` profile does NOT extend `_base.yaml`.
**Rationale:** Forward-compatibility guarantee (I9 in the review). If `legacy` inherited from `_base`, future edits to `_base` would silently drift legacy semantics — precisely what the `legacy` profile exists to prevent.
**Impact:** Low. Small duplication in `legacy.yaml` vs `_base.yaml`. Duplication is the point.

### D1.3 — scope
**Decision:** PR 1 writes `complexity_profile` to config but does not yet consume it from `workflow.md`.
**Rationale:** Plan sequences PR 1 as config-schema plumbing with zero behavior change. Behavior consumers land in PR 4 (nano routing) and later. This keeps PR 1 reviewable and independently shippable.
**Impact:** Low. Users who set a profile in v2.0.0 see no functional difference until v2.1.0. Documented in CHANGELOG.

### D1.4 — test-strategy
**Decision:** Test `check-prereqs.js` by calling its exported functions (`checkNode`, `checkGit`) rather than spawning the CLI.
**Rationale:** Vitest's tempdir fixture pattern doesn't help here (no filesystem to set up) and spawning a subprocess for every assertion is slow. The pure functions are deterministic given the same node/git environment.
**Impact:** Low. We lose the CLI-framing assertion (help text, exit codes) but keep them in one "main()" integration test that spawns once.

### D1.5 — workaround
**Decision:** `postinstall` banner from the implementation plan (C9) deferred to v2.0.1.
**Rationale:** Adding a postinstall script has its own review surface (npm security warnings, silent installs from CI matrices). For PR 1's "foundation ships as v2.0.0" scope, the `complexity_profile` missing-key default is sufficient to preserve existing installs. The banner is a nice-to-have, not a correctness requirement.
**Impact:** Low. Existing users on `^1.x` still upgrade silently and get medium behavior; they just won't see a one-liner saying so.

## PR 2 — M0 phase-timing instrumentation

### D2.1 — architecture / atomicity
**Decision:** `log-timing.js` writes each JSONL line with a single `fs.appendFileSync` and refuses to write lines longer than 4 KB (`LINE_MAX_BYTES`).
**Rationale:** POSIX `write()` is atomic up to `PIPE_BUF`, which is guaranteed ≥ 4 KB on every supported platform (Linux 4096, macOS 512 on pipes but ≥ 4096 on regular files via `O_APPEND`, Windows `FILE_APPEND_DATA` semantics). Capping lines at 4 KB means the single-writer-per-story model (one sub-agent = one writer) doesn't need file locks, and concurrent writers to *different* shards are trivially safe. The race-free test spawns 24 parallel subprocesses against the same shard — all 24 JSON lines survive intact.
**Impact:** Low. `--meta` is separately capped at 2 KB (the plan's contract), well inside the 4 KB line budget.

### D2.2 — architecture / config gating
**Decision:** `log-timing.js` reads `autopilot.phase_timings` itself via a narrow regex over `autopilot/config.yaml` (and profile overlays) instead of invoking `resolveProfile`.
**Rationale:** `resolveProfile` is invoked on every timing call — 20+ times per story. The full resolver reads 5 YAML files and calls `process.exit` on missing profiles; neither is desirable here. The dedicated reader short-circuits at the first explicit value (user override > profile overlay > `_base`), degrades to `false` if nothing matches (fail-safe — never write silently), and adds < 5 ms per call. Also avoids the subprocess-fork-in-subprocess chain that would happen if the timing script shelled out to `resolve-profile.js`.
**Impact:** Low. The gating logic is a few dozen lines and is covered by four unit tests against fixture project roots.

### D2.3 — test-strategy / isolation
**Decision:** The race-free test spawns **real subprocesses** via `spawnSync`, not in-process `appendLine` calls.
**Rationale:** In-process calls serialize on the V8 event loop; they wouldn't actually exercise kernel-level append atomicity. Running 24 independent node processes against the same shard is the real-world contention pattern (future PRs 11–12 will have multiple Claude Code sub-agents writing concurrently). Node startup makes the test ~800 ms, which is acceptable for a single race-safety assertion.
**Impact:** Low. Test is slow (relatively) but only runs once per vitest invocation.

### D2.4 — scope / workflow instrumentation
**Decision:** Wrap the main skill `INVOKE`, the code-review re-invoke, worktree add, submodule-init, test verification, and `git.commit` with start/end hooks. Skip `git.push`, `git.pr-create`, `git.merge`, `state.write` for now.
**Rationale:** Plan lists every git phase and state write as an insertion point, but the acceptance criterion is narrower: "every BMad skill invocation in workflow.md is wrapped." The instrumentation we shipped covers skills + the two phases most likely to dominate (worktree creation with submodule init is a known 30-second cost; `git.commit` is hit every story). The remaining git phases can be added later if summarizer hotspot data says they matter.
**Impact:** Low. Overhead per call is ~100 ms (node boot), within the acceptance budget. Adding more wrappers later is a single-line change per site.

### D2.5 — scope / invocation sentinel
**Decision:** When `{{current_story}}` is empty (sprint-level skills like `bmad-help`, `bmad-sprint-planning`), the workflow passes the literal `sprint` as the story key.
**Rationale:** `STORY_RE` rejects the empty string (path-traversal guard). Rather than weakening the regex or adding a conditional gate, we use a reserved sentinel that matches the regex and makes the story shard for sprint-level phases explicit in the artifact (`.timings/sprint.jsonl`).
**Impact:** Low. The summarizer treats `sprint` as one more story; it shows up cleanly in per-story wall-clock tables. Users cannot accidentally collide because user story keys are derived from epic-numbered patterns (`1-2-title`), never the literal word `sprint`.

## PR 3 — State-shard infrastructure

### D3.1 — architecture / file format
**Decision:** Shards use a flat dotted-keys + JSON flow-form shape (`a.b.c: 1`, `tags: ["x","y"]`) instead of block-form YAML.
**Rationale:** Block-form YAML requires a non-trivial parser to handle the key-to-list-item indent relationship correctly. A full parse library (js-yaml) would break the "scripts have no install-time deps" invariant set by `resolve-profile.js` in PR 1. Flat dotted-keys are still valid YAML (`"a.b": 1` is a single-key mapping), round-trip exactly via `setByDottedPath` + JSON flow-form on arrays, and fit the shard's single-writer append-or-replace pattern.
**Impact:** Low. Merged files (`autopilot-state.yaml`, `decision-log.yaml`) use the same shape. A human reading them sees lines like `stories.1-1-a.status: done` — slightly unconventional but unambiguous and grep-friendly.

### D3.2 — architecture / atomicity
**Decision:** Writes use `tmp-sibling + rename()` not `writeFileSync` or a lock file.
**Rationale:** POSIX `rename()` is atomic within a filesystem; readers either see the old file or the new file, never a partial. Same-story writers are single-writer by the sub-agent contract, so no cross-process locking is needed. Tmp file name includes `(pid, hrtime)` to keep distinct-story writers collision-free even when they share a kind directory.
**Impact:** Low. The merge script reads shards as whole files; no reader ever encounters a partially-written shard.

### D3.3 — architecture / tiebreaker
**Decision:** `updated_at` stores both `wall` (ISO8601 ms) and `monotonic` (`hrtime.bigint()` ticks).
**Rationale:** Monotonic is NTP-safe and strictly increasing within a process — correct for parallel-writer tiebreaks inside one session. Wall-clock is meaningful across processes/sessions but vulnerable to clock changes. Storing both lets `compareStamps` pick the right tool per case. `BigInt` parsing is wrapped in try/catch so a corrupt monotonic string falls back to wall-clock rather than throwing.
**Impact:** Low. Cost is ~40 bytes per shard write.

### D3.4 — test-strategy / race safety
**Decision:** The race-safety test spawns real subprocesses against DISTINCT story keys, not the same key.
**Rationale:** Same-story concurrent writes are explicitly out of contract (single-writer-per-story). The meaningful hazard is tmp-file collision between parallel writers to different stories sharing a kind directory; that's exactly what the distinct-story test exercises.
**Impact:** Low. Corresponds to the actual concurrency pattern PRs 11–12 will use.

### D3.5 — scope / partial workflow integration
**Decision:** PR 3 ships the scripts + schema but leaves workflow.md's state-write path untouched.
**Rationale:** Acceptance criterion #5 (`state_sharding: never` falls back to direct writes) is satisfied trivially if direct writes are still the only path in workflow.md. Rewriting STATE_FIELDS writes to route through shards is a PR 6 concern (coalescing) and PR 11 (parallel). Shipping the scripts now unblocks those PRs without destabilizing the current single-writer path.
**Impact:** Medium-low. Users see no behavior change on `auto` or `never`. The `always` mode is available for PR 6 to opt into.

## PR 4 — Nano routing

### D4.1 — architecture / session-scoped escalation
**Decision:** If quick-dev signals `severity: high` or tests fail under nano, the autopilot flips `{{implementation_flow}}` to `full` for the rest of the session only — never writes back to `config.yaml`.
**Rationale:** Persisting the flip would silently change the user's configured profile on disk, surprising them on the next run. Session-scoped escalation gives the safety net without the silent mutation. The decision is logged to `decision-log.yaml` with `category=scope, phase=autopilot:escalation` so users can trace why the cycle changed mid-sprint.
**Impact:** Low. Users who want a permanent switch to `small` can explicitly update their config.yaml; the log entry points them to the right knob.

### D4.2 — scope / skill skipping
**Decision:** Under `implementation_flow=quick`, the autopilot skips `bmad-create-story` and `bmad-check-implementation-readiness` entirely (not just `bmad-dev-story`).
**Rationale:** Quick-dev's own routing (BMad `step-01-clarify-and-route.md:40-44`) reads AC directly from `sprint-status.yaml` and synthesizes its own plan. Invoking `bmad-create-story` first would produce a story file quick-dev doesn't need, wasting an LLM call. The workflow's step-3 gate handles the two cases that could still arrive (`bmad-help` proposing either skill) by rewriting `{{next_skill}} = bmad-quick-dev`.
**Impact:** Low. Non-nano profiles continue to run all three skills unchanged.

### D4.3 — test-strategy / routing assertions
**Decision:** Nano routing is verified by asserting the *resolver output*, not by exercising workflow.md directly.
**Rationale:** Workflow.md is instruction text read by an LLM; there is no in-process "workflow runner" to unit-test. The routing correctness depends entirely on what `resolve-profile.js` returns for `autopilot.implementation_flow` (and related keys). If the resolver is right, the LLM-executed gates will pick the right branch. Asserting the resolver is the load-bearing test.
**Impact:** Low. Workflow gates are still reviewed manually; the unit test locks down the profile-to-flow contract.

## PR 5 — Nano orchestration cuts

### D5.1 — architecture / epic-id derivation
**Decision:** `{{epic_id}}` is derived lexically from `{{current_story}}` (leading numeric segment before the first `-`), not read from an "epics" structure.
**Rationale:** BMad encodes epic membership in the story key (`1-2-foo` → epic 1). Reading the epics file would couple the autopilot to its schema, which is out of scope for PR 5. The lexical rule handles every story key Sprintpilot has seen in real projects; stories with non-standard keys fall back to single-story "epic" behavior (first = last = true), which is the safe default.
**Impact:** Low. If a future BMad version changes the story-key convention, the autopilot's branching falls back to per-story anyway (the regex miss leaves `epic_id` empty, and the first/last defaults both become `true`).

### D5.2 — architecture / deferred push
**Decision:** Under `granularity=epic`, intermediate stories record `push_status=deferred`, `pr_url=DEFERRED` rather than "pending" or "skipped".
**Rationale:** "pending" already means "attempted but not complete"; "skipped" means "explicitly disabled". "deferred" is the new, distinct state "will be done at end of epic". Keeping these separate preserves the recovery semantics of boot branch-reconciliation — it retries `pending` branches, leaves `skipped` branches alone, and ignores `deferred` ones until the epic closes.
**Impact:** Low. Downstream consumers of git-status.yaml (sprint-report.txt, health-check.js) already treat unknown statuses as "don't touch", so the new value is forward-compatible.

### D5.3 — scope / merge strategy
**Decision:** `squash_on_merge=true` composes a single commit `feat(<epic_id>): epic <id> (<branch>)` and does NOT include every story's commit message in the squashed commit body.
**Rationale:** Squash commit bodies are trivially reconstructable via `git log <branch> ^<base>` after the fact, and adding them to the merge-commit message risks formatting quirks that break PR body generation. Keeping the squashed commit terse matches GitHub/GitLab's default squash-PR experience.
**Impact:** Low. PR bodies (via `create-pr.js`) still show the per-story commits when the platform renders the diff; the squashed commit is just a pointer.

### D5.4 — test-strategy / workflow coverage
**Decision:** PR 5 adds a sync-status.js passthrough test but no workflow-level unit test for the epic-branch decision tree.
**Rationale:** Same rationale as D4.3 — workflow.md branches are LLM-driven. The load-bearing parts are (a) sync-status.js correctly records epic_id + granularity (tested directly) and (b) the resolver returns `granularity=epic` for nano (tested by nano-routing.test.ts). The LLM's branch-picking then follows the rule that's spelled out in the workflow text.
**Impact:** Medium-low. Without an e2e fixture specifically exercising epic granularity end-to-end, regressions in the decision tree would escape unit tests. The existing greenfield e2e covers story granularity, so at minimum the default path is safe.

## PR 6 — Coalesce state writes

### D6.1 — architecture / pending file model
**Decision:** Coalescing uses a persistent `.pending/<kind>/<story>.yaml` sibling rather than an in-process buffer.
**Rationale:** State-shard.js is a cold process — one invocation per CLI call. An in-process buffer would evaporate between calls. A pending file is durable across subprocess invocations AND across the host agent's context compaction. Side benefit: a crash mid-story leaves the pending buffer on disk; the next invocation's `flush` recovers it, so batched writes are not silently lost.
**Impact:** Low. Pending files are auto-cleared after flush and after any critical-key bypass. Directory `.pending/` sits alongside `.archive/` under `_bmad-output/implementation-artifacts/`, which is already gitignored in templates.

### D6.2 — architecture / critical-key bypass
**Decision:** Four keys bypass the buffer: `current_story`, `current_bmad_step`, `in_worktree`, `patch_commits`.
**Rationale:** Each one is required for crash-resume correctness. `current_story` + `current_bmad_step` tell the next session where to pick up. `in_worktree` decides whether to `cd` into a worktree before any subsequent action. `patch_commits` must be persisted per-patch in step 6 so a crash mid-loop doesn't orphan a commit. All other fields (test counts, file lists, lint output, story metadata) are reconstructable or non-load-bearing.
**Impact:** Low. Critical writes trigger an immediate flush-then-write, so the shard ends up with BOTH the prior buffered fields AND the critical payload. Verified by `batch with a critical key auto-flushes prior buffered fields + itself` test.

### D6.3 — architecture / write semantics
**Decision:** The direct `write` action auto-flushes pending before writing.
**Rationale:** Without this, a caller who mixes `batch` and `write` would leave stale pending fields behind, where subsequent `read` sees them but `write` did not. Auto-flush preserves the invariant "after any action, pending is empty OR contains strictly-newer-than-shard data."
**Impact:** Low. The cost is one extra shard read+write when both pending and direct-write happen in the same session. The win is that the shard's field set is always consistent with the caller's mental model.

### D6.4 — scope / no workflow.md migration yet
**Decision:** PR 6 ships the batch/flush API and the profile flag, but does NOT rewire the existing STATE_FIELDS direct writes in workflow.md to go through `batch`.
**Rationale:** The current STATE_FIELDS path writes directly to `autopilot-state.yaml` (single-writer, pre-shard). Migrating it requires running `merge-shards.js` at every read, which only pays off once parallel sub-agents (PR 11) actually share a story's state. Shipping the API alone unblocks PR 11 without destabilizing the current single-writer path. Acceptance criterion #3 ("final merged state YAMLs identical to pre-PR") is trivially satisfied because the direct-write path hasn't changed.
**Impact:** Medium-low. Users on non-legacy profiles see `coalesce_state_writes: true` but no behavior difference until PR 11 consumes it.
**Decision:** PR 5 adds a sync-status.js passthrough test but no workflow-level unit test for the epic-branch decision tree.
**Rationale:** Same rationale as D4.3 — workflow.md branches are LLM-driven. The load-bearing parts are (a) sync-status.js correctly records epic_id + granularity (tested directly) and (b) the resolver returns `granularity=epic` for nano (tested by nano-routing.test.ts). The LLM's branch-picking then follows the rule that's spelled out in the workflow text.
**Impact:** Medium-low. Without an e2e fixture specifically exercising epic granularity end-to-end, regressions in the decision tree would escape unit tests. The existing greenfield e2e covers story granularity, so at minimum the default path is safe.
**Decision:** Nano routing is verified by asserting the *resolver output*, not by exercising workflow.md directly.
**Rationale:** Workflow.md is instruction text read by an LLM; there is no in-process "workflow runner" to unit-test. The routing correctness depends entirely on what `resolve-profile.js` returns for `autopilot.implementation_flow` (and related keys). If the resolver is right, the LLM-executed gates will pick the right branch. Asserting the resolver is the load-bearing test.
**Impact:** Low. Workflow gates are still reviewed manually; the unit test locks down the profile-to-flow contract.
**Decision:** PR 3 ships the scripts + schema but leaves workflow.md's state-write path untouched.
**Rationale:** Acceptance criterion #5 (`state_sharding: never` falls back to direct writes) is satisfied trivially if direct writes are still the only path in workflow.md. Rewriting STATE_FIELDS writes to route through shards is a PR 6 concern (coalescing) and PR 11 (parallel). Shipping the scripts now unblocks those PRs without destabilizing the current single-writer path.
**Impact:** Medium-low. Users see no behavior change on `auto` or `never`. The `always` mode is available for PR 6 to opt into.
**Decision:** When `{{current_story}}` is empty (sprint-level skills like `bmad-help`, `bmad-sprint-planning`), the workflow passes the literal `sprint` as the story key.
**Rationale:** `STORY_RE` rejects the empty string (path-traversal guard). Rather than weakening the regex or adding a conditional gate, we use a reserved sentinel that matches the regex and makes the story shard for sprint-level phases explicit in the artifact (`.timings/sprint.jsonl`).
**Impact:** Low. The summarizer treats `sprint` as one more story; it shows up cleanly in per-story wall-clock tables. Users cannot accidentally collide because user story keys are derived from epic-numbered patterns (`1-2-title`), never the literal word `sprint`.
