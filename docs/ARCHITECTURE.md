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
    ├── sprintpilot-code-review/      # 3 parallel review agents
    ├── sprintpilot-codebase-map/     # 5 parallel analysis agents
    ├── sprintpilot-assess/           # 3 parallel assessment agents
    ├── sprintpilot-reverse-architect/ # 3 parallel extraction agents
    ├── sprintpilot-migrate/          # 12-step workflow, 4 agents
    ├── sprintpilot-research/         # N parallel research agents
    └── sprintpilot-party-mode/       # 2-3 parallel persona agents
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

`resolve-dag.js` builds a layered execution plan from `dependencies.yaml`. Strategies: `explicit` (sidecar) > `ordering` (linear chain). Overrides: `force_independent` strips edges; `force_sequential` adds edges. Kahn's-algorithm cycle detection with a clear diagnostic on failure. Purpose-built block-form YAML parser — no install-time YAML dep.

`infer-dependencies.js` validates an LLM JSON envelope (`{version, epic, dependencies, rationale}`) and writes `dependencies.yaml` with an `# AUTO-INFERRED` marker. Validation accumulates errors (no short-circuit): schema, unknown keys, self-deps, cross-epic edges, missing rationales, cycles. Idempotency via 12-char sha256 over structural fields — rationale-only edits don't change the hash.

The script never calls an LLM. The autopilot session executes the inference inline (LLM reads four files, emits JSON) and pipes the result into `infer-dependencies.js write`. This preserves the "Sprintpilot scripts NEVER call LLMs" rule.

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
