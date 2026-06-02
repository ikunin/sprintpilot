# Architecture

## Design Principles

1. **Additive** — never modifies BMad Method's own files; survives BMad Method updates
2. **Graceful degradation** — every feature fails safely (no git? skip git ops. No CLI? print manual commands)
3. **Skills as prompts** — skills are markdown instructions, not executable code. Scripts handle complex logic.
4. **Session-aware** — all state lives in files, enabling crash recovery across sessions

## Directory Structure

```
_Sprintpilot/
├── manifest.yaml              # Version, BMad Method compatibility, module flags
├── Sprintpilot.md             # Comprehensive skill reference (permanent home)
├── .secrets-allowlist         # Patterns exempt from secrets scanning
│
├── templates/
│   └── agent-rules.md         # Enforcement block template (with markers)
│
├── modules/
│   ├── git/
│   │   ├── config.yaml        # Git workflow configuration (granularity, branches, PR flow)
│   │   ├── platform.yaml      # CLI command templates (GitHub, GitLab, Bitbucket, Gitea)
│   │   └── templates/         # Commit message and PR body templates
│   ├── ma/
│   │   └── config.yaml        # Multi-agent + parallelism configuration
│   └── autopilot/
│       ├── config.yaml        # Profile selection + session/retro settings
│       └── profiles/          # v2 base+overlay YAMLs
│           ├── _base.yaml     # Shared defaults (inherited by nano/small/medium/large)
│           ├── nano.yaml      # quick-dev one-shot flow, epic granularity
│           ├── small.yaml     # Minimal overlay
│           ├── medium.yaml    # Minimal overlay (default)
│           ├── large.yaml     # Parallel stories, state-sharding always
│           └── legacy.yaml    # v1.0.5 byte-for-byte (version_pinned)
│
├── bin/
│   └── autopilot.js           # Orchestrator CLI: start | next | record | state | report | validate-config | status
│                              # Emits typed Actions, consumes typed Signals; drives the BMad 7-step state machine
│
├── lib/
│   ├── orchestrator/          # 15 pure modules — state-machine, adapt, profile-rules, verify, impact-classifier,
│   │   │                      # decision-log, state-store, action-ledger, divergence, user-commands,
│   │   │                      # user-command-applier, parallel-batch, git-plan, report, land
│   │   └── ...
│   └── runtime/               # Shared zero-dep helpers for scripts (args, git, http, log, secrets, spawn, text, yaml-lite)
│
├── scripts/                   # Node.js helpers invoked by the orchestrator (zero runtime deps)
│   ├── # — Core git / commit pipeline —
│   ├── lock.js                # Mutex with stale timeout
│   ├── health-check.js        # Orphaned worktree classification
│   ├── stage-and-commit.js    # Explicit staging with secrets / size / binary checks
│   ├── sanitize-branch.js     # Story key → valid branch name
│   ├── detect-platform.js     # Platform auto-detection
│   ├── create-pr.js           # PR/MR creation across 4 platforms
│   ├── sync-status.js         # Git metadata → git-status.yaml (granularity-aware)
│   ├── lint-changed.js        # Multi-language linting
│   ├── git-portable.js        # Cross-platform helpers (count-worktrees, config-get, common-dir, safe-add)
│   │
│   ├── # — V2 profile + scaling —
│   ├── resolve-profile.js     # Profile resolution (base+overlay, fallback to medium)
│   ├── check-prereqs.js       # Node ≥ 18, git ≥ 2.18 enforcement
│   ├── log-timing.js          # Phase timing (mark / start / end / _end sentinel)
│   ├── summarize-timings.js   # Hotspot report (>5% of total time)
│   ├── state-shard.js         # Per-story shards: write/read/append/init/batch/flush
│   ├── merge-shards.js        # Shards → authoritative project YAMLs (atomic, archive)
│   ├── cached-read.js         # TTL + mtime-aware file cache
│   ├── inject-tasks-section.js # Deterministic Tasks/Subtasks recovery
│   ├── list-remaining-stories.js # Indent-agnostic sprint-status scanner
│   ├── mark-done-stories-tasks.js # Fenced-block-aware task checkbox repair
│   │
│   ├── # — DAG + parallel dispatch —
│   ├── infer-dependencies.js  # LLM JSON envelope → validated dependencies.yaml
│   ├── resolve-dag.js         # graph / layers / width / scaffold (Kahn cycle detection)
│   ├── agent-adapter.js       # Host detection (env > parent process > markers)
│   ├── dispatch-layer.js      # Worktree-per-story preflight + .layer-plan.json
│   ├── preflight-merge.js     # Cross-epic merge-conflict probe
│   ├── submodule-lock.js      # Per-submodule lock to serialize init
│   └── with-retry.js          # Ref-lock-pattern jittered backoff (3 attempts)
│
└── skills/                    # Installed to <tool>/skills/ by bin/sprintpilot.js install
    ├── sprint-autopilot-on/   # Enhanced autopilot (profile-aware, parallel-capable)
    ├── sprint-autopilot-off/  # Graceful exit + status report
    ├── sprintpilot-update/    # In-IDE update flow
    ├── sprintpilot-codebase-map/     # 5 parallel analysis agents
    ├── sprintpilot-assess/           # 3 parallel assessment agents
    ├── sprintpilot-reverse-architect/ # 3 parallel extraction agents
    ├── sprintpilot-migrate/          # 12-step workflow, 4 agents
    └── sprintpilot-research/         # N parallel research agents
```

