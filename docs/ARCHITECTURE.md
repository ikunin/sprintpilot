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
├── scripts/                   # Node.js helpers invoked by workflow.md (zero runtime deps)
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
│   ├── with-retry.js          # Ref-lock-pattern jittered backoff (3 attempts)
│
├── lib/runtime/               # Shared zero-dep helpers for scripts
│   ├── args.js, git.js, http.js, log.js, secrets.js,
│   ├── spawn.js, text.js, yaml-lite.js
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

#### Sanctioned exception: `sprint-status.yaml` conflict resolution

The auto-merge driver registered by the installer (`merge=bmad-doc` in `.gitattributes`) reconciles conflicts in `sprint-status.yaml` by taking the most-progressed status per story key (`done > review > in-progress > ready-for-dev > backlog`) and the latest `last_updated` timestamp.

This is the only code path where Sprintpilot writes to `sprint-status.yaml`, and it does so only as conflict resolution — the driver never originates a write to fields BMad doesn't already record on both sides. Without it, every stacked-PR merge re-fights the same trivial conflicts (BMad core writes the file from `bmad-dev-story` and `bmad-code-review`; concurrent stacked branches guarantee N-way overlaps).

Implementation: `_Sprintpilot/scripts/auto-merge-bmad-docs.js` dispatching to `_Sprintpilot/lib/runtime/yaml-merge.js#mergeSprintStatus`. Disabling: remove the `_bmad-output/implementation-artifacts/sprint-status.yaml merge=bmad-doc` line from the installer's `.gitattributes` block, or run `sprintpilot uninstall` to drop the entire wiring.

### Lock File

Prevents concurrent autopilot sessions. Uses epoch timestamp + UUID (no PID — unreliable in Claude Code). All time math in Bash, not the LLM.

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
| Rollback | Backups in `.claude/.addon-backups/` (last 3 per skill) |

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
4. Loop back to step 2 in workflow.md to re-evaluate the next layer.

`agent-adapter.js detect` returns host capability with confidence levels. Priority: env vars (HIGH) > parent process name (MEDIUM) > filesystem markers (LOW). Tautology guard: filesystem markers prove the install target, not the current host; `confidence=low` forces `supports_parallel=false`.

Cross-epic parallelism (`parallel_epics: true`, EXPERIMENTAL) is gated behind `preflight-merge.js` — a per-pair dry-run merge probe with 60s lock, startup cleanup of stale preflight branches, and per-pair try/finally that returns HEAD to base. Off on every profile by default.

### Worktree Cost Mitigation

- `with-retry.js` — 3-attempt jittered backoff (500ms–2s) triggered ONLY when stderr matches a ref-lock regex. Non-matching failures pass through.
- `submodule-lock.js` — per-submodule lock keyed by slug, stored under `.sprintpilot/submodule-locks/` (outside `.git/`).
- Submodule init uses `--reference "$GIT_COMMON"` + `--jobs=4` on git ≥ 2.18, wrapped in retry, serialized by per-submodule lock.
- Session saves + disables `gc.auto` on main repo AND every worktree; restored symmetrically at sprint complete.

## Cross-Platform Portability

Every workflow.md call site runs under bash, zsh, Git Bash, PowerShell, and cmd. POSIX-shell idioms have been replaced with `_Sprintpilot/scripts/git-portable.js`:

- `count-worktrees` — replaces `git worktree list --porcelain | grep -c '^worktree '`
- `config-get <key> [--default <value>]` — replaces `git config --get K 2>/dev/null || echo X`
- `common-dir` — replaces `VAR=$(git ... rev-parse --git-common-dir)`
- `safe-add <path>...` — replaces `git add A B C 2>/dev/null || true` with explicit existence filtering

All `_Sprintpilot/scripts/*` use `spawnSync(..., args[])` with no shell, `path.join` everywhere, and `windowsHide: true`.
