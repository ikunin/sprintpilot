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

## PR 7 — Conditional boot work

### D7.1 — architecture / fail-open counting
**Decision:** When `git worktree list --porcelain` or the status-file read fails, `{{worktree_count}}` and `{{in_progress_count}}` default to values that FORCE the full path (2 and 1 respectively).
**Rationale:** The guard condition is `flag AND worktree_count==1 AND in_progress_count==0`. Any counting failure must not accidentally satisfy the clean-repo predicate — because a clean repo means "we're sure there's nothing to reconcile", and uncertainty is the opposite. Fail-open to the full reconciliation keeps the safety-critical path intact.
**Impact:** Low. Users whose `git` is degraded (< 2.5) or whose sprint-status.yaml is missing see the full boot path anyway.

### D7.2 — scope / large profile never fast-paths
**Decision:** `large.yaml` pins `conditional_boot_work: false` explicitly — not inherited from `_base`.
**Rationale:** The `large` profile targets production systems with compliance/uptime stakes. Skipping health-checks to save 8–30s of boot time is the wrong tradeoff when a silent worktree-orphan or unmerged branch could turn into a release-day surprise. Pinning explicitly is easier to audit than deriving it by deduction from the base.
**Impact:** Low. `large` users pay a few seconds more per session and trade it for the boot-time audit trail.

### D7.3 — test-strategy / profile table over workflow execution
**Decision:** The test locks the per-profile value of `autopilot.conditional_boot_work`, not the workflow's runtime decision path.
**Rationale:** Same reasoning as D4.3 and D5.4 — workflow.md is LLM-driven instruction text, not executable code. The load-bearing correctness claim is "large + legacy never fast-path; nano + small + medium do when the repo is clean." The unit test proves the profile half; the workflow text then enforces the cleanness predicate verbatim.
**Impact:** Low. Regression surface is narrow: either a profile YAML flips the flag unintentionally (caught by the test) or the workflow's guard is rewritten (caught by code review / integration).

## PR 8 — Cached per-iteration reads

### D8.1 — architecture / mtime-aware TTL
**Decision:** Cache entries invalidate on BOTH TTL expiry AND source-file mtime advance — not just TTL.
**Rationale:** Relying on explicit `invalidate` calls from workflow.md would make forgetting one an easy correctness bug (silently stale reads). Source-mtime has kernel-level guarantees on every supported platform — if any process writes to the source, its mtime advances, and our next read misses. This makes the cache safe against both our own writes AND external writes (git checkout, hand edits) without any caller cooperation.
**Impact:** Low. Cache overhead is one extra `fs.statSync` per hit — negligible.

### D8.2 — architecture / per-project cache root
**Decision:** Cache root defaults to the project root; no system-wide cache.
**Rationale:** Per-project keeps caches isolated across repos. A shared global cache would risk cross-project collision (same filename hash mapping to different projects) and complicate cleanup. The project-local `.cache/` sits alongside `.archive/` and is already in the repo's .gitignore scope.
**Impact:** Low. Directory is auto-created on first write and cleared by `clearAll`.

### D8.3 — scope / workflow consumption
**Decision:** PR 8 ships the helper + flag but does not rewrite every workflow.md read-site to route through it.
**Rationale:** Systematically rewriting every read in workflow.md risks breaking subtly (especially inside `<check>` gates where the LLM is expected to evaluate YAML content). The helper is available for targeted callouts (PR 11 will use it in the main loop), and for users who want to experiment by wiring it into custom skills. The safety invariant is that `cache_shared_reads: false` and the helper being unused produce byte-identical behavior today.
**Impact:** Medium-low. The win lands opportunistically as future PRs route reads through the cache.

## PR 9 — Dependency sidecar + DAG resolver

### D9.1 — architecture / purpose-built YAML parser
**Decision:** `resolve-dag.js` ships its own YAML parser instead of reusing state-shard's flat-dotted-keys parser OR pulling in `js-yaml`.
**Rationale:** Hand-authored `dependencies.yaml` uses block-form YAML per the plan's canonical example. The state-shard parser is deliberately flat-only (D3.1). `js-yaml` would break the "scripts have zero install-time deps" invariant set by `resolve-profile.js` and re-affirmed by D3.1. A purpose-built narrow parser — nested objects, block-form lists with inline mappings, flow-form arrays on the value side, quoted keys, trailing comments — handles everything the plan's schema uses and no more.
**Impact:** Low. 22 tests pin the parser's shape; features not covered by them should either be added to the tests or stay out of the file format.

