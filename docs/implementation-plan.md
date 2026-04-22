# Adaptive Process Scaling — Implementation Plan

Status: Implementation-ready
Concept reference: `docs/adaptive-process-scaling.md`
Target branch: `claude/optimize-dev-workflow-D0U4w`
Audience: engineer picking this up to build, PR by PR

---

## Context

Sprintpilot's current per-story ceremony (7 BMad skills, worktree create/teardown, one PR per story, session checkpoint every 3 stories, per-epic retrospective) is right for a production team product but massively over-invests for small projects — a toy tic-tac-toe takes ~4h. The Adaptive Process Scaling concept introduces a `complexity_profile` dimension (`nano | small | medium | large | legacy`) that keeps quality gates invariant while tuning ceremony and parallelism to project size.

This plan sequences the concept into 12 PRs, each independently shippable and measurable. Each PR is small enough to review, carries its own tests, and has a rollback path. All changes stay within Sprintpilot-owned code — no BMad skill is modified. The autopilot (`_Sprintpilot/skills/sprint-autopilot-on/workflow.md`) is the single biggest touchpoint.

---

## Architecture anchors

| Concern | File / path | Notes |
|---|---|---|
| Autopilot workflow | `_Sprintpilot/skills/sprint-autopilot-on/workflow.md` | 890 lines, 10 `<step>` blocks at 251–889; biggest change surface |
| Autopilot config | `_Sprintpilot/modules/autopilot/config.yaml` | Current keys: `session_story_limit`, `retrospective_mode` |
| Git config | `_Sprintpilot/modules/git/config.yaml` | Adds `granularity`, worktree knobs |
| Multi-agent config | `_Sprintpilot/modules/ma/config.yaml` | Parallelism knobs |
| Profile defaults | `_Sprintpilot/modules/autopilot/profiles/<name>.yaml` | NEW — per-profile snapshots |
| Helper scripts | `_Sprintpilot/scripts/*.js` | Node, Commander-style CLIs, stdout-returning |
| Lock primitive | `_Sprintpilot/scripts/lock.js` | Already accepts `--file`, reusable for per-submodule locks |
| Installer | `lib/commands/install.js:814-910` (tool picker at 814, `runInstall` step 3 at 910) | Uses Commander + @clack/prompts |
| Install entry | `bin/sprintpilot.js:49-69` | Add `--profile`, `--advanced`, `--parallel`, etc. |
| Autopilot config reader | `lib/commands/install.js:621-684` (`readExistingAutopilotConfig`) | Regex-based, preserves `{{var}}` placeholders |
| YAML loader (general) | `lib/core/bmad-config.js:5-24` (`readYaml`) | For non-autopilot YAML |
| Tests | `tests/unit/*.test.ts`, `tests/e2e/*.test.ts` | Vitest, tempdir fixtures, `tests/e2e/harness/` drives real CLI |
| Project docs | `docs/adaptive-process-scaling.md` | Concept/rationale (already written) |
| AGENTS.md policy | `AGENTS.md` (root) | Relax non-negotiable clause for nano |

**Key reuse:**

- `lock.js` + `--file` → per-submodule serialization (PR 10)
- `readYaml` from `bmad-config.js` → profile YAML loading (PR 1)
- Regex config patching pattern from `patchAutopilotConfig` (install.js:733-748) → installer profile writes
- @clack/prompts `select()` pattern from `resolveAutopilotSettings` (install.js:775-809) → profile prompt
- Existing tempdir fixture pattern from `tests/unit/autopilot-config.test.ts:31-48` → new script tests
- E2E harness (`tests/e2e/harness/`) → greenfield tic-tac-toe sprint for nano validation

---

## PR sequence overview

12 PRs in 5 phases. Dependencies flow left-to-right; anything marked **⇑depends on** must land first.

| # | Title | Phase | Risk | Effort | Depends on |
|---|---|---|---|---|---|
| 1 | Foundation: profile schema + plumbing + legacy + git check + installer prompt + upgrade migration | 0 Foundation | low | 3–4d | — |
| 2 | M0 phase-timing instrumentation | 1 Measurement & Safety | low | 1d | 1 |
| 3 | State-shard infrastructure | 1 Measurement & Safety | med | 2–3d | 1, 2 |
| 4 | Nano routing: quick-dev per story | 2 Nano | med | 2d | 1 |
| 5 | Nano orchestration cuts: PR-per-epic, no worktrees, retro skip | 2 Nano | low | 1d | 4 |
| 6 | M3 coalesce state writes | 3 Orchestration cuts | low | 1d | 3 |
| 7 | M4 conditional boot work | 3 Orchestration cuts | low | 0.5d | 1 |
| 8 | M5 cached per-iteration reads | 3 Orchestration cuts | low | 0.5d | 1 |
| 9 | Dependency sidecar + DAG resolver | 4 Parallel prep | med | 2d | 1 |
| 10 | Worktree cost mitigation: submodule reference + concurrent discipline | 4 Parallel prep | med | 2d | 1 |
| 11 | M2 parallel intra-epic stories (Claude-Code-first; sequential fallback on other hosts) | 5 Parallelism | high | 5–8d | 3, 6, 9, 10 |
| 12 | Cross-epic parallelism (experimental, off-by-default) | 5 Parallelism | high | 2d | 11 |

Total estimate: **~23–28 engineer-days** sequential. Phases 1–3 (PRs 1–8) are the target for Sprintpilot **v2.0.0** (breaking change: default behavior for new installs shifts from pre-v4 to profile-driven; existing installs preserved via implicit `medium` default + `legacy` profile rollback). Phases 4–5 target **v2.1.0**.

**Release versioning.** v2.0.0 drops when PRs 1–8 land; `legacy` profile pins all settings to a frozen `v1.x` snapshot so anyone affected by a regression has a one-line rollback (`complexity_profile: legacy`). v2.1.0 when PRs 9–11 land. v2.2.0 when PR 12 exits experimental.

---

## PR 1 — Foundation

**Goal.** Add `complexity_profile` as a first-class config dimension. Ship profile YAML snapshots (`nano`, `small`, `medium`, `large`, `legacy`), a Node resolver that loads and merges them, the installer profile prompt, the CLI flag, the git-version preflight, the AGENTS.md policy relaxation, and the `sprintpilot-update` migration path. No behavioral change yet — everything else in this plan consumes this infrastructure.

**Scope note on AGENTS.md.** AGENTS.md is the human-/coding-agent-facing policy document; it does not itself gate autopilot behavior. Autopilot routing is gated by `workflow.md` honoring `implementation_flow`, which lands in PR 4. PR 1's AGENTS.md edit only keeps the two policy layers consistent.

**Files created:**

- `_Sprintpilot/modules/autopilot/profiles/nano.yaml`
- `_Sprintpilot/modules/autopilot/profiles/small.yaml`
- `_Sprintpilot/modules/autopilot/profiles/medium.yaml`
- `_Sprintpilot/modules/autopilot/profiles/large.yaml`
- `_Sprintpilot/modules/autopilot/profiles/legacy.yaml` — `version_pinned: "v1.x"` + frozen snapshot of Sprintpilot v1.0.5 behavior
- `_Sprintpilot/scripts/resolve-profile.js` — CLI helper (see contract below)
- `_Sprintpilot/scripts/check-prereqs.js` — git + node version check
- `tests/unit/resolve-profile.test.ts`
- `tests/unit/check-prereqs.test.ts`
- `docs/implementation-decisions.md` — running record of non-obvious choices (each subsequent PR appends)

**Files modified:**

- `_Sprintpilot/modules/autopilot/config.yaml` — add `complexity_profile: medium` key with comment
- `bin/sprintpilot.js:49-69` — add `--profile <name>`, `--advanced`, and placeholders for `--parallel`, `--retrospective-mode`, `--session-story-limit`
- `lib/commands/install.js` — slot profile prompt at line 893 (between autopilot settings and tool picker); add profile → YAML write to step 6; call `check-prereqs.js` at start of `runInstall`
- `_Sprintpilot/skills/sprintpilot-update/*` — extend the update skill so upgrading users are prompted to pick a profile (see "Upgrade migration" below)
- `AGENTS.md` — relax non-negotiable clause (nano exception) — policy layer only
- `package.json` — bump version to `2.0.0`; update description if referencing "autopilot only"
- `CHANGELOG.md` — v2.0.0 entry explaining breaking behavior + `legacy` escape hatch

**Profile YAML shape — base + overlay (DRY).** `profiles/_base.yaml` carries every default. Per-profile YAMLs override **only** the keys that differ. `resolve-profile.js` reads `_base.yaml` first, then overlays the named profile. New knobs added in future PRs need one edit to `_base.yaml` + at most one per differing profile. No `settings:` wrapper — profile files match `config.yaml` shape directly so the resolver doesn't need to unwrap.

```yaml
# _Sprintpilot/modules/autopilot/profiles/_base.yaml
name: _base
version_pinned: null
autopilot:
  implementation_flow: full          # full | quick
  session_story_limit: 5
  retrospective_mode: auto
  phase_timings: true                # M0, PR 2
  coalesce_state_writes: true        # M3, PR 6
  conditional_boot_work: true        # M4, PR 7
  cache_shared_reads: true           # M5, PR 8
git:
  granularity: story                 # story | epic
  worktree:
    enabled: true
  squash_on_merge: false
ma:
  parallel_stories: false
  max_parallel_stories: 2
  parallel_epics: false
  state_sharding: false
```

```yaml
# _Sprintpilot/modules/autopilot/profiles/nano.yaml — only the deltas
name: nano
autopilot:
  implementation_flow: quick
  session_story_limit: 0
  retrospective_mode: skip
git:
  granularity: epic
  worktree:
    enabled: false
  squash_on_merge: true
```

```yaml
# _Sprintpilot/modules/autopilot/profiles/large.yaml — only the deltas
name: large
autopilot:
  session_story_limit: 3
  retrospective_mode: stop
  conditional_boot_work: false       # always run full reconciliation
ma:
  parallel_stories: true
  max_parallel_stories: 3
  state_sharding: true
```

`small.yaml` and `medium.yaml` may be near-empty (matching `_base` exactly) — still present so `--profile small` and `--profile medium` resolve identically.

```yaml
# _Sprintpilot/modules/autopilot/profiles/legacy.yaml
name: legacy
version_pinned: "v1.0.5"
# Legacy pins all v1.x-compatible defaults. Explicitly duplicated (not via base)
# so future changes to _base.yaml cannot silently affect legacy behavior.
autopilot:
  implementation_flow: full
  session_story_limit: 3
  retrospective_mode: auto
  phase_timings: false
  coalesce_state_writes: false
  conditional_boot_work: false
  cache_shared_reads: false
git:
  granularity: story
  worktree:
    enabled: true
  squash_on_merge: false
ma:
  parallel_stories: false
  max_parallel_stories: 2
  parallel_epics: false
  state_sharding: false
```