## Key Mechanisms

### System Prompt Enforcement

The add-on installs **system prompt files** that make every AI agent session aware of BMad Method from the first message. Without this, agents would only learn about BMad Method when explicitly told.

**Three-file architecture:**

```
CLAUDE.md          →  @AGENTS.md (include directive)
AGENTS.md          →  enforcement block (self-sufficient, ~40 lines)
                       "NEVER write code without the 7-step sequence"
                       References _Sprintpilot/Sprintpilot.md for full catalog
_Sprintpilot/
  Sprintpilot.md          ←  comprehensive skill reference (permanent, not copied)
  templates/
    agent-rules.md ←  source template for the enforcement block
```

**Why self-sufficient:** Tools other than Claude Code can't `@include` files. The enforcement block inlines all critical rules (mandatory 7-step sequence, git rules, autopilot commands) so it works even if the agent never reads `Sprintpilot.md`.

**Marker-based updates:** The block is wrapped in `<!-- BEGIN:sprintpilot-rules -->` / `<!-- END:sprintpilot-rules -->` HTML comment markers. The installer can replace it without touching user content. The uninstaller removes only the BMad Method section.

**Per-tool strategies:**
- **Claude Code**: `CLAUDE.md` → `@AGENTS.md` include → `AGENTS.md` has the rules block
- **Own-file tools** (Cursor, Roo, Kiro, Trae): dedicated `bmad.md` in the tool's rules directory
- **Append tools** (Windsurf, Cline, Gemini CLI, Copilot): rules block appended to shared system prompt file

### Worktree Isolation

Each story gets its own git worktree at `.worktrees/<story-key>/`, created via standard `git worktree add` commands. This keeps story work isolated from `main` and works with **any coding agent** (Claude Code, Cursor, Gemini CLI, etc.).

```
git worktree add .worktrees/story-key -b story/story-key
  → Creates .worktrees/story-key/
  → New branch from HEAD
  → Agent operates in this directory via cd

cd <project-root>
  → Returns to original project root
  → Worktree preserved on disk until cleanup
```

**Fallback**: If `git worktree add` fails, the workflow creates a regular branch (`git checkout -b`) and continues without isolation.

### File Ownership: sprint-status.yaml vs git-status.yaml

The addon **never modifies** `sprint-status.yaml` — that file is owned by BMad Method. Instead, the addon tracks git metadata in its own `git-status.yaml`:

| File | Owner | Contains |
|------|-------|----------|
| `sprint-status.yaml` | BMad Method | Story status, phase, epic structure |
| `git-status.yaml` | Addon | Branch, commit SHA, PR URL, push status, lint result, worktree path |

Both live in `_bmad-output/implementation-artifacts/`. The autopilot reads `sprint-status.yaml` for story selection and writes git fields to `git-status.yaml`.

```
[In worktree] bmad-dev-story updates sprint-status.yaml (BMad Method-owned)
                     ↓
[cd project-root] returns to project root
                     ↓
[sync-status.js] writes git fields to git-status.yaml (addon-owned)
                 atomic write (tmp + mv), never touches sprint-status
```