### D9.2 — architecture / list-item indent rule
**Decision:** List-item frames carry a `fromListItem` flag that softens the pop rule from `indent >= top.indent` to `indent > top.indent`.
**Rationale:** YAML treats `- key: value` as equivalent to `-\n  key: value`. The "first key column" of a list entry matches the dash column + 2; subsequent sibling keys in that entry share the same column. Without the flag, a sibling key would be mistaken for an outdent sibling and get written to the parent list instead of the current item.
**Impact:** Low. The flag is only set when a list item is pushed; normal object nesting is unaffected.

### D9.3 — architecture / descend gate
**Decision:** Descend into `top.pendingKey`'s value only when the current line's indent is strictly greater than `top.pendingKeyIndent`, not `top.indent`.
**Rationale:** After a pop, `top.indent` may be far shallower than the freshly-popped frame's indent; using `top.indent` would incorrectly absorb outdent-sibling keys as nested children. `pendingKeyIndent` records where the pendingKey was assigned, so only indents past that line are true descendants.
**Impact:** Low. Tested by the "overrides at indent 0 is a sibling of stories at indent 0" case in the full-document parser test.

### D9.4 — scope / files strategy deferred
**Decision:** The `files` strategy (edge inference from shared file-path touches in story Tasks/Subtasks) is listed as valid but not implemented.
**Rationale:** Implementing it requires reading + parsing BMad story files, and its heuristic edges compete with the explicit sidecar anyway. Users who want AI-inferred graphs should route through a future `sprintpilot-infer-dependencies` skill that proposes a `dependencies.yaml` for human review (concept §7.6). Shipping a half-baked heuristic would encourage silent surprises.
**Impact:** Low. Users who set `--strategy files` get the same output as the default `explicit,ordering`; the string is accepted but contributes no edges.

### D9.5 — UX / scaffold ships inline docs
**Decision:** `scaffold` writes a header comment block into `dependencies.yaml` explaining the schema + upgrade path to parallel execution.
**Rationale:** Addresses M11 (discoverability) from the plan. A user running `resolve-dag.js scaffold` as a setup step sees the same docs they'd otherwise have to find in the concept doc. The starter document is a safe linear chain, making parallelism opt-in rather than on-by-default.
**Impact:** Low. Header is a few lines; cost in write-time is negligible.

## PR 10 — Worktree cost mitigation

### D10.1 — architecture / retry only on ref-lock stderr
**Decision:** `with-retry.js` retries only when stderr matches the configured regex AND exit is non-zero. Other failures pass through unchanged.
**Rationale:** Blind retry hides legitimate bugs (missing files, auth errors, syntax errors) behind repeated attempts. Limiting retry to the known-transient ref-lock failure pattern keeps the safety net narrow. Users can widen it via `--pattern` for specific call-sites where a different class of transient is known.
**Impact:** Low. The default regex is the plan's verbatim set; custom patterns require explicit opt-in.

### D10.2 — architecture / submodule lock path outside .git
**Decision:** Submodule locks live at `<project>/.sprintpilot/submodule-locks/<slug>.lock`, not inside `.git/modules/`.
**Rationale:** Files inside `.git/` that git doesn't recognize trigger warnings on some operations, and a future git version could treat them as stale worktree metadata and clean them up. `.sprintpilot/` is already gitignored alongside `_bmad-output/` in the templates, so locks don't leak into user commits either. Slugification (`[a-z0-9-]`, capped at 64 chars) keeps filesystem names safe on every supported platform.
**Impact:** Low. Lock lifecycle is identical to `lock.js`'s; only the path differs.

### D10.3 — scope / no submodule fixture yet
**Decision:** PR 10 adds unit tests for the retry and lock helpers but does NOT ship the `tests/e2e/fixtures/with-submodule/` fixture from the plan.
**Rationale:** The plan describes a real `.gitmodules` with an embedded sibling repo. Constructing that fixture involves `git init` + `git submodule add` over shelled-out commands, makes the fixture path depend on the host's git version, and the actual wall-clock improvement (2–5s vs ~30s) is indistinguishable from test-run variance without a multi-worktree test harness. The unit tests lock in retry + lock correctness; the wall-clock claim can be validated via `log-timing.js` in a real project.
**Impact:** Medium. Regression in the workflow-level submodule init command (e.g. a typo in the `--reference` flag) would escape unit tests. The `worktree-path-audit.test.ts` catches the most common mistake (treating worktree `.git` as a dir); future fixture additions can extend coverage.