**`legacy` forward-compatibility guarantee (I9).** The `legacy` profile MUST produce a behavior that is a superset of v1.0.5's output — no new files in `_bmad-output/`, no new git-config changes, no new artifact schemas. Future PRs that introduce new artifacts (shards, timings, etc.) MUST gate them on non-legacy profiles. CI includes a `tests/e2e/profile-legacy-v1-parity.test.ts` that asserts a `legacy` sprint produces a file-and-schema superset match against a pre-v2 snapshot. If a future PR would break this, the PR is rejected or the feature is explicitly made legacy-incompatible in CHANGELOG.

**`resolve-profile.js` contract:**

```
resolve-profile.js <command> [--project-root <path>] [--profile <name>]

Commands:
  print      Resolve effective config (base + profile overlay + user overrides) and print as YAML to stdout
  get <key>  Print a single resolved value (e.g. `autopilot.implementation_flow`)
  validate   Confirm profile YAML is well-formed and schema-valid; exit 0/1

Behavior:
  1. Load _Sprintpilot/modules/autopilot/config.yaml — read complexity_profile
     MISSING KEY → default "medium" + log one-time migration notice to stderr
  2. Load profiles/_base.yaml first; then overlay profiles/<profile>.yaml
     (legacy.yaml ignores _base and stands alone — see forward-compat guarantee)
  3. Load _Sprintpilot/modules/{autopilot,git,ma}/config.yaml — user overrides win
  4. Deep-merge using the following semantics:
     - All YAMLs share the same shape (no `settings:` wrapper), so merge is
       straightforward object merge at every level
     - Leaf values: user-override wins, else profile overlay, else base, else undefined
     - Objects: merge keys recursively
     - Null user-override: explicit "unset" — falls back to profile default
       (distinct from missing key, which just means "no override")
     - Arrays: no merge; user-override replaces entirely
  5. Emit resolved config

Reuses: readYaml() from lib/core/bmad-config.js:5-24
```

**Backward-compatibility default.** Existing installs do not have `complexity_profile` in their `config.yaml`. `resolve-profile.js` treats a missing key as `medium` and logs a single-line migration notice the first time it fires. `medium`'s defaults are calibrated to match pre-v2 behavior byte-for-byte (no v2 optimizations active). This is the mechanism that preserves existing installs without requiring a re-run of `install`.

**workflow.md consumes this.** All workflow.md reads of profile-gated knobs go through `resolve-profile.js` — never direct YAML reads — so the missing-key default is applied uniformly.

Workflow.md and other scripts call this instead of reading config YAMLs directly. Keeps the variable-substitution issue (regex vs parse) contained to install-time config patching.

**`check-prereqs.js` contract:**

```
check-prereqs.js [--min-git <semver>]

Exits 0 if:
  - git >= 2.18.0 (submodule --jobs, --reference)
  - node >= 18
  - current dir is a git repo

Warns (exit 0) if git < 2.18.0 but >= 2.5.0 — degraded mode, no reference clone.
Fails (exit 1) if git < 2.5.0 or node < 18.
```

Called from `runInstall` before any file operations. Prevents silent degraded installs.

**Installer profile prompt (slot at `lib/commands/install.js:893`):**

```javascript
// after resolveAutopilotSettings (~line 809), before runInteractiveToolPicker (~line 910)
if (!ctx.yes) {
  const profile = await prompts.select({
    message: 'Which complexity profile fits your project?',
    options: [
      { value: 'nano',   label: 'nano    — toy/tutorial/learning, solo' },
      { value: 'small',  label: 'small   — MVP / internal tool, 1–2 devs' },
      { value: 'medium', label: 'medium  — team product, real users (recommended)' },
      { value: 'large',  label: 'large   — production, compliance/uptime stakes' },
      { value: 'legacy', label: 'legacy  — pre-v4 behavior (rollback)' },
    ],
    initialValue: 'medium',
  });
  ctx.complexityProfile = profile;
} else {
  ctx.complexityProfile = opts.profile || 'medium';  // non-interactive default
}
```

The value is written to `_Sprintpilot/modules/autopilot/config.yaml` via the existing regex patch pattern (see `patchAutopilotConfig` at install.js:733-748 — extend it to a new key).

**CLI flag additions (`bin/sprintpilot.js:49-69`):**

```javascript
program
  .command('install', { isDefault: true })
  .option('--profile <name>', 'Complexity profile: nano|small|medium|large|legacy')
  .option('--advanced', 'Prompt for parallelism, retrospective, and session knobs')
  .option('--parallel <n>', 'Max parallel stories (medium/large, opt-in)', parseInt)
  .option('--retrospective-mode <mode>', 'skip | auto | stop')
  .option('--session-story-limit <n>', 'Stories per session before checkpoint (0=none)', parseInt)
  // existing flags kept: --tools, --yes, --dry-run, --force, --migrate-v1
```

Validation in `runInstall`:

| Combination | Behavior |
|---|---|
| `--parallel > 0` with `--profile nano\|small` | error (unsupported) |
| `--profile legacy` with any v4 flag | error (legacy pins all) |
| `--parallel N` with `N > 4` | error (range 0–4) |
| Missing `--profile` in `--yes` mode | warn + default to `medium` (preserves backward compatibility) |

**AGENTS.md relaxation:**

Replace the "NEVER write implementation code without first completing the mandatory BMad Method story sequence" paragraph with:

```markdown
## Flow selection is profile-driven

The per-story 7-step BMad cycle is mandatory for `small`, `medium`, `large`, and `legacy` profiles. For `nano`, the autopilot routes through `bmad-quick-dev` per story per the Adaptive Process Scaling policy in `_Sprintpilot/modules/autopilot/profiles/nano.yaml`. Quality gates (tests, review) are preserved in every profile.

The policy in this file is enforced by `_Sprintpilot/skills/sprint-autopilot-on/workflow.md`, which reads the resolved profile via `_Sprintpilot/scripts/resolve-profile.js`.
```

**Upgrade migration — three paths, all safe.**

Users upgrade via one of three mechanisms. The plan must handle each:

1. **`npm i -g @ikunin/sprintpilot@latest`** — the majority path. npm doesn't invoke Sprintpilot's own update skill; it just replaces files. For these users, the **missing-key default** in `resolve-profile.js` (treating absent `complexity_profile` as `medium`) is the entire migration. `medium`'s defaults match v1.0.5 behavior byte-for-byte; nothing changes until the user explicitly opts in.

2. **`sprintpilot update`** (the skill-driven path) — minority. The update skill runs `check-prereqs.js`, notes that `complexity_profile` is absent, and emits a one-line log: `"Implicit medium profile active; run 'sprintpilot install --profile <name>' to opt into a different profile."` No interactive prompt — prompting here would surprise scripted workflows. Users who want a different profile re-run install.

3. **Fresh install** (`sprintpilot install` on a clean project) — goes through the new profile prompt in this PR.

**Postinstall banner (npm path).** `package.json` gets a `postinstall` hook that prints the same one-liner the update skill emits when v2 is installed on top of v1. A `SPRINTPILOT_NO_POSTINSTALL=1` env var silences it for CI. This is the only mechanism that reaches npm-upgrading users.

**No prompt-based migration.** We deliberately do **not** prompt for profile selection on upgrade. Rationale: prompting would surprise scripted CI upgrades (`npm i` inside a build pipeline) and the behavior-preserving default makes the prompt unnecessary for anyone who just wants their current setup to keep working. Users who want v2's new features run `sprintpilot install --profile <name>` explicitly.

**Tests (Vitest, mirror `tests/unit/autopilot-config.test.ts` pattern):**

- `tests/unit/resolve-profile.test.ts`:
  - each profile YAML loads and validates
  - overlay precedence: user `config.yaml` > profile default > base
  - unknown profile → exit 1 with clear error
  - `legacy` profile returns frozen snapshot regardless of other knobs
- `tests/unit/check-prereqs.test.ts`:
  - returns 0 on git 2.18+ via mocked `git --version`
  - returns warning on 2.5.0–2.17 via mocked output
  - returns 1 on 2.4.x
- Extend `tests/unit/install-timestamp.test.ts` or add `install-profile.test.ts`:
  - `--profile nano --yes` writes `complexity_profile: nano` to config
  - `--parallel 3 --profile nano` exits with error
  - default `medium` when neither prompt nor flag is given

**Acceptance criteria:**

- [ ] All 5 profile YAMLs exist and pass `resolve-profile.js validate`
- [ ] `sprintpilot install --yes` with no flags writes `complexity_profile: medium`
- [ ] `sprintpilot install --profile nano --yes` writes `complexity_profile: nano`
- [ ] Interactive install shows the profile prompt
- [ ] `--advanced` prompts for parallelism/retrospective/session knobs (deferred bodies, wire in PRs 5, 11)
- [ ] `check-prereqs.js` runs on install; fails fast on old git
- [ ] `resolve-profile.js get autopilot.implementation_flow` prints `quick` for nano, `full` for others
- [ ] AGENTS.md no longer forbids the quick flow
- [ ] All existing tests pass
- [ ] New unit tests cover each profile + validation rule + installer flag

**Rollback.** Revert the PR. Existing installs are unaffected because profile defaults to `medium` (matches pre-PR behavior exactly for `medium`).

---

## PR 2 — M0 phase-timing instrumentation

**Goal.** Emit per-phase duration measurements so every subsequent optimization can be validated against a real baseline instead of estimated percentages. This is the single most important PR for honest prioritization.

**Files created:**

- `_Sprintpilot/scripts/log-timing.js` — append-only JSONL writer
- `_Sprintpilot/scripts/summarize-timings.js` — reads shards, produces hotspot report
- `tests/unit/log-timing.test.ts`

**Files modified:**

- `_Sprintpilot/skills/sprint-autopilot-on/workflow.md` — wrap BMad skill invocations (lines 450, 606) and key phase boundaries with timing hooks
- `_Sprintpilot/modules/autopilot/profiles/*.yaml` — `phase_timings: true` default everywhere except `legacy`

**`log-timing.js` contract:**

```
log-timing.js <action> --story <key> --phase <name> [--meta <json>]

Actions:
  start   Emit {event:"start", story, phase, ts:<iso8601>}
  end     Emit {event:"end",   story, phase, ts:<iso8601>}
  once    Emit a single-event marker (for non-interval things like "health-check-run")

Input validation:
  --story MUST match /^[a-z0-9][a-z0-9-]*$/ (path-traversal guard)
  --phase MUST match /^[a-z][a-z0-9-.]*$/
  --meta MUST be valid JSON and serialize to <2KB (prevents oversized appends)

Output path:
  _bmad-output/implementation-artifacts/.timings/<story>.jsonl
  Created if missing. Appends a single JSON line.
  Single-writer-per-story model: one story-key = one sub-agent = one writer.
  Append-only from one writer is safe without locks. Entries capped at 2KB so
  even on platforms with small PIPE_BUF, a single write() is atomic.

Phase names (convention):
  bootstrap, boot.health-check, boot.branch-reconciliation,
  skill.bmad-create-story, skill.bmad-check-readiness,
  skill.bmad-dev-story, skill.bmad-code-review, skill.bmad-code-review.rereview,
  skill.bmad-quick-dev, skill.bmad-retrospective,
  worktree.add, worktree.submodule-init, worktree.remove,
  git.commit, git.push, git.pr-create, git.merge,
  tests.run, state.write, state.merge
```

