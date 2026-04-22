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
**Decision:** When `{{current_story}}` is empty (sprint-level skills like `bmad-help`, `bmad-sprint-planning`), the workflow passes the literal `sprint` as the story key.
**Rationale:** `STORY_RE` rejects the empty string (path-traversal guard). Rather than weakening the regex or adding a conditional gate, we use a reserved sentinel that matches the regex and makes the story shard for sprint-level phases explicit in the artifact (`.timings/sprint.jsonl`).
**Impact:** Low. The summarizer treats `sprint` as one more story; it shows up cleanly in per-story wall-clock tables. Users cannot accidentally collide because user story keys are derived from epic-numbered patterns (`1-2-title`), never the literal word `sprint`.