### D10.4 — architecture / gc.auto save/restore on every worktree
**Decision:** Save + restore `gc.auto` on both the main repo AND every worktree, independently.
**Rationale:** `git config --local` scopes to the current worktree's config. Setting it on the main repo does NOT propagate to worktrees. The asymmetry can lead to surprises where a worktree's gc still triggers mid-session. Saving the prior value per-worktree is belt-and-suspenders and costs ~2 git calls per worktree setup + teardown.
**Impact:** Low. The restore is best-effort (ignore-failure-on-unset); in the rare case a restore fails, the user is left with `gc.auto=0` on one worktree, which is conservative rather than dangerous.

## PR 11 — Parallel intra-epic stories

### D11.1 — architecture / host detection priority
**Decision:** Env vars (HIGH) > parent process name (MEDIUM) > filesystem markers (LOW). Filesystem-only detection FORCES `supports_parallel=false` regardless of which host the markers imply.
**Rationale:** The install layout — `.claude/skills/`, `.cursor/`, etc. — proves the install *target*, not the currently-running host. A user can `sprintpilot install --target claude-code` and then invoke from Cursor; the markers say "claude-code" but the running host is Cursor. The tautology guard turns a confident-looking filesystem signal into a low-confidence one, closing concept §M13's concern.
**Impact:** Medium-low. Users running Sprintpilot under Claude Code always set `CLAUDECODE=1`, so the high-confidence path triggers and parallelism works. Users under other hosts see sequential, which is the correct behavior.

### D11.2 — architecture / no LLMs from Sprintpilot scripts
**Decision:** `dispatch-layer.js` writes a `.layer-plan.json` but does not itself invoke the host agent.
**Rationale:** Sprintpilot scripts are pure infrastructure (concept §7.6). Invoking an LLM from a script would break tool-agnostic correctness: Sprintpilot must work identically on every host, and host agents have wildly different sub-agent APIs. Delegating sub-agent spawning to workflow.md (which the host reads) keeps the dispatch surface thin and host-specific behavior in the host's hands.
**Impact:** Low. Workflow.md's main loop gates on `{{host_supports_parallel}} AND {{host_confidence}}=="high"` before dispatching; otherwise falls back to sequential.