Append-only JSONL is race-free per-story (shard per story-key). The summarizer merges across stories at sprint end.

**Workflow.md instrumentation (surgical diffs):**

Around each `INVOKE` site, add:

```xml
<action>Run: `node {{project_root}}/_Sprintpilot/scripts/log-timing.js start --story "{{current_story}}" --phase "skill.{{next_skill}}"`</action>
<action>INVOKE {{next_skill}} skill using the Skill tool</action>
<action>Run: `node {{project_root}}/_Sprintpilot/scripts/log-timing.js end --story "{{current_story}}" --phase "skill.{{next_skill}}"`</action>
```

Insertion points (from prior mapping):
- Line 450 (`INVOKE {{next_skill}}`) — primary skill entry point
- Line 606 (re-invoke `bmad-code-review`) — tag phase as `skill.bmad-code-review.rereview`
- Line 122–245 (boot block) — wrap `boot.health-check`, `boot.branch-reconciliation`
- Line 433 (worktree add) — `worktree.add` + `worktree.submodule-init`
- Line 677 (worktree remove) — `worktree.remove`
- Lines 479, 634, 657, 690 (commit/push/PR/merge) — git phases
- Line 461 (test run after dev-story) — `tests.run`
- Lines 327, 443, 446, 755, 790 (state writes) — `state.write`

**`summarize-timings.js` contract:**

```
summarize-timings.js [--sprint <path>] [--format text|json|md] [--session-only]

Reads all .jsonl under .timings/, computes:
  - Total wall-clock per story
  - Aggregate per-phase time (sum, p50, p95, max)
  - Hotspot ranking (phases consuming > 5% of total)
  - DAG-width stats if dependency info is present

Output: stdout (text/json) or artifact at .timings/summary-<date>.md
  With --session-only: artifact at .timings/summary-session-<ts>.md
```

Runs in **two places** in workflow.md:
- **Session checkpoint** (step 9, line 762+) — `--session-only` so users get timing insights at every checkpoint, not just on rare sprint-complete runs
- **Sprint complete** (step 10, line 828+) — full sprint report

**Tests:**

- `log-timing.js` appends valid JSON lines, creates directories as needed, race-free under parallel invocation (spawn N subprocesses, verify count of lines)
- `summarize-timings.js` correctly aggregates from fixture shards

**Acceptance criteria:**

- [ ] Every BMad skill invocation in workflow.md is wrapped with start/end timing
- [ ] Running a sprint produces `.timings/<story>.jsonl` files
- [ ] `summarize-timings.js` prints a hotspot report
- [ ] Timing overhead is negligible (<100ms per invocation)
- [ ] `phase_timings: false` in `legacy.yaml` suppresses all timing writes
- [ ] Unit tests pass

**Rollback.** Set `phase_timings: false` in the active profile. Instrumentation is a no-op.

---

## PR 3 — State-shard infrastructure

**Goal.** Replace single-writer `autopilot-state.yaml` / `decision-log.yaml` with per-story shards that parallel sub-agents can write without contention. Merged at layer boundary by the coordinator (autopilot). Enables PRs 11 and 12.

**Files created:**

- `_Sprintpilot/scripts/state-shard.js` — per-story read/write primitive
- `_Sprintpilot/scripts/merge-shards.js` — coordinator merge at layer boundary
- `tests/unit/state-shard.test.ts`
- `tests/unit/merge-shards.test.ts`

**Files modified:**

- `_Sprintpilot/skills/sprint-autopilot-on/workflow.md` — swap direct state writes (lines 327, 443, 446, 755, 790) for shard writes; add merge step at layer boundary (sequential execution still merges at end-of-story, parallel at end-of-layer)

**Directory layout:**

```
_bmad-output/implementation-artifacts/
  autopilot-state.yaml              # merged authoritative
  decision-log.yaml                 # merged authoritative
  .autopilot-state/
    <story-key>.yaml                # per-story shard (sub-agent writes)
  .decision-log/
    <story-key>.yaml                # per-story append-only
  .timings/                         # already from PR 2
    <story-key>.jsonl
  .archive/
    layer-<timestamp>/              # post-merge shard archive
```

**`state-shard.js` contract:**

```
state-shard.js <action> --story <key> [--field <path>=<value>] [--append <json>]

Input validation:
  --story MUST match /^[a-z0-9][a-z0-9-]*$/ (path-traversal guard)
  Resolved shard path MUST resolve inside _bmad-output/implementation-artifacts/
  (refuse any --story that escapes via ../ or absolute paths)

Actions:
  write   Write/update a field. Atomic via .tmp + rename.
          Auto-sets shard.updated_at = <iso8601-with-nanos> on every write.
  read    Print the shard as YAML to stdout.
  append  Append an entry to a list field (decision-log use case).
  init    Create an empty shard with updated_at set.

All operations are single-writer per story-key — no locking needed.
```

**Shard schema (minimum fields):**

```yaml
story: <key>
updated_at:
  wall: "2026-04-23T14:22:05.123Z"       # ISO8601 millisecond precision (Node's toISOString)
  monotonic: "4127891234567"             # process.hrtime.bigint() as string; merge tiebreaker
schema_version: 1
# … arbitrary user fields
```

**Merge tiebreaker (addresses the earlier gap).** `merge-shards.js` picks the shard with max(`updated_at.monotonic`) per key. Node's `process.hrtime.bigint()` returns nanosecond-precision monotonic ticks — not wall-clock but strictly increasing within a process, which is exactly what we need for tiebreaking. For merges across sessions (different processes), we fall back to `updated_at.wall` millisecond ordering; ties within a millisecond across sessions are extraordinarily rare and are resolved alphabetically by shard filename. If `updated_at` is missing from a shard (corrupt/legacy), that shard is treated as invalid (see recovery below).

Rationale for the split: monotonic time is safe from NTP slew and clock drift — critical when parallel sub-agents race to write — but not meaningful across process restarts. Wall-clock time is meaningful cross-process but vulnerable to clock changes. Storing both lets the merger use the right tool for each case.

**Partial-YAML crash recovery — full state machine:**

1. Coordinator reads each shard with a YAML parser.
2. **Shard parses cleanly AND has `updated_at`:** include in merge.
3. **Shard fails to parse OR missing `updated_at`:**
   - Move shard to `.archive/corrupt/<story>-<ts>.yaml` (never delete — keeps audit trail)
   - Write a marker entry to decision-log: `{ category: "shard-corruption", story, impact: "high" }`
   - Mark the story `failed-shard-corruption` in merged state
   - **Halt the current layer** (other in-flight stories finish, but no new ones start)
   - Surface to user on next autopilot step with recovery instructions
4. User-initiated recovery: inspect the archived shard, decide whether to rerun the story (delete the `failed-shard-corruption` marker + rerun) or accept the failure.

Recovery is conservative by design — a corrupt shard is treated as a potential data loss, not a transient error.

**`merge-shards.js` contract:**

```
merge-shards.js [--layer <id>] [--archive]

Reads all shards in .autopilot-state/ and .decision-log/, merges into the project-level files:
  - State: merge by story-key; last-writer wins per key (unexpected overlap logged)
  - Decision log: concatenate entries, sort by timestamp, dedupe by id
  - Always atomic write (.tmp + rename)

If --archive: move merged shards to .archive/layer-<id>/ (never delete during sprint)

Idempotent: running twice produces the same result.
```

**Crash recovery.** Shards survive coordinator crashes. Next session re-runs merge idempotently. Invalid YAML in a shard is reported and the story is treated as failed at that layer.

**Workflow.md integration:**

- Sequential path (default): shard write + immediate merge after each story. Equivalent to today's behavior with one extra file indirection; marginal cost.
- Parallel path (PR 11): shard writes during parallel execution; single merge at layer boundary.

Config flag: `state_sharding: auto | always | never`. `auto` = shard only when parallelism is active.

**Tests:**

- Concurrent writes from N subprocess children to different story shards (safe — no contention)
- Merge handles empty directory (no shards yet)
- Merge deduplication on decision-log ids
- Invalid YAML in one shard doesn't corrupt others
- Idempotency: merge × 2 == merge × 1

**Acceptance criteria:**