For the `git-status.yaml` schema and field reference, see [Configuration Reference](CONFIGURATION.md#git-status-file-git-statusyaml).

### Lock File

Prevents concurrent autopilot sessions. `_Sprintpilot/scripts/lock.js` (Node) writes an epoch timestamp + UUID — no PID (unreliable in Claude Code) and no LLM-interpreted time math.

```
.autopilot.lock contents:
  1711590000        ← epoch seconds
  A1B2C3D4-...     ← session UUID
```

Stale locks (>30 min) are auto-removed on next boot.

### Explicit File Staging

The add-on **never** uses `git add -A`, `git add .`, or `git add -u`. Instead:

1. `git diff --name-only HEAD` + `git ls-files --others --exclude-standard`
2. Cross-reference with story File List (if provided)
3. Pre-commit checks: secrets scan, file size, binary detection, .gitignore verification
4. `git add -- "file1" "file2"` (quoted paths)

### Multi-Agent Pattern

All MA skills follow the same pattern:

1. **Prepare context** — read relevant files, generate diffs
2. **Launch N agents in a single message** — ensures parallel execution
3. **Each agent gets inlined instructions** — not a Skill reference (subagents can't invoke Skills)
4. **Collect results** — parent receives all agent outputs
5. **Triage/synthesize** — deduplicate, classify, merge into final output

## Survivability

| Concern | Protection |
|---------|-----------|
| BMad Method update overwrites skills | Sprintpilot skills use `sprint-autopilot-*` and `sprintpilot-*` prefixes, not in BMad Method's `skill-manifest.csv` |
| Source files modified | Source lives in `_Sprintpilot/`, never touched by BMad Method |
| Need to re-install | `npx @ikunin/sprintpilot@latest` restores all skills |
| Rollback | Backups in `.claude/.sprintpilot-backups/` (last 3 per skill) |

## Platform Abstraction

```
detect-platform.js:
  1. Explicit config (provider: github) → use it
  2. CLI detection (gh --version, glab --version) → first found
  3. Remote URL regex (github.com, gitlab.) → pattern match
  4. None → git_only (local branches only, no PRs)
```

Platform commands are templates in `platform.yaml` with `{placeholders}` filled at runtime.

## V2: Adaptive Process Scaling

The v2.0 release introduced `complexity_profile` as a first-class config dimension and shipped 11 optimization layers on top of it. The design is **additive and rollback-safe**: missing-key defaults match v1.0.5 byte-for-byte, and every feature has a per-profile knob to disable it without uninstalling.

### Profile Resolution

`resolve-profile.js` reads `_Sprintpilot/modules/autopilot/config.yaml`, locates the named profile YAML under `modules/autopilot/profiles/`, and merges base + overlay. The `legacy` profile stands alone (no inheritance) and pins `version_pinned: "v1.0.5"` so future refactors cannot silently drift it.

```
resolve-profile.js print          # full resolved profile as JSON
resolve-profile.js get <key>      # one key (e.g., implementation_flow)
resolve-profile.js validate       # profile YAML structural check
```

### State Shards

Per-story state lives in `.autopilot-state/<story>.yaml` and `.decision-log/<story>.yaml` shards. Atomic tmp-sibling + `rename()` writes. Flat dotted-keys + JSON flow-form shape keeps shards valid YAML without an install-time YAML-parser dep.

`merge-shards.js` collapses shards into authoritative project YAMLs. Decision-log dedup by `id`, sort by `ts`. Corrupt shards go to `.archive/corrupt/` (never deleted). Idempotent; `--archive` moves merged shards to `.archive/layer-<id>/`.

Shard schema includes `updated_at.wall` (ISO-8601 ms) + `updated_at.monotonic` (`hrtime.bigint()`) — NTP-safe intra-process tiebreaker + cross-process fallback.

### Coalesced State Writes

When `coalesce_state_writes: true`, non-critical fields accumulate in `.pending/<kind>/<story>.yaml` and flush atomically at story boundary + session checkpoint + sprint complete. Four crash-recovery keys bypass the buffer and write straight through, preserving resume-after-crash semantics:

- `current_story`
- `current_bmad_step`
- `in_worktree`
- `patch_commits`

### Phase Timing

`log-timing.js` writes append-only JSONL with path-traversal-guarded `--story` / `--phase`, 2 KB `--meta` cap, 4 KB line cap so a single POSIX `write()` is atomic. Silently no-ops when `phase_timings !== true`.

The `mark` action replaces start/end pairs: it reads a small marker file, computes the duration of the previous phase from its timestamp, emits a `duration` record, and writes a new marker for the current phase. Missed bracket calls are impossible because there are no brackets. The `_end` sentinel closes the last open phase without starting a new one.

Three deterministic scripts auto-emit `once` events on success — timing accumulates without LLM cooperation:
- `mark-done-stories-tasks.js` → `cleanup.mark-done-tasks`
- `infer-dependencies.js write` → `planning.infer-dependencies`
- `inject-tasks-section.js` → `story.inject-tasks` (per-story key)

### DAG Resolver + Dependency Inference

`resolve-dag.js` builds a layered execution plan from `_bmad-output/implementation-artifacts/sprint-plan.yaml` (v2.3.0). Strategies: `explicit` (`plan.dependencies.stories[*].depends_on` intra-epic + `plan.cross_epic_deps` cross-boundary) > `ordering` (linear chain from sprint-status). Overrides: `force_independent` strips edges; `force_sequential` adds edges. Kahn's-algorithm cycle detection with a clear diagnostic on failure.

`infer-dependencies.js` validates two distinct LLM envelopes:

- **Per-epic** (`scaffold-prompt --epic <id>` / `dry-run --epic <id>` / `write --epic <id>`): `{version, epic, dependencies, rationale}`. The prompt instructs the LLM to REJECT cross-epic edges; validator enforces. Each call updates `plan.dependencies.stories.*` for the named epic only, preserving entries for other epics.
- **Cross-epic** (`scaffold-prompt --cross-epic` / `dry-run --cross-epic` / `write-cross-epic`): `{version, cross_epic_deps: [{from_story, to_story, rationale}]}`. Validator enforces from/to epics differ, rationale ≤200 chars, no duplicates with per-epic graph, no cycle in combined DAG. Writes to `plan.cross_epic_deps`.

`infer-dependencies.js migrate` performs one-shot upgrade from pre-v2.3.0 `_Sprintpilot/sprints/dependencies.yaml` — imports `stories:` + `overrides:` into the plan, drops legacy `epics: {independent: ...}` block with a warning, archives original to `.archive/dependencies.yaml.migrated`. Idempotent.

Scripts never call an LLM. The autopilot session or the `/sprintpilot-plan-sprint` skill executes inference inline (LLM reads four files, emits JSON) and pipes the result through `dry-run` → `write`. This preserves the "Sprintpilot scripts NEVER call LLMs" rule.

### Sprint Planning + DAG-Aware Execution (v2.3.0)

The plan file at `_bmad-output/implementation-artifacts/sprint-plan.yaml` is Sprintpilot's authoritative view of execution: per-epic dependencies + cross-epic edges + per-story `plan_status` + priority + cached BMad status + optional external issue-tracker links. BMad's `sprint-status.yaml` remains the source of truth for *what stories exist*; the plan is the source of truth for *what runs next and in what order*.

**Layers:**

- `_Sprintpilot/scripts/sprint-plan.js` (script primitive) — atomic read/write of `sprint-plan.yaml` via js-yaml, schema validation (`schema_version`, status/epics/stories/dependencies/cross_epic_deps/overrides required), mutator primitives (`markDone`, `markSkipped`, `markExcluded`, `markRunning`, `addStories`, `removeStories`, `reorder`, `setIssueId`, `setIssueTracker`, `refreshBmadStatus`, `archive`). All mutators go through a `mutate(projectRoot, fn)` helper that does read → validate → atomic tmp+rename.

- `_Sprintpilot/lib/orchestrator/sprint-plan.js` (orchestrator-side helper) — opinionated logic the script doesn't know about: staleness detection (`planStaleness`), legacy migration trigger (`bootstrapMigrationIfNeeded`), plan-aware queue composition (`composePlanQueue`), refresh wrapper (`refreshIfPlanExists`), auto-derive gating (`shouldAutoDerive`), plan-exhaustion detection (`planExhausted`), DAG validation for reorder (`validateOrdering` + `collectUpstreams` + `isPlanTerminal` + `isTerminalInSprintStatus`).

- `_Sprintpilot/skills/sprintpilot-plan-sprint/` — LLM-driving skill. 14-step workflow that loads inputs, migrates legacy, checks staleness, runs per-epic inference loop, runs cross-epic detection, optionally captures issue tracker + per-story issue IDs, builds the DAG, presents it (text + mermaid), curates stories, validates selection, writes the plan, reports. Shells out to all three layers above. Never improvises.

**cmdStart integration:**

After lock acquisition and worktree health check, `cmdStart`:

1. Runs `bootstrapMigrationIfNeeded` — one-shot legacy import.
2. Runs `refreshIfPlanExists` — syncs cached `bmad_status` from sprint-status; eagerly transitions terminal stories to `plan_status: done`.
3. If no explicit `--stories`/`--epic` queue: hydrates `persisted.story_queue` from `composePlanQueue`.
4. Checks `state.replan_requested` (set by `replan_sprint` user command) — emits `invoke_skill: sprintpilot-plan-sprint` and returns.
5. Checks `planExhausted` — if every plan story is terminal, archives the plan and emits `plan_exhausted` halt.
6. Checks `shouldAutoDerive` — if the user opted in via `auto_plan_on_start: true` or the plan went stale, emits `invoke_skill: sprintpilot-plan-sprint` and returns.

`composeRuntimeState` then runs unchanged — it consumes `persisted.story_queue` and selects the head as `current_story`. The plan-aware logic is fully isolated in the orchestrator helper; only ~70 lines were added to `autopilot.js`.

**cmdRecord integration:**

On every `record` invocation, after `persistRuntimeState`:

1. `emitPhaseTransitionEvents` — when the state transitions between story-bound phases, emit `story_step_completed` (old phase) + `story_step_started` (new phase) ledger events, and call `sprintPlan.markRunning(story_key, new_phase)` so `plan.stories[].current_step` reflects live state.
2. When `result.newState.phase === STORY_DONE`, call `sprintPlan.markDone(story_key)` — sets `plan_status: done`, stamps `completed_at`, clears `current_step`. Best-effort + idempotent.

**Mid-flight user commands** (Phase 5):

Four new `user_input` kinds — `reorder_queue`, `add_to_sprint`, `remove_from_sprint`, `replan_sprint` — emit pure side-effect records from `user-command-applier.js`. `applySideEffects` in `autopilot.js` reads the plan, runs `validateOrdering` (for reorder), and applies the mutation via the corresponding `sprint-plan.js` primitive. Inline edits (reorder/add/remove) don't change the state-machine phase; `replan_sprint` halts and sets `state.replan_requested` so the next `cmdStart` emits the planning skill.

`validateOrdering` is DAG-aware: for each story in the proposed order, every transitive upstream (intra-epic + cross-epic) must be positioned BEFORE the story OR plan-terminal (done/skipped/excluded) OR terminal in sprint-status. Violations include a `suggestion` string ("insert <upstream> before <story>") so user_prompts can guide remediation.

**Streaming progress** (Phase 4.5):

`action-ledger.js` exposes `tail(ctx, opts)` — an async iterator that yields events at a 250ms poll interval. AbortSignal support, `maxIdleMs` auto-terminate, optional `afterSeq` for incremental reads. CI-safe (no fs.watch). `autopilot progress` is a one-shot snapshot CLI built on top of `tail`; live tailing via `watch -n 1 'autopilot progress'` works as a Unix-native alternative.

Phase-bound events (`story_step_*`) emit from `emitPhaseTransitionEvents` in `cmdRecord`. Step-level granularity exposes the live BMad-cycle phase (`check_readiness` / `dev_red` / `dev_green` / `code_review` / `patch_apply` / `patch_retest` / `story_land` / `story_done` for full profile; `nano_quick_dev` for nano).

**Authoritative next-action line (`next_summary`):** `formatNextStorySummary(runtime, action, queue)` is a single pure composer that renders the one human-readable statement of what the autopilot will do next — `NEXT: <story> · step <phase> · #N of M in epic <e>`, or `PAUSED: <reason>` for a halt/user_prompt action, or an explicit sprint-complete line. It is the same function across every emission surface — the `start` / `next` / `record` JSON envelopes each carry a `next_summary` field, and `cmdProgress` includes it (JSON + as the lead line of the human render) — so the four surfaces never disagree. In-epic position counts only same-epic entries in the persisted `story_queue`, so a mixed queue doesn't inflate the denominator. This exists because the "what runs next" truth was previously split across `autopilot-state.yaml` (resume pointer), `sprint-plan.yaml` (priority order), and the ledger; the composer reconciles them into one line the orchestrator contract (`workflow.orchestrator.md`) tells the driver to surface verbatim before each step, and the planner skill echoes as its closing line.

**Issue-id enrichment:** `cmdProgress` builds a `story_key → issue_id` map from `plan.stories[]` once per call and joins it into the JSON `recent_events[]`, the top-level `current_issue_id`, and the human-readable output ("Current story: 1-3-add-auth [PROJ-101]"). A separate `computeIssueTracking` helper produces an `{provider, project_key, total, linked, coverage}` summary surfaced as "Issue tracking: N/M stories linked to <provider>" when the plan has a configured `issue_tracker` block — silenced entirely otherwise (no `[no issue]` noise). The same data feeds the `/sprintpilot-sprint-progress` skill template.

**Skill layer:** `/sprintpilot-sprint-progress` is a read-only diagnostic skill that wraps `autopilot progress --json` with LLM judgment. Classifies the sprint into `HEALTHY` / `STALLED` / `NEEDS-INPUT` / `EXHAUSTED` / `NO-PLAN` based on the recent ledger tail (halts, verify rejections with `consecutive >= 3`, plan_exhausted halts) and produces exactly one recommended next action. Never mutates state — points users at the appropriate `user_input` command when corrective action is needed.

### Concurrency + Hardening Patterns (v2.3.0)

Four hardening patterns emerged from adversarial review and are worth understanding when working on this codebase:

**1. Single-writer guarantee via `.sprintpilot/plan.lock`.** Every function in `sprint-plan.js` that mutates the on-disk plan — `mutate()` (used by all named mutators except refresh), `archive()`, and `refreshBmadStatus()` — acquires the lock via `acquirePlanLock(projectRoot)` and releases in a `finally` block. The lock primitive is the shared `lock.js` (same as `.merge-shards.lock`), with a 5-minute stale timeout and 30-second acquire timeout. Crash-resume: a SIGKILL'd holder's lock becomes stale and is taken over by the next acquirer via the `ACQUIRED_STALE` path. The disk-layer atomic-write (tmp + rename) means the file is never in a torn state even when the holder dies mid-write — only complete-or-not is possible.

The lock is intentionally process-level (`lock.js` uses an exclusive-create file lock), not in-process — concurrent threads in a single Node process aren't serialized, but Sprintpilot is single-threaded by design. The real risk is two separate `node autopilot.js` invocations, and that's what the lock prevents.

**2. CRITICAL_KEYS write-through for crash-resume state.** Fields that must survive an unclean process exit are listed in `CRITICAL_KEYS` (in both `_Sprintpilot/lib/orchestrator/state-store.js` and `_Sprintpilot/scripts/state-shard.js`). v2.3.0 added two fields:

- `last_verify_issues_signature` — hash of the most recent verify rejection's issues
- `consecutive_identical_rejections` — counter for loop detection

Without write-through, these would accumulate in the in-memory pending buffer (coalesced state writes) and only flush at story boundary. A SIGKILL between identical verify rejections would reset the counter, defeating the loop-detection halt. With CRITICAL_KEYS, each rejection writes the new signature + counter directly through to disk.

**3. Plan mutation failure surfacing.** The `applySideEffects` helper in `autopilot.js` returns a `surfaceFailure` envelope when any `plan_*` side effect (reorder / add_stories / remove_stories) fails. `cmdRecord` checks the return value and, if set, overrides the emitted `nextAction` with a `user_prompt` halt whose prompt names the violations + suggested remediation. Without this, mid-flight commands would fail silently — the user would issue `reorder_queue` and see no feedback when DAG validation rejected it. The pattern: pure side-effect handlers don't have stdout access; they return data; the orchestrator's CLI edge converts that data into a halt action.

**4. Single-pass entity escape for DAG labels.** `mermaidEscapeLabel` in `resolve-dag.js` uses a single regex + replacement function (`MERMAID_ESCAPE_MAP[c]`) instead of a chain of `.replace()` calls. The chain approach has a subtle bug: if `&` is escaped first (`&` → `&amp;`), and a later step escapes `;` (`;` → `&#59;`), the `;` in `&amp;` from a user-provided `&amp;` literal gets re-escaped, producing `&amp&#59;`. The single-pass approach matches each input character exactly once; the replacement output (entities) is never re-processed by the same regex. The character class `[\\"&;\]\[()<>|\n]` covers every char with mermaid-syntax meaning; control chars and Unicode bidi marks are stripped in separate passes. `dotEscapeLabel` is simpler because graphviz double-quoted labels don't interpret HTML entities — only `\` and `"` need escaping, plus newline conversion.

**5. Tail iterator rotation detection.** `action-ledger.js#tail` tracks the ledger file's inode + size before and after each `readSince` call. If the inode changes (file moved/replaced) or size shrinks (truncated), the iterator resets `lastSeq=0` and discards the just-read batch — those events might have come from the OLD inode and the seq numbers won't compose with the new file's. The next iteration re-reads from the new file's start. Without this, `tail()` silently misses every event after a rotation (the `seq > lastSeq` filter rejects all new entries because the new file's seq starts at 1 while lastSeq is the old file's tail).

**DAG render pipeline:**

`resolve-dag.js render --format mermaid|graphviz` produces a visual DAG of the plan. Mermaid default (GitHub-renderable, no system deps); graphviz optional with `dot` PATH probe + mermaid fallback on missing toolchain. Node coloring by `plan_status` (pending=green, done=gray, skipped=yellow, excluded=dim). Cross-epic edges rendered dashed with `cross-epic` label. Plan-id + generated-at stamped as header comment for staleness detection.

### Parallel Story Dispatch

When `parallel_stories: true` AND host_supports_parallel AND active layer ≥ 2 stories:

1. `dispatch-layer.js` creates one worktree per story + writes `.layer-plan.json`.
2. The autopilot session spawns N concurrent Agent tool calls in a single message (one per story, `subagent_type=general-purpose`). Each sub-agent runs the full per-story flow inside its assigned worktree.
3. When all return, `merge-shards.js --archive` collapses per-story state shards into the project YAMLs.
4. The orchestrator's `parallel_batch` resolver loops back to evaluate the next layer.

`agent-adapter.js detect` returns host capability with confidence levels. Priority: env vars (HIGH) > parent process name (MEDIUM) > filesystem markers (LOW). Tautology guard: filesystem markers prove the install target, not the current host; `confidence=low` forces `supports_parallel=false`.

Cross-epic parallelism (`parallel_epics: true`, EXPERIMENTAL) is gated behind `preflight-merge.js` — a per-pair dry-run merge probe with 60s lock, startup cleanup of stale preflight branches, and per-pair try/finally that returns HEAD to base. Off on every profile by default.

### Resume Divergence

On every `autopilot start`, the orchestrator fingerprints `_bmad-output/`, `sprint-status.yaml`, and per-story branch HEADs (`divergence.fingerprint()`) and compares against the fingerprint stamped at the last halt (`divergence.diff()`). The fingerprint includes:

- `sprintStatusSha` — sha256 of `sprint-status.yaml`
- `bmadTree` — map of file paths under `_bmad-output/` to size (cheap drift detection without re-hashing every artifact)
- `branchHeads` — map of branch name to commit sha for every per-story branch
- `worktreePaths` — sorted list of `.worktrees/*/` directories

Two escape paths proceed past a divergent fingerprint without manual state surgery:

1. **External-completion auto-acknowledge.** When the persisted `current_story` is `done` in sprint-status (story merged outside the autopilot), `cmdStart` clears the stale story identity (`current_story` / `story_file_path` / `current_epic` / `current_bmad_step` all nulled) and proceeds. `composeRuntimeState` then picks the next pending story from queue or sprint-status. Ledger: `kind: resume, divergence: {kind: 'divergence_accepted', reason: 'external_completion', story: <key>}`.

2. **`--accept-divergence` flag.** Catch-all for divergence the auto-path doesn't cover. Logged with `reason: 'explicit_accept'`. Lets users bypass the check when they know the state is intentional (multiple stories completed externally, branch heads moved due to rebase, etc.).

Divergences outside both paths emit `resume_divergence` with the diff so the user/LLM can resolve via `user_input` (`force_continue` / `override_decision`).

### Verify Recovery Paths

`verify.js` enforces BMad bookkeeping after every `success` signal but probes the underlying world for several common signal-format omissions instead of punishing the LLM for incomplete echo:

| Phase | Field | Recovery |
|---|---|---|
| `dev_red` | `test_files` missing | Auto-detect from `git diff --name-only --no-renames -z <base>...HEAD` + `git ls-files --others --exclude-standard -z`, filtered by language convention (10-pattern regex). Detected paths flow through the same `fileExists` check. |
| `dev_red` | `test_files` paths relative | Resolved against `ctx.projectRoot` (not `process.cwd()`). |
| `dev_green` / `patch_retest` / `nano_quick_dev` | `tests_run` missing | Accept the runner's count when `ctx.runner` reports `tests_run > 0`. |
| `story_done` | `git_steps_completed` missing | Probe `git cat-file -e <commit_sha>` + `git ls-remote --heads origin <branch>`. Accept when both succeed and the remote sha matches the local commit sha. |
| `code_review` | review artifact location | Accept the `### Review Findings` section in the story file (what `bmad-code-review` actually writes) OR `_bmad-output/reviews/<key>.md` OR `_bmad-output/implementation-artifacts/code-review-<key>.md`. |

Each recovery is observable in the `verify_result` ledger entry. Strict rejection remains the fallback when probes can't confirm — the verifier's job is catching lies about the world, not punishing formatting mistakes.

### Post-GREEN Lint Pipeline

When `git.lint.enabled: true`, `verify.js#verifyDevGreen` invokes `scripts/post-green-gates.js` after the standard `dev_green` checks pass. The pipeline composes three gates:

1. **`lint-changed.js`** — runs the configured linter for each language present in the changed file set. Per-language priority follows `git.lint.linters.<language>: [list]` when configured, else hardcoded defaults. Auto-detects via `node_modules/.bin/<tool>` first, then PATH.
2. **`lint-test-pitfalls.js`** — scans changed test files for common LLM-test smells (missing assertions, hardcoded paths, fixture-setup gaps).
3. **`scan.js`** — pattern scan for CI-only failure modes (`process.env.CI` skips, hardcoded localhost ports).

Each gate's output is truncated to `git.lint.output_limit` lines. `git.lint.blocking: true` rejects verify on the first failing gate (LLM enters a fix-loop). `git.lint.blocking: false` records the failure in the `verify_result` ledger entry but doesn't gate the autopilot.

`javascript` and `typescript` keys in `lint.linters` merge into a single `js-ts` bucket (both share eslint/biome). An empty list disables linting for that language entirely.

### Tiered, Change-Aware Test Scope (v2.3.18+)

Full regression on every test-running phase dominates per-story latency once a suite passes ~5 minutes wall time. The orchestrator now derives a per-emission test command from the working-tree diff and feeds it to dev-story via template slots — the LLM runs the targeted command rather than the project's default suite. CI remains the safety net for the full suite via `gh pr checks` on `STORY_LAND` (and, when ready, an opt-in local background runner).

Three components live under `_Sprintpilot/lib/orchestrator/testing/`:

1. **Adapter registry** (`index.js`) — probes `vitest.js`, `jest.js`, `pytest.js`, then `generic.js` in priority order. First `detect(projectRoot)` match wins; generic always matches so adapter resolution never returns null. Each adapter exposes `detect(projectRoot)` + `buildCmd({ scope, changedFiles, testFiles, profile, baseRef, projectRoot })`. Adapter-built commands favor the native change-aware flag (`vitest --changed`, `jest --findRelatedTests`, `pytest --testmon`).

2. **Diff helper** (`diff.js`) — `git diff --name-only <base>...HEAD` plus staged/unstaged/untracked since the LLM commits at `STORY_DONE` and earlier phases run pre-commit. Returns `null` on any git failure so the resolver can fall back to `full`.

3. **Scope resolver** (`scope.js#resolveTestScope`) — composes `{ scope, adapter, command, changed_files, test_files, reason, fallback }`. Priority order: `state.test_scope_hint.scope === 'full'` > `profile.testing_scope === 'full'` > affected. Within affected, hint-supplied `include_dirs[]` widen the diff before the adapter sees it. When the adapter returns `null` (e.g. generic with no `testing_commands_affected` override) OR the diff fails, the resolver downgrades per `profile.testing_fallback` (`full` / `directory` / `halt`).

The scope decoration runs in the **CLI edge**, not the state machine. `bin/autopilot.js#decorateTestScope` chains after `decorateRunScript` / `decorateGitOp` and only fires when `stateMachine.isTestPhase(action.phase)` returns true. This keeps `state-machine.js` pure (no `fs` / `git` calls) and matches the existing pattern for git-op step inlining. `state-machine.js#buildTemplateSlots` seeds `test_scope`, `recommended_test_command`, `test_files_hint`, `test_scope_decision_summary`, and `test_scope_hint_guidance` as `null` placeholders; the decorator fills them in.

Signal propagation lives in `adapt.js#advanceState`:
- `signal.output.test_files: string[]` → `state.test_files` (pinned across phases within a story; cleared at story boundary).
- `signal.output.test_scope_hint: { scope?, include_dirs? }` → `state.test_scope_hint` (validated lightly; last writer wins; cleared at story boundary).

Every emission writes a `test_scope_decision` ledger entry (kind in `action-ledger.js#VALID_KINDS`) carrying the full decision shape so post-mortem analysis can answer "why did this story take X minutes?".

Configuration lives in a new module: `_Sprintpilot/modules/testing/config.yaml`, threaded through `resolve-profile.js`'s module-overlay loop. Profile defaults (in `profile-rules.js#flatToProfile`): `testing_scope=affected`, `testing_fallback=full`, `testing_full_suite_on_story_land=ci`. The `legacy` profile explicitly pins `testing.scope: full` to preserve v1.0.5 behavior bit-for-bit.

### Worktree Cost Mitigation

- `with-retry.js` — 3-attempt jittered backoff (500ms–2s) triggered ONLY when stderr matches a ref-lock regex. Non-matching failures pass through.
- `submodule-lock.js` — per-submodule lock keyed by slug, stored under `.sprintpilot/submodule-locks/` (outside `.git/`).
- Submodule init uses `--reference "$GIT_COMMON"` + `--jobs=4` on git ≥ 2.18, wrapped in retry, serialized by per-submodule lock.
- Session saves + disables `gc.auto` on main repo AND every worktree; restored symmetrically at sprint complete.

## Cross-Platform Portability

Every shell-out from the orchestrator and helper scripts runs under bash, zsh, Git Bash, PowerShell, and cmd. POSIX-shell idioms have been replaced with `_Sprintpilot/scripts/git-portable.js`:

- `count-worktrees` — replaces `git worktree list --porcelain | grep -c '^worktree '`
- `config-get <key> [--default <value>]` — replaces `git config --get K 2>/dev/null || echo X`
- `common-dir` — replaces `VAR=$(git ... rev-parse --git-common-dir)`
- `safe-add <path>...` — replaces `git add A B C 2>/dev/null || true` with explicit existence filtering

All `_Sprintpilot/scripts/*` use `spawnSync(..., args[])` with no shell, `path.join` everywhere, and `windowsHide: true`.