### D11.3 — architecture / silent-degrade default
**Decision:** `parallel_stories: true` on a host without parallel support coerces to `false` with a single log line; it does NOT raise an error.
**Rationale:** Users authoring `medium`/`large` profiles on a shared codebase don't know which host every collaborator runs. Raising an error would force every non-Claude-Code user to override the flag. Coercion gives predictable sequential behavior with a discoverable log line, which matches the plan's "no silent no-op" requirement.
**Impact:** Low. The log line is emitted exactly once per session (via the workflow's boot step), so it doesn't flood output.

### D11.4 — scope / no e2e parallel test
**Decision:** PR 11 adds unit tests for adapter + dispatcher but no e2e `tests/e2e/medium-parallel.test.ts`.
**Rationale:** The plan lists the e2e as desirable but gates it on Claude Code availability in CI (which isn't a given in external contributor environments). Unit tests lock in the adapter's detection logic and the dispatcher's plan-generation correctness; the real-world speedup is measurable via `log-timing.js` on any repo with the flag flipped.
**Impact:** Medium. A regression in the host-to-dispatcher wiring would escape unit tests. The log-timing data surfaces it quickly in real use, and CI can add the e2e later when a reliable Claude Code harness exists.

## PR 12 — Cross-epic parallelism (experimental)

### D12.1 — architecture / commit-between-merges
**Decision:** `tryMergePair` drops `--no-commit` and lets each merge land as a commit on the preflight branch before attempting the next merge.
**Rationale:** The plan's suggested sequence (`git merge --no-commit --no-ff epic-1 && git merge --no-commit --no-ff epic-2`) is a non-starter — git refuses a second merge while `MERGE_HEAD` is still set from the first. The only clean way to test conflict behavior *between* two epics on top of a fresh base is to commit merge A, then try merge B. The preflight branch is force-deleted afterwards, so the committed merges never reach a published branch.
**Impact:** Low. Users who want to replicate the preflight manually can do it in 3 git commands: `git checkout -B tmp main && git merge --no-edit <a> && git merge --no-edit <b>`.

### D12.2 — architecture / per-pair cleanup inside try/finally
**Decision:** `tryMergePair` checks out the base branch and `branch -D __sprintpilot_preflight` in a `finally` block, so even a mid-merge throw leaves the repo on base with no stale branch.
**Rationale:** A conflict during the first merge leaves the worktree with merge markers AND `MERGE_HEAD` set; an unhandled exception would leave the user stuck. Wrapping in `finally` plus the `--abort` inside the error path keeps the invariant "after preflight, you are on base, no preflight branch exists" regardless of success/failure.
**Impact:** Low. Startup-cleanup at the next run's beginning is the second line of defense.

### D12.3 — architecture / opt-in everywhere (including large)
**Decision:** `parallel_epics: false` is pinned explicitly on `large.yaml`, not inherited from `_base`.
**Rationale:** `_base` is where future profile-wide defaults flip on (as PRs 2, 6, 7, 8 already did). Without an explicit pin, a future `_base` flip to `parallel_epics: true` would silently enable cross-epic parallelism for users on the compliance-oriented `large` profile. That's the opposite of what `large`'s caller wants. The explicit pin is a tripwire that surfaces such changes at review time.
**Impact:** Low. Duplication is the point, as with `legacy.yaml`'s settings (D1.2).

### D12.4 — scope / workflow dispatcher not yet wired
**Decision:** PR 12 ships the preflight script but does NOT add a cross-epic dispatcher gate to workflow.md.
**Rationale:** Cross-epic dispatch requires both epics' branches to be pushed AND both epics' stories to be reasonably done (otherwise parallel "execution" is just parallel git operations). That's a richer orchestration than PR 11's intra-epic dispatch, and adds three new failure modes (partial-epic state reconciliation, cross-epic decision-log merges, cross-epic retrospective ordering). Shipping the probe alone unblocks users to write their own cross-epic harness and surfaces any preflight bugs early. The workflow integration can land in a follow-up PR once one real user has exercised the probe.
**Impact:** Medium. `parallel_epics: true` today has no effect without a dispatcher. The flag and the script are consistent in meaning; users can call the script directly via `node _Sprintpilot/scripts/preflight-merge.js --epics 1,2 --base main`.
**Decision:** PR 11 adds unit tests for adapter + dispatcher but no e2e `tests/e2e/medium-parallel.test.ts`.
**Rationale:** The plan lists the e2e as desirable but gates it on Claude Code availability in CI (which isn't a given in external contributor environments). Unit tests lock in the adapter's detection logic and the dispatcher's plan-generation correctness; the real-world speedup is measurable via `log-timing.js` on any repo with the flag flipped.
**Impact:** Medium. A regression in the host-to-dispatcher wiring would escape unit tests. The log-timing data surfaces it quickly in real use, and CI can add the e2e later when a reliable Claude Code harness exists.
**Decision:** Save + restore `gc.auto` on both the main repo AND every worktree, independently.
**Rationale:** `git config --local` scopes to the current worktree's config. Setting it on the main repo does NOT propagate to worktrees. The asymmetry can lead to surprises where a worktree's gc still triggers mid-session. Saving the prior value per-worktree is belt-and-suspenders and costs ~2 git calls per worktree setup + teardown.
**Impact:** Low. The restore is best-effort (ignore-failure-on-unset); in the rare case a restore fails, the user is left with `gc.auto=0` on one worktree, which is conservative rather than dangerous.
**Decision:** `scaffold` writes a header comment block into `dependencies.yaml` explaining the schema + upgrade path to parallel execution.
**Rationale:** Addresses M11 (discoverability) from the plan. A user running `resolve-dag.js scaffold` as a setup step sees the same docs they'd otherwise have to find in the concept doc. The starter document is a safe linear chain, making parallelism opt-in rather than on-by-default.
**Impact:** Low. Header is a few lines; cost in write-time is negligible.
**Decision:** PR 8 ships the helper + flag but does not rewrite every workflow.md read-site to route through it.
**Rationale:** Systematically rewriting every read in workflow.md risks breaking subtly (especially inside `<check>` gates where the LLM is expected to evaluate YAML content). The helper is available for targeted callouts (PR 11 will use it in the main loop), and for users who want to experiment by wiring it into custom skills. The safety invariant is that `cache_shared_reads: false` and the helper being unused produce byte-identical behavior today.
**Impact:** Medium-low. The win lands opportunistically as future PRs route reads through the cache.
**Decision:** The test locks the per-profile value of `autopilot.conditional_boot_work`, not the workflow's runtime decision path.
**Rationale:** Same reasoning as D4.3 and D5.4 — workflow.md is LLM-driven instruction text, not executable code. The load-bearing correctness claim is "large + legacy never fast-path; nano + small + medium do when the repo is clean." The unit test proves the profile half; the workflow text then enforces the cleanness predicate verbatim.
**Impact:** Low. Regression surface is narrow: either a profile YAML flips the flag unintentionally (caught by the test) or the workflow's guard is rewritten (caught by code review / integration).
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