- [ ] `state-shard.js` passes tests under concurrent access
- [ ] `merge-shards.js` produces identical merged output on repeat runs
- [ ] Sequential sprint produces the same final `autopilot-state.yaml` / `decision-log.yaml` shape as pre-PR baseline
- [ ] Archive directory populated after merge
- [ ] `state_sharding: never` falls back to direct writes (today's behavior)

**Rollback.** Set `state_sharding: never` in the profile. The autopilot writes directly to project-level files as before.

---

## PR 4 — Nano routing: `bmad-quick-dev` per story

**Goal.** When `complexity_profile: nano` is active, route each story through `bmad-quick-dev` instead of the full 7-step cycle. `bmad-quick-dev` HALTs on multi-goal input (confirmed in upstream research), so the unit of work remains **one story per call**. Quick-dev's one-shot path (`step-oneshot.md:44`) handles Implement → Review → Classify → Commit internally — quality gates preserved.

**Files modified:**

- `_Sprintpilot/skills/sprint-autopilot-on/workflow.md` — add a profile branch in step 3 (lines 399–455) that picks the implementation skill based on `implementation_flow`; update step 4 completion handler to recognize quick-dev's output
- `_Sprintpilot/modules/autopilot/profiles/nano.yaml` — `implementation_flow: quick`
- `_Sprintpilot/skills/sprint-autopilot-on/SKILL.md` — reference the profile-driven flow in the description

**Workflow.md changes (conceptual diff):**

At step 3 top (around line 401), before "Create task `{{next_skill}}` → mark `in_progress`":

```xml
<action>Resolve `{{implementation_flow}}` by running: `node {{project_root}}/_Sprintpilot/scripts/resolve-profile.js get autopilot.implementation_flow`</action>

<check if="{{implementation_flow}} is quick AND {{next_skill}} is bmad-dev-story">
  <action>Override `{{next_skill}}` = `bmad-quick-dev`</action>
  <action>Log decision (category: scope, phase: autopilot:routing): "Routing {{current_story}} through bmad-quick-dev per nano profile"</action>
</check>
```

In step 4 completion handler (line 460 "if completed_skill was bmad-dev-story" block), add a peer check:

```xml
<check if="{{completed_skill}} was bmad-quick-dev">
  <action>Verify quick-dev's sync-sprint-status ran — story should be at `review` or later in sprint-status.yaml</action>
  <action>Read quick-dev's Classify severity from its output. If high: set {{escalate_next}} = true</action>
  <action>Set {{next_skill}} = (none) — quick-dev handled review internally per step-oneshot.md</action>
  <goto step="7">Mark story done</goto>
</check>
```

Step 7 ("Mark story done") already handles the terminal commit/push/PR path; it doesn't need quick-dev-specific logic because quick-dev already did its internal commit.

**Skipped steps under nano (autopilot never invokes):**

- `bmad-create-story` — quick-dev reads AC from sprint-status.yaml directly via its `{story_key}` resolution path (`step-01-clarify-and-route.md:40-44`)
- `bmad-check-implementation-readiness`
- `bmad-dev-story` (replaced by quick-dev)
- `bmad-code-review` (quick-dev's internal `step-04-review.md` runs instead)

**Fallback / escalation (nano safety net):**

Add to nano.yaml:

```yaml
autopilot:
  nano:
    fallback_triggers:
      - tests_fail: true
      - quick_dev_classify_severity: high
    on_fallback: escalate_to_small
```

Workflow.md wires this in step 4 — if `{{escalate_next}}` is set or tests failed, the autopilot flips `complexity_profile` to `small` for the remainder of this session and logs an `escalation` entry in the decision log. This is a session-scoped override, not persisted to config.yaml.

**AGENTS.md update (tiny, builds on PR 1):**

```markdown
## nano profile — quick flow

When `complexity_profile: nano`, the autopilot routes each story through `bmad-quick-dev`. Quick-dev's one-shot path performs Implement → Review → Classify → Commit in a single skill call (BMad `step-oneshot.md:44`). No additional review is bolted on.
```

**Tests:**

- `tests/unit/workflow-nano-routing.test.ts` (new) — verify the routing logic in isolation (fixture sprint-status with nano profile, mocked resolve-profile output, assert next_skill becomes bmad-quick-dev)
- `tests/e2e/nano-greenfield.test.ts` (new) — end-to-end: install nano profile, run one epic of a 2-story tic-tac-toe spec, verify quick-dev is invoked and spec files exist

**Acceptance criteria:**

- [ ] With nano profile, `bmad-dev-story` is never invoked
- [ ] `bmad-quick-dev` is invoked once per story
- [ ] sprint-status.yaml transitions ready-for-dev → in-progress → review via quick-dev's sync helper (no direct writes from autopilot)
- [ ] Test suite runs after quick-dev and failure triggers escalation
- [ ] `resolve-profile.js get autopilot.implementation_flow` returns `quick` under nano
- [ ] All non-nano profiles behave unchanged
- [ ] E2E test passes for a 2-story nano epic

**Rollback.** Set `complexity_profile: small` (or any non-nano profile). Routing reverts to the full 7-step cycle.

---

## PR 5 — Nano orchestration cuts

**Goal.** The remaining nano savings come from orchestration overhead, not skill reduction. Turn off worktrees, move to PR-per-epic with squash-merge, skip retrospectives, drop session story limit. No quality impact — all these concern git/session mechanics only.

**Files modified:**

- `_Sprintpilot/modules/autopilot/profiles/nano.yaml` — set orchestration defaults
- `_Sprintpilot/modules/git/config.yaml` — add `granularity: story | epic` key with default `story`; document
- `_Sprintpilot/skills/sprint-autopilot-on/workflow.md` — honor `granularity` in step 3 (worktree creation, lines 419–444) and step 7 (push/PR, lines 631–691)
- `_Sprintpilot/scripts/sync-status.js` — add `--granularity epic` mode that keys branch registration by epic

**nano.yaml additions:**

```yaml
settings:
  autopilot:
    session_story_limit: 0         # no checkpointing
    retrospective_mode: skip
  git:
    granularity: epic
    worktree:
      enabled: false
    squash_on_merge: true
  ma:
    parallel_stories: false        # keep nano simple
```

**Workflow.md changes:**

At step 3 worktree-creation gate (line 419):

```xml
<check if="{{git_enabled}} AND {{worktree_enabled}} AND {{next_skill}} is bmad-dev-story OR {{next_skill}} is bmad-quick-dev">
  <!-- existing worktree creation logic -->
</check>
<check if="NOT {{worktree_enabled}}">
  <!-- fallback: in-place on base branch, but create per-epic branch once per epic -->
  <check if="{{granularity}} is epic AND this is the first story of the epic">
    <action>Create branch: git checkout -B {{branch_prefix}}epic-{{epic_id}}-{{epic_slug}}</action>
  </check>
</check>
```

At step 7 (line 617+) push/PR block, switch based on `granularity`:

```xml
<check if="{{granularity}} is epic">
  <check if="this is the LAST story of the epic">
    <action>Push branch, create PR/MR with epic-level title, merge with --squash</action>
  </check>
  <check if="not last story of epic">
    <action>Stage + commit locally with "feat(epic-{{epic_id}}): {{story_title}} ({{current_story}})". Do not push/PR yet.</action>
  </check>
</check>
<check if="{{granularity}} is story">
  <!-- existing per-story push/PR logic -->
</check>
```

**Squash-merge behavior:**

For the epic PR, use `git merge --squash` (or platform PR squash option) so the base branch records a single epic-scope commit with the story commits as its body. Preserves individual-story detail in the PR description.

**Tests:**

- Unit test for `sync-status.js --granularity epic` mode
- E2E test: nano 2-epic × 2-story run produces exactly 2 PRs (not 4)
- Regression: non-nano profiles still produce per-story PRs

**Acceptance criteria:**

- [ ] Nano sprint creates 1 branch per epic, not per story
- [ ] Nano sprint creates 1 PR per epic with squash-merge
- [ ] Worktrees directory stays empty under nano
- [ ] Retrospective skill is never invoked under nano
- [ ] No session checkpoint interrupts a nano sprint
- [ ] `small` / `medium` / `large` behavior is byte-identical to pre-PR

**Rollback.** Edit `nano.yaml` to set `granularity: story`, `worktree.enabled: true`, `retrospective_mode: auto`.

---

## PR 6 — M3: Coalesce state writes

**Goal.** Today the autopilot writes `autopilot-state.yaml`, `decision-log.yaml`, `git-status.yaml` multiple times per story (see workflow.md lines 327, 443, 446, 755, 790, plus sync-status.js calls in step 7). Coalesce into one commit per story and one artifact commit per sprint-close. Compounds over long sprints.

**Files modified:**

- `_Sprintpilot/skills/sprint-autopilot-on/workflow.md` — buffer shard writes in memory, flush at story boundary only
- `_Sprintpilot/scripts/state-shard.js` — add batch write option

**Dependency:** PR 3 shard infrastructure.

**Mechanism:**

Track a per-story dirty-set of field changes. When a step would write, append to the dirty-set instead. At story boundary (end of step 7), emit one shard write with the accumulated changes.

Commit batching: currently workflow.md commits artifacts multiple times per story (post-review at line 688, post-patches, post-done). Fold into a single `docs: story <key> complete` commit at story-done time.

**Critical-state keys that bypass coalescing (always flush immediately):**

| Key | Why critical |
|---|---|
| `current_story` | Required for resume after crash — without it, autopilot can't pick up where it left off |
| `current_bmad_step` | Same — step granularity determines whether to re-invoke a skill on resume |
| `in_worktree` | If true on resume, autopilot must `cd` into the worktree before any subsequent action |
| `patch_commits` (step 6) | Mid-patch-loop recovery — each patch commit SHA must be persisted so a crash doesn't leave orphaned commits |

All other fields (test counts, completion notes, file lists, timing metadata, non-critical decision-log entries) coalesce to one write per story boundary. (Note: the `.autopilot.lock` file is managed by `lock.js` and lives outside `autopilot-state.yaml` entirely; coalescing does not affect it.)

**nano.yaml / all profiles:** `coalesce_state_writes: true` default (except `legacy`).

**Tests:**

- Unit test: simulate 5 field changes, assert only 1 shard write occurs at flush
- Regression: merged `autopilot-state.yaml` is byte-equivalent to pre-PR after a full story cycle

**Acceptance criteria:**

- [ ] Fewer filesystem writes per story (measure via `log-timing.js` state.write count)
- [ ] Git commit graph shows one `docs:` commit per story instead of three
- [ ] Final merged state YAMLs identical to pre-PR

**Rollback.** `coalesce_state_writes: false`.

---

## PR 7 — M4: Conditional boot work

**Goal.** Current bootstrap (workflow.md:194–242) runs health-check and branch reconciliation on every session start, even when there are no worktrees and no in-progress stories to reconcile. Skip when the repo is clean.

**Files modified:**

- `_Sprintpilot/skills/sprint-autopilot-on/workflow.md` — wrap lines 194–242 in a clean-repo guard

**Guard logic (before line 194):**

```xml
<action>Count worktrees: `git worktree list --porcelain | grep -c '^worktree '` → `{{worktree_count}}`</action>
<action>Count in-progress stories: parse sprint-status.yaml, count status != done and != backlog → `{{in_progress_count}}`</action>

<check if="{{conditional_boot_work}} AND {{worktree_count}} == 1 AND {{in_progress_count}} == 0">
  <action>Log: "Boot fast-path: no worktrees, no in-progress stories — skipping health check and branch reconciliation"</action>
  <goto after="line 245">Skip to post-boot logic</goto>
</check>
```

**`large` profile:** `conditional_boot_work: false` — always run full reconciliation. Rationale: compliance/uptime projects shouldn't skip safety checks.

**Tests:**

- Unit test for the guard: both conditions true → skip; either false → full path
- Regression: existing e2e tests still pass (health-check runs when needed)

**Acceptance criteria:**

- [ ] Fresh clone + first `sprint-autopilot-on` run: boot takes <2s (vs current ~10–30s)
- [ ] Repo with any worktree runs full reconciliation
- [ ] Repo with in-progress story runs full reconciliation
- [ ] Large profile always runs full reconciliation

**Rollback.** `conditional_boot_work: false` on the active profile.

---

## PR 8 — M5: Cached per-iteration reads

**Goal.** Workflow.md re-reads `sprint-status.yaml`, `git-status.yaml`, `decision-log.yaml` at many step boundaries. Cache once per loop iteration, invalidate on our own writes.

**Files modified:**

- `_Sprintpilot/skills/sprint-autopilot-on/workflow.md` — introduce a loop-scoped cache block at step 2 (line 347); invalidate on state writes
- `_Sprintpilot/scripts/resolve-profile.js` — expose `--cache-reads` flag so other scripts can participate

**Mechanism:**

Step 2 (main execution loop) reads the three files once at the top. Subsequent steps in the same iteration reference the cached values rather than re-reading. Any state write invalidates the cache for that file only.

**Dependency:** None strictly, but plays well with PR 3 sharding — reads the merged files, not shards.

**Tests:**

- Unit: simulate a single loop iteration, count file reads (should be 3, not 15+)
- Regression: state consistency preserved across multi-iteration runs

**Acceptance criteria:**

- [ ] Per-iteration file-read count drops measurably
- [ ] State semantics unchanged — caches never serve stale data across invalidation boundaries

**Rollback.** `cache_shared_reads: false`.

---

## PR 9 — Dependency sidecar + DAG resolver

**Goal.** BMad story files have no formal `depends_on:` field. Ship a Sprintpilot-owned sidecar for explicit dependency declarations, plus a resolver that consumes it (or falls back to sprint-status ordering + file-touch prediction). Required by PRs 11 and 12 for DAG construction.

**Files created:**

- `_Sprintpilot/sprints/dependencies.yaml` — template only (user authors per project)
- `_Sprintpilot/scripts/resolve-dag.js` — DAG builder, emits JSON graph to stdout
- `tests/unit/resolve-dag.test.ts`

**Files modified:**

- `_Sprintpilot/skills/sprint-autopilot-on/workflow.md` — call resolver at step 2 when parallelism is enabled (reserved; actual parallel dispatch lands in PR 11)

**`dependencies.yaml` schema (authoritative template):**

```yaml
# Sprintpilot-owned; BMad never reads this file
# Path: _Sprintpilot/sprints/dependencies.yaml
#
# Purpose: declare intra-epic story dependencies so Sprintpilot can build
# an accurate DAG for parallel execution. BMad story files have no
# formal dependency field, so dependencies live here.

version: 1

stories:
  "1-3-user-profile":
    depends_on: ["1-1-data-model", "1-2-auth"]
  "1-4-avatar-upload":
    depends_on: ["1-3-user-profile"]

overrides:
  - epic: 2
    force_sequential: ["2-3", "2-4"]
    force_independent: ["2-1", "2-2"]

epics:
  "2":
    independent: true           # enables cross-epic parallelism (PR 12) for this epic
```

**`resolve-dag.js` contract:**

```
resolve-dag.js <command> [--epic <id>] [--project-root <path>] [--strategy <list>]

Commands:
  graph   Emit the DAG for an epic (or all epics) as JSON:
          { "nodes": ["1-1", "1-2", ...], "edges": [["1-1", "1-3"], ...] }
  layers  Emit the topological layers: [["1-1"], ["1-2", "1-3"], ["1-4"]]
  width   Emit max parallel width as int

Strategies (default priority):
  explicit    Read dependencies.yaml
  ordering    Use sprint-status.yaml linear order
  files       Predict from story Tasks/Subtasks file paths (conflict = edge)

Default strategy: [explicit, ordering]. files is opt-in.
Conflict resolution: explicit > files > ordering.
```

**LLM-inferred graphs — out of scope for Sprintpilot scripts.** Sprintpilot scripts never call LLMs (enforced by architecture — see concept §7.6). If a user wants AI-inferred dependency graphs, the workflow is:

1. User invokes a dedicated host-agent skill (future `sprintpilot-infer-dependencies` — not in this plan) that reads story files and proposes a `dependencies.yaml`.
2. User reviews + commits the proposed sidecar.
3. `resolve-dag.js` consumes it via the `explicit` strategy.

This keeps all LLM interaction on the host-agent side and all sidecar authoring user-affirmed. No silent LLM graph inference from Sprintpilot scripts.

**Default behavior when dependencies.yaml is absent:** linear chain from sprint-status order. Safe — no parallelism possible without explicit input. This preserves "no surprises": users opt in to parallelism by authoring dependencies.

**Discoverability (M11).** A hand-authored sidecar is easy to miss in docs. PR 9 adds a scaffolding subcommand:

```
sprintpilot dependencies scaffold [--epic <id>] [--force]

Writes _Sprintpilot/sprints/dependencies.yaml from sprint-status.yaml:
  - Declares a linear chain by default (safest starting point)
  - Adds commented-out "force_independent" examples the user can uncomment
  - Refuses to overwrite an existing file unless --force
```

The installer's post-install success message (for medium/large profiles) mentions the command:

```
✓ Sprintpilot installed with profile: medium

Parallel story execution is available. To enable:
  1) sprintpilot dependencies scaffold --epic 1
  2) Edit _Sprintpilot/sprints/dependencies.yaml (uncomment independent stories)
  3) Set parallel_stories: true in _Sprintpilot/modules/ma/config.yaml
```

**Tests:**

- Unit: DAG for known fixture (3 stories, 1 dep) produces correct layers
- Unit: cycle detection (reject and error)
- Unit: `force_independent` override bypasses file-touch inference
- Integration: resolver handles missing sidecar gracefully (returns linear chain)

**Acceptance criteria:**

- [ ] `resolve-dag.js layers --epic 1` prints correct layers for fixture projects
- [ ] Missing `dependencies.yaml` → linear chain, exit 0
- [ ] Cycle in sidecar → exit 1 with clear error
- [ ] `--strategy files` detects conflict on shared file paths
- [ ] Workflow.md logs DAG decision to decision-log
- [ ] No behavioral change yet (PR 11 consumes this)

**Rollback.** Delete or empty `dependencies.yaml`. Resolver falls back to linear chain, autopilot behavior identical to pre-PR.

---

## PR 10 — Worktree cost mitigation + concurrent discipline

**Goal.** Cut per-worktree submodule init from ~30s to ~2–5s and establish the concurrent-worktree disciplines that PR 11 requires. No parallelism yet; this just fixes the per-worktree overhead and adds the locks/retries parallel execution will need.

**Files modified:**

- `_Sprintpilot/skills/sprint-autopilot-on/workflow.md` — change submodule init command (line 440), wrap ref-lock operations with retry, disable `gc.auto` during sessions
- `_Sprintpilot/scripts/sanitize-branch.js` — no change, but wrap callers with ref-lock retry helper

**Files created:**

- `_Sprintpilot/scripts/with-retry.js` — generic retry wrapper for git commands
- `_Sprintpilot/scripts/submodule-lock.js` — thin wrapper around `lock.js --file` for `.git/modules/.sprintpilot-submodule-lock`

**Submodule init change (workflow.md line 440):**

Before:
```
git submodule update --init --recursive
```

After:
```
# Resolve the common git dir — worktrees' .git is a file, not a directory,
# so --reference must point at the parent's real .git (via --git-common-dir).
GIT_COMMON=$(git -C {{project_root}} rev-parse --git-common-dir)

git -C .worktrees/<story> submodule update \
    --init --recursive \
    --reference "$GIT_COMMON" \
    --jobs=4
```

Requires git ≥ 2.18 (already enforced by PR 1 `check-prereqs.js`). On older git (warning mode), fall back to the old command (no `--reference`, no `--jobs`).

**Validate on first real worktree.** PR 10 acceptance includes a test that creates a worktree on a repo with submodules and confirms the `--reference` command succeeds. If it fails on any supported platform, fall back per-worktree to the plain command with a logged warning.

**Concurrent discipline adds:**

1. **Per-submodule lock** — wrap each `git submodule update` call with:
   ```
   node _Sprintpilot/scripts/submodule-lock.js acquire --submodule <path>
   git -C ... submodule update ...
   node _Sprintpilot/scripts/submodule-lock.js release --submodule <path>
   ```
   Lock path: `{{project_root}}/.sprintpilot/submodule-locks/<submodule-slug>.lock` (outside `.git/` so git doesn't warn about foreign files in its directory; `.sprintpilot/` already gitignored alongside `_bmad-output/`). Reuses `lock.js --file <path>`.

2. **Disable `gc.auto` per-worktree.** `git config --local gc.auto 0` applies only to the current worktree's config in git ≥ 2.5 — it does not propagate. Apply in two places:
   - **Main repo bootstrap** (workflow.md ~line 125):
     ```
     git config --local gc.auto 0   # main repo
     ```
   - **Each worktree creation** (workflow.md ~line 433, immediately after `git worktree add`):
     ```
     git -C .worktrees/<story> config --local gc.auto 0
     ```
   Save original `gc.auto` value before overwriting; restore symmetrically at teardown (step 10 + worktree-remove step 7).

3. **Ref-lock retry** — wrap ref-mutating commands (`git fetch`, `git push`, `git worktree add/remove`, `git branch`) with `with-retry.js`:
   - 3 attempts, jittered backoff 500ms–2s
   - Retry-triggering regex (case-insensitive, spans git versions):
     ```
     /cannot lock ref|Unable to create.*\.lock|Reference already exists|failed to lock|lock.ref/i
     ```
   - Log full stderr for any **non-retried** failure so the regex can be extended in follow-up
   - Fail loudly on non-ref errors (no blind retry)

4. **Never prune during active work** — `git worktree prune` is already confined to bootstrap and sprint teardown in current workflow.md; add an explicit comment and a guard (`if any .worktrees/ entries exist and any story status = in-progress: refuse to prune`).

5. **Worktree `.git` path audit.** During PR 10, grep workflow.md + scripts for any command that expects `<worktree>/.git` to be a directory (e.g. `ls .git/refs/...` inside a worktree). Replace with `git -C <worktree> <subcommand>` so git resolves the file-pointer correctly.

**Workflow.md insertion at bootstrap (line 125):**

```xml
<action>Save original gc.auto value: `git config --get gc.auto || echo "unset"` → {{original_gc_auto}}</action>
<action>Disable gc.auto: `git config --local gc.auto 0`</action>
```

At sprint complete (step 10, line ~828):

```xml
<action>Restore gc.auto: if {{original_gc_auto}} == "unset" → `git config --local --unset gc.auto`, else → `git config --local gc.auto {{original_gc_auto}}`</action>
```

**Tests:**

- Integration: clone a repo with 1 submodule, create 3 worktrees, measure submodule init time before/after change — assert new is <= 30% of baseline per worktree
- Unit: `with-retry.js` retries on simulated ref-lock error, gives up after 3 tries, doesn't retry on unrelated errors
- Unit: `submodule-lock.js` serializes concurrent acquire/release pairs
- Fixture: create `tests/e2e/fixtures/with-submodule/` — minimal git repo + one submodule (another tiny local repo). Fixture setup script creates both. Existing test fixtures have no submodules, so this is new.

**Additional files created (fixture):**

- `tests/e2e/fixtures/with-submodule/` — directory with `.gitmodules`, one submodule pointing at a sibling fixture repo
- `tests/e2e/fixtures/with-submodule/setup.sh` — reproducible initialization script
- `tests/unit/worktree-path-audit.test.ts` — scans workflow.md + scripts for any call that treats `<worktree>/.git` as a directory (catches regressions of M7)

**Acceptance criteria:**

- [ ] Submodule init time per worktree drops measurably (target: <= 30% of baseline) on the with-submodule fixture
- [ ] `gc.auto` disabled during session in **main repo and every worktree**, restored symmetrically at end (verified by `git -C <dir> config --get gc.auto`)
- [ ] Ref-lock retry succeeds on transient contention (simulated in test)
- [ ] Per-submodule lock serializes concurrent submodule updates
- [ ] Worktree-less profiles (nano) unaffected
- [ ] Worktree-path audit test passes (no code treats worktree's `.git` as a dir)

**Rollback.** Revert the PR. Older workflows continue to init submodules the slow way; the retry wrapper is a no-op if not invoked.

---

## PR 11 — M2: Parallel intra-epic stories

**Goal.** Enable parallel execution of independent stories within an epic. This is the main medium+ wall-clock win. Requires PRs 3 (shards), 6 (coalesced writes), 9 (DAG), 10 (worktree discipline).

**Host-agent scope (read this first).** True parallel execution requires the host agent to spawn concurrent sub-agents. Of the 9 supported hosts, only Claude Code has a first-class multi-agent Agent tool today. Other hosts (Cursor, Windsurf, Gemini CLI, Cline, Roo, Trae, Kiro, GitHub Copilot) either don't spawn sub-agents or do so in ways Sprintpilot cannot reliably orchestrate. Therefore:

- **PR 11 ships Claude-Code-first.** On Claude Code, `parallel_stories: true` runs N sub-agents concurrently as designed.
- **On other hosts, `parallel_stories: true` silently degrades to sequential** and logs a one-line notice: `parallel_stories requested but host '{{host}}' does not declare parallel support; running sequentially`.
- **No quality gap.** Sequential fallback uses the existing 7-step cycle per story; it's just not wall-clock-optimized.
- **Future hosts can opt in** by adding `supports_parallel: true` to the AgentAdapter (see below).

This scoping is documented explicitly in `docs/USAGE.md` in this PR; users on non-Claude-Code hosts get a predictable experience instead of a silent no-op.

**Files modified:**

- `_Sprintpilot/skills/sprint-autopilot-on/workflow.md` — rewrite step 2 inner loop to dispatch by layer when parallelism is enabled AND host declares support
- `_Sprintpilot/modules/ma/config.yaml` — `parallel_stories`, `max_parallel_stories`, `max_consecutive_conflicts`
- `lib/core/tool-registry.js` — extend each entry with `supports_parallel: boolean`
- Profile YAMLs: `medium.yaml` (opt-in default 2), `large.yaml` (on, default 3)

**Files created:**

- `_Sprintpilot/scripts/dispatch-layer.js` — orchestrator: given a layer of story keys, spawns N host-agent sub-invocations per story, awaits, merges shards
- `_Sprintpilot/scripts/agent-adapter.js` — thin helper that reads the current host from `.claude-code/` / `.cursor/` / etc. presence markers and returns `{ host, supports_parallel }`

**Dispatch model:**

The autopilot runs in the host coding agent (Claude Code, Cursor, etc.). For parallelism, it asks the host agent to spawn N sub-agents via the agent's native mechanism. Each sub-agent runs its story in an isolated worktree using the existing `bmad-dev-story` → `bmad-code-review` cycle. When all complete, the coordinator (top-level autopilot) merges state shards.

**`agent-adapter.js` contract:**

```
agent-adapter.js detect [--project-root <path>]

Output (stdout, JSON):
  {
    "host": "claude-code" | "cursor" | "aider" | ... | "unknown",
    "supports_parallel": true | false,
    "detection_reason": "<human-readable>",
    "confidence": "high" | "medium" | "low"
  }

Detection priority (first match wins):
  1. Env vars set by the running host (HIGH confidence):
     - CLAUDECODE=1 or CLAUDE_CODE_SESSION_ID        → claude-code
     - CURSOR_SESSION_ID or CURSOR_TRACE_ID          → cursor
     - WINDSURF_SESSION                              → windsurf
     - AIDER_SESSION or AIDER_HISTORY_FILE set       → aider
     - CLINE_* env                                   → cline
  2. Parent process name (MEDIUM confidence):
     - parent == "claude"        → claude-code
     - parent == "cursor-agent"  → cursor
     - parent == "aider"         → aider
  3. Filesystem markers as last resort (LOW confidence — flagged):
     - .claude/skills/ AND .claude-code/ AND env unset
       → claude-code, low confidence — but still supports_parallel=false
       because filesystem markers prove install target, not current host

Tautology guard: Sprintpilot install artifacts (.claude/skills/ etc.)
are insufficient evidence on their own. Detection returning confidence=low
forces supports_parallel=false regardless of which host the markers suggest.

Unknown or low confidence → supports_parallel=false.
```

workflow.md calls this before dispatch-layer.js and falls back to sequential if `supports_parallel: false` **or** `confidence: low`.

**Why this matters (C7 rationale).** The filesystem markers a previous review caught as tautological (`.claude/skills/` existing because install was run for Claude Code, not because Claude Code is the current host) are now explicitly demoted to low-confidence evidence that never triggers parallelism. Only env vars — which the currently-running host actually sets — can enable parallel mode.

**Workflow.md step 2 change (conceptual):**

```xml
<step n="2" goal="Main execution loop — layer-aware">

<check if="all stories done">
  <goto step="10">Sprint complete</goto>
</check>

<check if="{{parallel_stories}} AND {{implementation_flow}} is full">
  <action>Run: `node resolve-dag.js layers --epic {{current_epic}}` → {{layers}}</action>
  <action>For layer in {{layers}}:</action>
  <action>  If len(layer) == 1: execute sequentially (existing path)</action>
  <action>  Else:</action>
  <action>    Check: min_epic_duration_for_parallel_sec heuristic — if epic too small, serialize</action>
  <action>    Invoke: `node dispatch-layer.js --layer "{{layer}}" --max-parallel {{max_parallel_stories}}"`</action>
  <action>    Each parallel sub-agent executes the 7-step BMad cycle in its worktree</action>
  <action>    After layer completes: `node merge-shards.js --layer {{layer_id}} --archive`</action>
</check>

<check if="NOT {{parallel_stories}}">
  <!-- existing sequential logic -->
</check>

</step>
```

**`dispatch-layer.js` contract:**

```
dispatch-layer.js --layer <story,story,...> --max-parallel <n>
                  [--project-root <path>] [--branch-prefix <str>]

For each story in --layer (respecting --max-parallel concurrency cap):
  1. Create worktree for story (using PR 10's fast submodule init)
  2. Emit instruction to host agent to run the story's 7-step cycle
     in that worktree, writing state shards
  3. Await completion
  4. Verify shard exists and story.status is 'done' or 'failed'

Returns JSON summary: { completed: [...], failed: [...], effective_parallel: <n> }

Failure handling:
  - Single story fails → continue others, report at end
  - max_consecutive_conflicts reached → disable parallelism for session, serialize remaining
  - Rate-limit/error from host agent → reduce effective_parallel by 1, retry once
```

**Important tool-agnostic note:** `dispatch-layer.js` doesn't itself call LLMs. It creates worktrees and writes a layer plan that the host agent consumes via the workflow.md step. The host agent (Claude Code / Cursor / etc.) does the actual sub-agent spawning. This preserves Sprintpilot's tool-agnostic architecture.

**Failure-driven concurrency reduction (replaces the dropped cost circuit breaker):**

```yaml
# ma/config.yaml additions
multi_agent:
  parallel_stories: false              # medium default; large overrides
  max_parallel_stories: 2              # medium default; large: 3
  min_epic_duration_for_parallel_sec: 300
  baseline_story_duration_sec: 180
  max_consecutive_conflicts: 2
  effective_parallel_floor: 1          # never drop below 1 mid-session
```

**Tests:**

- Unit: `dispatch-layer.js` with mocked host-agent invocation, verify worktrees created and shards merged
- Unit: concurrency cap respected (max 3 concurrent even with 5-story layer)
- E2E: medium-profile 4-epic project with `parallel_stories: 2` completes faster than sequential (relative measurement via log-timing)
- Regression: `parallel_stories: false` path is byte-identical to pre-PR

**Acceptance criteria:**

- [ ] Single-story layer behaves identically to sequential (fast path)
- [ ] Multi-story layer spawns N worktrees, merges shards at end
- [ ] Failure in one story doesn't abort layer (others complete)
- [ ] `max_consecutive_conflicts` disables parallelism for the session
- [ ] `min_epic_duration_for_parallel_sec` heuristic correctly serializes small epics
- [ ] Merge at layer boundary produces valid `autopilot-state.yaml` / `decision-log.yaml`
- [ ] E2E test shows measurable wall-clock reduction on a 2-wide DAG

**Rollback.** `parallel_stories: false`. Autopilot reverts to sequential, existing path.

---

## PR 12 — Cross-epic parallelism (experimental)

**Goal.** Allow two epics to run concurrently when both declare `independent: true` in the dependency sidecar. Highest risk — gated with strict safety rails. Ships off by default on all profiles including `large`.

**Files modified:**

- `_Sprintpilot/skills/sprint-autopilot-on/workflow.md` — add cross-epic layer at the outermost loop
- `_Sprintpilot/modules/ma/config.yaml` — `parallel_epics` (default false), `max_parallel_epics` (hardcoded 2)
- Profile YAMLs: no default changes; `large.yaml` exposes `parallel_epics: false` with comment noting experimental status

**Files created:**

- `_Sprintpilot/scripts/preflight-merge.js` — dry-run merge check to detect conflicts before parallel epic execution

**Safety rails (all must pass):**

1. Both epics carry `independent: true` in `dependencies.yaml`
2. Pre-flight dry-run merge: `git merge --no-commit --no-ff <epic-a> && git merge --no-commit --no-ff <epic-b>` produces no conflicts (then `git merge --abort`)
3. `max_parallel_epics` hardcoded at 2 — no tuning knob
4. If any cross-epic merge conflict occurs in the session, `parallel_epics` is disabled for the rest of the session
5. Experimental warning printed when enabled

**`preflight-merge.js` contract:**

```
preflight-merge.js --epics <id1,id2,...> --base <branch>

Lock acquisition (addresses race window — M13):
  - Acquire via: node lock.js acquire --file .sprintpilot/preflight.lock
  - Only one preflight runs at a time across the project
  - If lock held: wait up to 60s, then fail with clear error
  - Release via lock.js at end in finally block, even on SIGKILL via
    stale-lock detection on next run (30-minute TTL; preflight never
    exceeds this)

Startup cleanup (always runs AFTER lock acquired):
  - If __sprintpilot_preflight branch exists from a prior crashed run:
      git checkout <base> 2>/dev/null
      git branch -D __sprintpilot_preflight 2>/dev/null
  - Refuse to run if current branch is __sprintpilot_preflight (paranoia)

For each pair:
  1. git checkout -B __sprintpilot_preflight origin/<base>
  2. git merge --no-commit --no-ff origin/<epic-branch-1>
  3. git merge --no-commit --no-ff origin/<epic-branch-2>
  4. If conflicts: record pair as CONFLICT, run `git merge --abort`
  5. Otherwise: run `git merge --abort` (discard the clean preflight merge)
  6. git checkout <base>; git branch -D __sprintpilot_preflight

Returns JSON: { safe_pairs: [["1","3"]], conflict_pairs: [["2","4"]] }

Cleanup is guaranteed via two layers:
  - try/finally for normal exit paths
  - lock.js stale-lock + startup cleanup for SIGKILL/crash paths
  Next preflight invocation detects and removes leftover state.
```

**Workflow.md cross-epic dispatch (high level):**

```xml
<check if="{{parallel_epics}} AND multiple epics marked independent: true">
  <action>Run preflight-merge.js for all independent epic pairs → {{safe_pairs}}</action>
  <action>For safe_pair in {{safe_pairs}}:</action>
  <action>  Invoke dispatch-layer.js at the epic level (each epic becomes a layer)</action>
  <action>  Merge cross-epic shards at pair completion</action>
</check>
```

**Tests:**

- Unit: `preflight-merge.js` detects known conflict fixture
- Unit: safety rail — missing `independent: true` → error
- E2E: 2-epic parallel run on clean fixture succeeds
- E2E: 2-epic parallel run with intentional conflict → falls back to sequential

**Acceptance criteria:**

- [ ] `parallel_epics: true` requires explicit `independent: true` declarations
- [ ] Pre-flight conflict detection prevents known-bad pairings
- [ ] Single conflict disables feature for remainder of session
- [ ] Warning logged on enable: "parallel_epics is experimental"
- [ ] `large.yaml` keeps `parallel_epics: false` by default

**Rollback.** `parallel_epics: false` (default). Feature becomes dormant; no execution path change.

---

## Cross-cutting concerns

### Testing strategy

- **Unit tests** — Vitest, mirror `tests/unit/autopilot-config.test.ts:31-48` tempdir fixture pattern. One new test file per new script (`resolve-profile`, `check-prereqs`, `log-timing`, `summarize-timings`, `state-shard`, `merge-shards`, `resolve-dag`, `with-retry`, `submodule-lock`, `dispatch-layer`, `preflight-merge`). Minimum coverage: happy path, one error case, one concurrency/race case per script.
- **E2E tests** — `tests/e2e/harness/` already drives real autopilot runs on fixture projects. Add:
  - `tests/e2e/nano-greenfield.test.ts` (PR 4) — 2-epic × 2-story tic-tac-toe, nano profile, verify quick-dev routing + PR-per-epic
  - `tests/e2e/medium-parallel.test.ts` (PR 11) — 1-epic × 3-story DAG, measure parallel vs sequential wall-clock (Claude Code only)
  - `tests/e2e/profile-rollback.test.ts` (PR 1) — install with nano, switch to legacy, verify byte-identical behavior to pre-v2 fixture
  - `tests/e2e/aider-smoke.test.ts` (PR 11) — install + single-story sequential run on Aider (open-source, scriptable). Proves the sequential-fallback path works on a non-Claude-Code host.
- **Regression guards** — every PR that changes workflow.md must keep existing e2e tests (`greenfield.test.ts`, `brownfield.test.ts`) passing unchanged. Any intentional behavioral change in those tests is a red flag.
- **Multi-host CI matrix.** Claude Code is the primary test host. Aider is the canary for non-Claude-Code hosts (open source, no UI, easy to run headless). CI runs both for any PR touching `workflow.md`, `agent-adapter.js`, or any profile YAML. Other 7 hosts stay manual-test territory until someone runs into a regression.
- **Aider CI model choice.** Aider runs with **Anthropic Sonnet** (`--model anthropic/claude-sonnet-4-6` or current stable ID) in CI. Rationale: Sonnet is Aider's most reliable editing model for complex multi-file edits and tracks Claude Code closely, so a Sonnet-backed Aider run is the closest proxy to Claude Code behavior we can get. Setup via `ANTHROPIC_API_KEY` as a repo-level CI secret.
- **CI budget.** Each Aider smoke run should consume < 100K total tokens (one fixture story, single epic). At current Sonnet pricing that's well under $1/run. CI caps runs: one per PR push. The `aider-smoke.test.ts` skips (`it.skipIf`) if `ANTHROPIC_API_KEY` is absent — a branch with the key missing logs "skipped — no API key" rather than failing, so external contributors don't get blocked by a missing secret.
- **CI gating policy (I14).**
  - **Claude Code tests**: must pass, always.
  - **Aider smoke test**: must pass when `ANTHROPIC_API_KEY` is available; skipped (not failed) when the secret is absent.
  - **Aider flakes**: if Aider fails on grounds unrelated to the PR (Aider version bump breaks something, model deprecation, etc.), the PR author files a tracking issue (`aider-ci-flake`), marks the test as `it.skip` with a reference to the issue, and ships. The test is un-skipped when the flake is fixed. This prevents Aider's own reliability from blocking Sprintpilot work while keeping the regression gate in place for legitimate failures.
- **Tool-agnostic correctness claim.** Sprintpilot's correctness doesn't depend on which host agent runs. Running against two real hosts (Claude Code for parallel, Aider for sequential) is the integration test. We do not mock host agents.

### Decision log during implementation

Each PR that makes a non-obvious implementation choice adds an entry to `docs/implementation-decisions.md` (create in PR 1). Format matches the autopilot's `decision-log.yaml` categories: `architecture`, `test-strategy`, `dependency`, `scope`, `workaround`.

Examples of decisions that should be logged:
- Why regex config patching instead of full YAML parse (PR 1 — preserves `{{var}}` placeholders)
- Why JSONL for timings instead of YAML (PR 2 — append-only without parse cycle)
- Why sharding is opt-in via `state_sharding: auto` (PR 3 — minimal disruption when parallelism is off)
- Why no autopilot-level cost cap (PR 11 — architectural; see concept §7.6)

### Backwards compatibility

Every PR must leave unchanged behavior for users who don't opt in:

| User type | Expected behavior after each PR |
|---|---|
| Existing install, no profile set | Treated as `medium` implicitly; behavior identical to pre-v4 |
| Existing install, legacy profile | Pinned to v0.9.0 snapshot; no v4 feature active |
| Fresh install, picks `medium` default | All v4 features respect conservative defaults (no parallelism, auto retros) |
| Explicit `--yes` in CI without `--profile` | Warns, defaults to `medium` |

Any PR that violates this requires a migration note in the PR description and a corresponding entry in `CHANGELOG.md`.

### Documentation updates per PR

Each PR updates:

- `docs/adaptive-process-scaling.md` — mark the section implemented, add a "Status: shipped in PR #N" note
- `CHANGELOG.md` — user-facing summary (feature, not internals)
- `docs/CONFIGURATION.md` — if the PR adds config keys
- `docs/USAGE.md` — if the PR changes user-visible flow (PRs 1, 4, 5, 11)
- `AGENTS.md` — if the PR changes the BMad flow contract (PRs 1, 4)

**Concept doc caveat (C8).** Before v2.1.0 ships (PRs 9–11), `docs/adaptive-process-scaling.md` §10 (time-reduction table) MUST be annotated: parallelism rows are marked "Claude Code only; other hosts run sequentially" in both the header and inline row notes. Same note goes into §7 (Parallelism design) where `parallel_stories: true` is described. Without this, non-Claude-Code users reasonably expect wall-clock reductions that won't materialize and perceive the promise as broken.

### v1 deprecation policy (M12)

v2.0.0 is a major version bump; users on `^1.x` semver stay pinned. The deprecation policy is:

| Version | Status | Support through |
|---|---|---|
| v1.0.x | maintenance | 2026-10-31 — security fixes + critical bug fixes only; no new features |
| v2.0.x | active | 18 months after v3.0.0 release |

Documented in `CHANGELOG.md` v2.0.0 entry and the GitHub repo README. Users on v1 who want v2 features migrate by running `npm i -g @ikunin/sprintpilot@latest` + `sprintpilot install --profile <name>`.

### Failure playbook

Each phase has a known-bad outcome and recovery path:

| Failure | Diagnosis | Recovery |
|---|---|---|
| Nano sprint produces broken code | Quick-dev doesn't handle this project class | Escalate to `small`; file issue with quick-dev spec |
| Parallel layer corrupts state | Shard merge edge case | Re-run `merge-shards.js --layer <id>` idempotently; if still broken, set `parallel_stories: false` and re-sprint from last good commit |
| Cross-epic merge conflict | Unexpected file dependency | Set `parallel_epics: false`, mark epics sequential in sidecar |
| Submodule init fails on fresh worktree | `--reference` incompatibility with git version | Automatic fallback to old command; manual: `worktree.enabled: false` for the session |
| gc.auto not restored after crash | Session ended abnormally | Manual: `git config --local --unset gc.auto` |

### Performance acceptance per PR

Where wall-clock reduction is the goal, each PR has a **compare-to-baseline** acceptance gate measured via `summarize-timings.js`. Baselines come from PR 2's M0 run on the same fixture project before the PR's changes land — no absolute targets, only relative ones.

| PR | Metric | Acceptance gate |
|---|---|---|
| 4 + 5 (nano) | Wall-clock on the nano fixture sprint | ≥ 70% reduction vs the M0 baseline measured on the same fixture with `medium` profile |
| 6 | State-write count per story (from log-timing `state.write` events) | ≥ 50% reduction vs M0 baseline |
| 7 | Boot time on clean repo (`bootstrap` phase duration) | ≥ 80% reduction vs M0 baseline |
| 10 | Submodule init per worktree (`worktree.submodule-init`) | ≥ 80% reduction vs M0 baseline on a repo with submodules |
| 11 | Wall-clock on a ≥2-wide parallel layer | ≥ 40% reduction vs the same layer run sequentially on Claude Code; n/a on non-parallel hosts |

**Baselines are project-specific and measured once at PR 2.** The user's anecdotal "4h for tic-tac-toe" is not an acceptance input — it's a motivational anecdote. Real targets come from M0 data on the chosen test fixture.

---

## Verification

### Per-PR verification (local)

```bash
# Unit tests for the affected scripts
npx vitest run tests/unit/<new-test-file>.test.ts

# Profile resolution smoke test (after PR 1)
node _Sprintpilot/scripts/resolve-profile.js print --profile nano
node _Sprintpilot/scripts/resolve-profile.js get autopilot.implementation_flow --profile nano  # expect "quick"

# Prereq check (after PR 1)
node _Sprintpilot/scripts/check-prereqs.js

# Timing smoke test (after PR 2) — dry-run
node _Sprintpilot/scripts/log-timing.js start --story "test-1" --phase "skill.test"
node _Sprintpilot/scripts/log-timing.js end   --story "test-1" --phase "skill.test"
cat _bmad-output/implementation-artifacts/.timings/test-1.jsonl

# Shard smoke test (after PR 3)
node _Sprintpilot/scripts/state-shard.js write --story "test-1" --field "status=review"
node _Sprintpilot/scripts/state-shard.js read --story "test-1"
node _Sprintpilot/scripts/merge-shards.js

# DAG resolver (after PR 9)
node _Sprintpilot/scripts/resolve-dag.js layers --epic 1
```

### End-to-end verification

After PR 5 (first full nano path shipped):

```bash
# On a fresh clone of a fixture tic-tac-toe PRD
sprintpilot install --profile nano --yes
# Run the autopilot through a BMad-aware host agent (Claude Code, Cursor, etc.)
# Verify: 4 PRs total (one per epic), no worktrees, no retrospectives, all tests pass
```

After PR 11 (parallel stories):

```bash
sprintpilot install --profile medium --parallel 2 --yes
# Author a dependencies.yaml declaring 2 stories in epic 1 as independent
# Run autopilot; verify layer 1 executes 2 sub-agents concurrently
node _Sprintpilot/scripts/summarize-timings.js --format md
# Compare wall-clock vs sequential baseline
```

### Release gating

A release ships only when:

1. All PRs in the phase pass their own tests
2. Existing `greenfield.test.ts` and `brownfield.test.ts` pass unchanged
3. One real E2E sprint completes on the author's machine (not just CI)
4. `CHANGELOG.md` entry is written
5. `docs/adaptive-process-scaling.md` sections are marked "shipped"

Recommended release cadence: ship PRs 1–8 as one release (foundation + nano + orchestration cuts), collect user feedback + measurement data, then ship PRs 9–12 as a second release (parallelism).

---

## Appendix A — Estimated v4 shipping footprint

**New files** (~17 scripts + ~14 tests + 5 profile YAMLs + 2 docs):

```
_Sprintpilot/modules/autopilot/profiles/_base.yaml       (DRY base, PR 1)
_Sprintpilot/modules/autopilot/profiles/nano.yaml
_Sprintpilot/modules/autopilot/profiles/small.yaml
_Sprintpilot/modules/autopilot/profiles/medium.yaml
_Sprintpilot/modules/autopilot/profiles/large.yaml
_Sprintpilot/modules/autopilot/profiles/legacy.yaml      (no _base extension)
_Sprintpilot/sprints/dependencies.yaml                   (template)
_Sprintpilot/scripts/resolve-profile.js
_Sprintpilot/scripts/check-prereqs.js
_Sprintpilot/scripts/log-timing.js
_Sprintpilot/scripts/summarize-timings.js
_Sprintpilot/scripts/state-shard.js
_Sprintpilot/scripts/merge-shards.js
_Sprintpilot/scripts/resolve-dag.js
_Sprintpilot/scripts/with-retry.js
_Sprintpilot/scripts/submodule-lock.js
_Sprintpilot/scripts/dispatch-layer.js
_Sprintpilot/scripts/agent-adapter.js
_Sprintpilot/scripts/preflight-merge.js
tests/unit/resolve-profile.test.ts
tests/unit/check-prereqs.test.ts
tests/unit/log-timing.test.ts
tests/unit/state-shard.test.ts
tests/unit/merge-shards.test.ts
tests/unit/resolve-dag.test.ts
tests/unit/with-retry.test.ts
tests/unit/submodule-lock.test.ts
tests/unit/dispatch-layer.test.ts
tests/unit/agent-adapter.test.ts
tests/unit/preflight-merge.test.ts
tests/e2e/nano-greenfield.test.ts
tests/e2e/medium-parallel.test.ts
tests/e2e/profile-rollback.test.ts
tests/e2e/aider-smoke.test.ts
tests/e2e/profile-legacy-v1-parity.test.ts
tests/e2e/fixtures/with-submodule/                        (PR 10)
tests/e2e/fixtures/with-submodule/setup.sh                (PR 10)
tests/unit/worktree-path-audit.test.ts                    (PR 10)
docs/implementation-decisions.md
```

**Modified files:**

```
_Sprintpilot/skills/sprint-autopilot-on/workflow.md   (substantial edits across 10 steps)
_Sprintpilot/skills/sprint-autopilot-on/SKILL.md      (brief profile note)
_Sprintpilot/skills/sprintpilot-update/*              (profile migration prompt)
_Sprintpilot/modules/autopilot/config.yaml            (add complexity_profile key)
_Sprintpilot/modules/git/config.yaml                  (add granularity, worktree knobs)
_Sprintpilot/modules/ma/config.yaml                   (parallelism knobs)
_Sprintpilot/scripts/sync-status.js                   (--granularity epic mode)
lib/core/tool-registry.js                             (add supports_parallel field per host)
bin/sprintpilot.js                                     (new CLI flags)
lib/commands/install.js                                (profile prompt, config writes)
AGENTS.md                                              (relax non-negotiable clause — policy layer only)
CLAUDE.md                                              (no change, inherits from AGENTS.md)
CHANGELOG.md                                           (per PR, v2.0.0 / v2.1.0 / v2.2.0 milestones)
docs/USAGE.md                                          (profile + parallelism sections)
docs/CONFIGURATION.md                                  (new config keys)
docs/adaptive-process-scaling.md                       (mark sections shipped)
package.json                                           (version bump to 2.0.0 at PR 1)
```

**Unchanged (important):**

- Any `bmad-*` skill file (off-limits)
- `lib/core/tool-registry.js` (9 agents already supported)
- `lib/prompts.js` (@clack/prompts primitives reused, not extended)
- `_Sprintpilot/scripts/lock.js` (reused via `--file` flag, no API change)

---

## Appendix B — Recommended first-week implementation order

For an engineer starting Monday:

- **Day 1–2:** PR 1 (foundation) — highest leverage, unblocks everything
- **Day 3:** PR 2 (M0 timings) — needed to validate subsequent PRs
- **Day 4–5:** PRs 7, 8 (M4 conditional boot, M5 cached reads) — lowest risk, small wins, practice modifying workflow.md safely
- **Week 2:** PR 3 (shards), PR 6 (coalesce) — build up sharding before parallelism needs it
- **Week 3:** PRs 4, 5 (nano) — validate the concept's headline win on tic-tac-toe baseline
- **Week 4:** PR 9 (DAG), PR 10 (worktree discipline) — parallelism prerequisites
- **Week 5–6:** PR 11 (parallel stories) — main medium+ win, needs careful testing
- **Later:** PR 12 (cross-epic experimental) — only after real medium+ runs of PR 11 prove out the sharding infrastructure

First shippable release: end of Week 3 (PRs 1–8) as **v2.0.0**. Second release: end of Week 6 (PRs 9–11) as **v2.1.0**. PR 12 ships as **v2.2.0** when the author is confident, not on a schedule.

---

## Appendix C — Changes applied after first adversarial review

First-pass plan (committed as `9c8f870`) had gaps surfaced by adversarial review. This revision addresses:

| ID | Fix applied in |
|---|---|
| C1 — tool-agnostic parallelism unvalidated | PR 11 AgentAdapter + Claude-Code-first scoping with sequential fallback on other hosts |
| C2 — `--reference` target is a worktree `.git` file | PR 10 recipe uses `git rev-parse --git-common-dir` |
| C3 — AGENTS.md doesn't gate autopilot behavior | PR 1 scope note + explicit PR 4 gate annotation |
| C4 — `resolve-dag.js --strategy llm` architecturally confused | PR 9 drops the `llm` strategy; future AI-inferred graphs go through a user-authored sidecar produced by a separate skill |
| C5 — existing installs never get `complexity_profile` | PR 1 resolve-profile.js defaults missing key to `medium` + logs migration notice |
| C6 — no upgrade migration path | PR 1 extends `sprintpilot-update` with a profile prompt |
| I1 — JSONL append atomicity | PR 2 documents single-writer-per-story model; 2KB entry cap |
| I2 — shard merge has no tiebreaker | PR 3 mandates `updated_at` in shard schema |
| I3 — partial-YAML crash recovery | PR 3 full state machine (archive corrupt shard, mark failed, halt layer, surface to user) |
| I4 — "critical state" undefined | PR 6 lists exact bypass keys |
| I5 — `gc.auto` scope wrong | PR 10 applies per-worktree at creation + main repo at bootstrap |
| I6 — PR 11 missing dep on PR 6 | Dependency table + PR 11 body updated |
| I7 — retry regex fragile | PR 10 broadened regex + logs unmatched failures |
| I8 — preflight branch leftover cleanup | PR 12 startup cleanup + try/finally |
| M1 — effort estimates too optimistic | PR 1: 2d → 3–4d; PR 3: 2d → 2–3d; PR 11: 4d → 5–8d; total 20d → 23–28d |
| M2 — absolute performance targets unsupported | Acceptance gates now compare-to-baseline, not absolute |
| M3 — summarize-timings only at sprint-complete | Also invoked at session checkpoint (step 9) |
| M4 — `docs/implementation-decisions.md` untracked | Added to PR 1 Files created |
| M5 — submodule lock inside `.git/` | Relocated to `.sprintpilot/submodule-locks/<slug>.lock` |
| M6 — only Claude Code E2E-tested | Added `aider-smoke.test.ts` + multi-host CI matrix |
| M7 — worktree `.git` path audit | Added as PR 10 acceptance task |
| M8 — version bump unspecified | v2.0.0 (PRs 1–8), v2.1.0 (PRs 9–11), v2.2.0 (PR 12) |
| M9 — no path-traversal validation | PRs 2, 3 add input-regex validation on `--story`/`--phase` args |

Appendix preserved as a change-log so reviewers of this plan can audit what changed between revisions.

---

## Appendix D — Changes applied after second adversarial review

Revision `a365aa8` had second-round findings. This revision addresses all of them.

| ID | Fix applied in |
|---|---|
| C7 — agent-adapter filesystem detection tautological | PR 11 rewrites detection priority: env vars (high confidence) → parent process (medium) → filesystem (low, never enables parallel). Install artifacts can't masquerade as running-host evidence |
| C8 — concept doc's time-reduction table misleading for non-CC hosts | Added explicit requirement: concept doc §10 and §7 annotated with "Claude Code only; other hosts run sequentially" before v2.1.0 ships |
| C9 — npm upgrade bypasses sprintpilot-update migration | Dropped the prompt-based migration entirely. Three paths documented: npm install (relies on missing-key default + postinstall banner), sprintpilot update skill (one-liner log), fresh install (prompt). No interactive prompt on upgrade — scripted CI upgrades preserved |
| I9 — legacy forward-compat guarantee undefined | PR 1 legacy spec now mandates no-new-files / no-new-schemas against v1.0.5; `tests/e2e/profile-legacy-v1-parity.test.ts` enforces |
| I10 — "iso8601-with-nanos" format impossible in Node | Shard schema splits into `{wall: iso8601-ms, monotonic: hrtime-ns}`; merge uses monotonic within process, wall + filename across processes |
| I11 — `lock holder` mis-listed in PR 6 coalesce exceptions | Removed from the list; note added that `.autopilot.lock` is lock.js-managed, outside autopilot-state.yaml |
| I12 — no submodule test fixture | PR 10 Files created now includes `tests/e2e/fixtures/with-submodule/` + setup script + worktree-path audit test |
| I13 — Aider API key provisioning unspecified | PR 11 spec: **Anthropic Sonnet** via `ANTHROPIC_API_KEY` CI secret, `it.skipIf` when absent, < 100K tokens / < $1 per CI run |
| I14 — multi-host CI gating policy missing | Explicit policy: Claude Code must pass, Aider must pass when key present (skipped when absent), unrelated Aider flakes tracked via issue + test-level `it.skip` |
| M10 — profile YAMLs duplicated | `profiles/_base.yaml` + deltas-only per profile. Legacy stands alone (no _base extension) to preserve forward-compat |
| M11 — dependencies.yaml has no discovery path | PR 9 adds `sprintpilot dependencies scaffold --epic <id>` subcommand; installer post-install message references it |
| M12 — v1 deprecation policy absent | Cross-cutting section adds policy: v1 maintenance through 2026-10-31 (security/critical only); v2.0.x active for 18mo after v3.0.0 |
| M13 — preflight branch race window | PR 12 preflight acquires `.sprintpilot/preflight.lock` via `lock.js` before startup cleanup; stale-lock cleanup on SIGKILL |
| M14 — resolve-profile merge: `settings:` wrapper ambiguous | Profile YAMLs drop the wrapper; all YAMLs share the flat `autopilot:` / `git:` / `ma:` shape. Merge logic simplifies |

**Net effect.** The plan now contains zero unresolved findings from either adversarial review pass. All concrete specs (host detection, shard schema, coalesce exceptions, preflight, profile YAMLs, CI policy) are implementable without interpretation gaps. The concept doc caveat for C8 is the only action item outside the plan file itself — it lands as part of PR 11.

