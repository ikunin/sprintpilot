# Usage Guide

## System Prompt Enforcement

After installation, every AI agent session starts with BMad Method awareness. The installer creates system prompt files that tell the agent:

- This project uses the BMad Method
- The 7-step story sequence is **mandatory** — no skipping steps
- Git safety rules are enforced (no `git add -A`, no secrets)
- Available skills and how to get started

This means you don't need to tell the agent about BMad Method — it already knows. If you ask the agent to "implement feature X", it will follow the BMad Method story sequence automatically.

### How it works per tool

**Claude Code** uses a two-file pattern:
- `CLAUDE.md` contains a single line: `@AGENTS.md` (an include directive)
- `AGENTS.md` contains the BMad Method enforcement rules (the 7-step sequence, git rules, skill reference)

**Cursor, Roo, Kiro, Trae** get a dedicated `bmad.md` file in their rules directory (e.g., `.cursor/rules/bmad.md`).

**Windsurf, Cline, Gemini CLI, GitHub Copilot** get the enforcement block appended to their shared system prompt file with markers for safe update/removal.

All tools reference `_Sprintpilot/Sprintpilot.md` for the full skill catalog. The enforcement rules are in `_Sprintpilot/templates/agent-rules.md`.

---

## Complexity Profiles (v2)

The per-story flow depends on the active `complexity_profile` in `_Sprintpilot/modules/autopilot/config.yaml`. It is set at install time (interactive prompt or `--profile` flag) and can be edited any time.

| Profile | Per-story flow | Branching | Worktrees | Parallel stories | Notes |
|---------|---------------|-----------|-----------|------------------|-------|
| `nano` | `bmad-quick-dev` (one-shot) | `epic` (one PR per epic) | off | n/a | Quick-dev's internal review preserves quality gates. Auto-escalates to `full` if tests fail or classify severity is high (session-scoped only). |
| `small` | Full 7-step BMad cycle | `story` | on | off | Default for single-developer projects. |
| `medium` *(default)* | Full 7-step BMad cycle | `story` | on | off | Balanced for most sprints. Missing-key fallback. |
| `large` | Full 7-step BMad cycle | `story` | on | **on** | Phase timings, state sharding, parallel dispatch all enabled. |
| `legacy` | Pinned to v1.0.5 byte-for-byte | `story` | on | off | Zero behavior change vs. v1.0.5 — every v2 layer is forced off. |

The autopilot resolves the profile at boot via `_Sprintpilot/scripts/resolve-profile.js`. Missing key falls back to `medium` with a stderr notice.

### Parallel Story Dispatch

When `ma.parallel_stories: true` AND the host supports concurrent subagents (Claude Code today; Gemini CLI experimentally) AND the active layer of the inferred DAG has ≥2 independent stories, step 3 of the autopilot:

1. Runs `resolve-dag.js layers --epic <id>` to get layered story groups.
2. Picks the first layer with non-done stories as the active layer.
3. If `active_layer.length >= 2`: runs `dispatch-layer.js` to pre-create worktrees + write `.layer-plan.json`, spawns N concurrent Agent tool calls in a single message (one per story), and on return runs `merge-shards.js --archive` to collapse per-story state shards.
4. Loops back to step 2 to re-evaluate the next layer.

Single-story layers continue sequentially (no benefit from parallelism). Cross-epic parallelism (`ma.parallel_epics: true`) is experimental and gated behind a per-pair merge-conflict preflight — off on every profile by default.

## Git-Enhanced Autopilot

### How the orchestrator drives execution

Flow control is owned by `_Sprintpilot/bin/autopilot.js` — a deterministic Node.js state machine that enforces the BMad 7-step sequence. Each turn:

1. The skill body calls `node _Sprintpilot/bin/autopilot.js next` → JSON Action.
2. The LLM executes the Action (`invoke_skill` / `run_script` / `git_op` / `parallel_batch` / `user_prompt` / `halt`) — for `git_op`, it runs the pre-planned argv steps verbatim, no shell interpolation.
3. The LLM signals the outcome via `autopilot record --signal <json>` (`success` / `failure` / `blocked` / `propose_alternative` / `user_input` / `verify_override`).
4. `verify.js` enforces BMad bookkeeping (acceptance-criteria bullets exist, task boxes flipped to `[x]`, `commit_sha` + `branch` reported, `git_steps_completed: true` after every `git push`). A failed verify produces a `verify_rejected` ledger entry and the orchestrator re-emits the same action with the issues threaded into the template slot — up to the per-profile reject budget, then it pauses for the user.

The LLM keeps in-skill execution, diagnosis, triage, and small-judgment decisions. The state machine owns sequencing.

### Starting the Autopilot

In the coding agent of your choice, invoke:

```
/sprint-autopilot-on
```

The autopilot will:
1. Acquire a lock (prevents concurrent sessions)
2. Detect your git platform (GitHub/GitLab/Bitbucket/Gitea/git_only)
3. Check for orphaned worktrees from previous sessions
4. Fingerprint the project and resume from saved state, or assess fresh
5. Execute stories with automatic git operations

### What Happens During a Story

For each story (full 7-step flow; nano profile takes the `bmad-quick-dev` one-shot path):

1. **Creates a worktree** via `git worktree add` — isolates the story's code changes on `<branch_prefix><story-key>`.
2. **Runs `bmad-create-story`**, then **`bmad-check-implementation-readiness`** to ensure no blockers.
3. **Runs `bmad-dev-story` (RED → GREEN)** in the worktree — writes failing tests first, then implementation until tests pass.
4. **Lints** changed files (language-aware, errors-first output).
5. **Runs `bmad-code-review`** — three parallel reviewers (Blind Hunter, Edge Case Hunter, Acceptance Auditor). Findings are classified as `block` (halt), `patch` (auto-apply), or `defer`.
6. **PATCH_APPLY → PATCH_RETEST** — each `patch` finding is applied and committed separately; tests re-run after patches.
7. **Stages and commits** with a conventional message (`feat({epic}): {title} ({story-key})`). Staging is explicit (never `git add -A`) with secrets / size / binary pre-commit checks.
8. **Pushes** the branch and (if `create_pr: true`) creates a PR/MR.
9. **Syncs `_bmad-output/` to the base branch** so BMad planning artifacts land on `main` regardless of merge strategy.
10. **Optionally lands the PR** when `merge_strategy: land_as_you_go` (gated by `land_when` / `land_wait_minutes`).
11. **Exits the worktree** and moves on; at epic completion, runs the retrospective and lists all PRs ready to merge.

Decision audit: small judgment calls (architecture, test-strategy, dependency, review-triage, scope, workaround) attach as `decisions[]` on any signal and are appended to `decision-log.yaml` with id + timestamp + story stamped automatically.

### Git Workflow Knobs

These live in `_Sprintpilot/modules/git/config.yaml` and change what the orchestrator emits as `git_op` actions:

| Knob | Values | Behavior |
|---|---|---|
| `granularity` | `story` (default) / `epic` | Per-unit branch creation. Suppressed when `reuse_user_branch=true`. Nano profile defaults to `epic`. |
| `reuse_user_branch` | `false` (default) / `true` | If `true`, autopilot detects the current non-base branch on boot and commits **every** story onto it. No `story/*` or `epic/*` branches are created. One PR opens at sprint-end. |
| `merge_strategy` | `stacked` (default) / `land_as_you_go` | `stacked` keeps every story branch open until sprint-end. `land_as_you_go` runs `STORY_LAND` right after `STORY_DONE` to merge the PR immediately. |
| `land_when` | `no_wait` / `ci_pass` (default) / `ci_and_review` | Under `land_as_you_go`: merge synchronously, after CI is green, or after CI + an approved review. |
| `land_wait_minutes` | int (default `30`) | Max wait for CI / review under `land_as_you_go`. After this the orchestrator halts and prompts. |
| `branch_prefix` | string (default `story/`) | Prefix for autopilot-created branches (e.g., `story/1-3-add-auth`, `story/epic-1`). |
| `push.create_pr` | `true` (default) / `false` | `false` merges directly to `base_branch` after push, no PR opened. |

On `STORY_LAND` rebase conflicts (base moved during the story), the orchestrator auto-rebases the story branch onto the latest base. If the rebase has conflicts, the orchestrator halts with a `user_prompt`; resume reads `state.land_pending` and retries the land step.

### Stopping the Autopilot

```
/sprint-autopilot-off
```

This produces a status report with git information and releases the lock.

### Updating the Add-On

Check for updates and install them from within your coding agent:

```
/sprintpilot-update
```

This compares your installed version against npm, shows what's new, and asks for confirmation before updating. You can also check from the terminal: `npx @ikunin/sprintpilot@latest check-update`.

### Session Management

The autopilot checkpoints after every 3 stories (configurable via `autopilot.session_story_limit`; nano profile: 5; `0` = unlimited). The orchestrator persists state to `_bmad-output/implementation-artifacts/autopilot-state.yaml` and an append-only `ledger.jsonl` (action history) so resume is exact:

```
/sprint-autopilot-on    # resumes exactly where it left off
```

State tracks the current story + BMad step, the active state-machine node, the ledger fingerprint, the patch_findings queue (between PATCH_APPLY and PATCH_RETEST), `land_pending` state (for `land_as_you_go`), and the per-story branch HEADs at the last halt.

On the next `autopilot start`, the orchestrator fingerprints `_bmad-output/`, sprint-status.yaml, and per-story branch HEADs against the fingerprint recorded at the last halt. Any divergence is surfaced as a `resume_divergence` action so you can resolve it (`force_continue` or `override_decision` via `user_input`) before the next state-machine transition.

State + ledger are deleted automatically when the sprint completes.

#### Fresh-context finalize (mandatory)

When the last story is done, the orchestrator **does not** run sprint cleanup in the same session. Instead the state machine transitions to `sprint_finalize_pending` (a terminal halt state), writes the marker, releases the lock, and asks you to run `/sprint-autopilot-on` one more time. That fresh session reads the pending marker, jumps straight to the finalize state, and runs the deterministic cleanup script calls (mark-done-stories task checkboxes, worktree removal, artifact commits, final report) with a clean context window.

This trades one short extra session (~60-100 turns, usually under $2) for reliable end-of-sprint hygiene — without it, the tail of a long session regularly drops the CRITICAL cleanup actions. The test harness handles this automatically; you only notice it as an extra "All stories are done, pausing for finalization" checkpoint report.

### Dependency Inference

After `bmad-sprint-planning` completes, the autopilot infers inter-story dependencies via one LLM call per epic and writes the result to `_Sprintpilot/sprints/dependencies.yaml`. This unlocks parallel story dispatch (`parallel_stories: true`) without requiring you to hand-author the sidecar.

The generated file starts with:

```yaml
# AUTO-INFERRED — regenerate via infer-dependencies.js
# DO NOT hand-edit `stories:` directly — it is regenerated on the next
# planning cycle. To pin a relationship, add to `overrides:` instead.
# Hash: <12-char content hash>
```

Each story entry includes a `rationale` field — a single sentence the LLM produced citing the AC, file path, or architecture line that justifies the edge. **Review these before parallel dispatch begins** — over-serialization (LLM emits a spurious dep) silently slows the sprint without breaking anything; the rationale is your safety net.

**Opting out:**
- Per-profile: set `autopilot.auto_infer_dependencies: false` in `_Sprintpilot/modules/autopilot/config.yaml` (default `true` on small/medium/large; `false` on nano and legacy).
- Per-sprint: hand-author `_Sprintpilot/sprints/dependencies.yaml` before `bmad-sprint-planning` runs. The autopilot detects the missing `# AUTO-INFERRED` marker and respects your file (one-line skip notice in the log).

**Pinning relationships the LLM gets wrong:**
Edit the `overrides:` block — `force_independent: [keys]` to drop inbound edges; `force_sequential: [keys]` to chain. The auto-regeneration only touches the `stories:` block; `overrides:` and `epics:` are preserved verbatim across cycles.

**Failure modes:**
If the LLM emits invalid JSON or the script rejects it (cycle, unknown key, cross-epic edge), the error envelope is logged and the autopilot continues. `resolve-dag.js` falls back to its safe linear `ordering` strategy on the next dispatch — parallelism is disabled for that sprint, but nothing breaks.

### Submodules

If your project uses git submodules (`.gitmodules` present), the autopilot automatically initializes them when creating worktrees. Initialization times out after 30 seconds (configurable via `worktree.submodule_timeout` in config). If timeout occurs (e.g., auth required), the autopilot warns and continues without submodules.

### Crash Recovery

If a session crashes, the next `/sprint-autopilot-on` will:

1. **Remove stale locks** — locks older than 30 minutes are auto-removed
2. **Health check worktrees** — scans `.worktrees/` for orphaned directories
3. **Classify each worktree**:
   - **COMMITTED** — branch has commits beyond main. Pushed and PR created automatically.
   - **CLEAN_DONE** — story is marked done, worktree is clean. Removed.
   - **STALE** — no commits beyond main. Work was lost. Removed.
   - **DIRTY** — uncommitted changes. You are prompted: stash, commit, or discard.
   - **ORPHAN** — worktree exists but branch was deleted. Removed.
4. **Resume** — reads `autopilot-state.yaml` and continues from the saved step

---

## Multi-Agent Skills

### Parallel Code Review

```
/sprintpilot-code-review
```

Launches 3 review agents simultaneously:
- **Blind Hunter** — adversarial review from diff only (no project context)
- **Edge Case Hunter** — boundary conditions with full project access
- **Acceptance Auditor** — verifies acceptance criteria are met

Results are triaged into PATCH (apply), WARN (note), DISMISS (false positive), or DECISION_NEEDED (contradictory findings).

### Codebase Analysis (Brownfield)

```
/sprintpilot-codebase-map
```

Launches 5 analysis agents in parallel:
- **Stack Analyzer** — languages, frameworks, versions, build tools
- **Architecture Mapper** — modules, patterns, entry points, data flow
- **Quality Assessor** — tests, CI/CD, conventions, code metrics
- **Concerns Hunter** — TODOs, deprecated APIs, security issues, dead code
- **Integration Mapper** — external APIs, databases, env vars, cloud services

Outputs to `_bmad-output/codebase-analysis/`.

### Tech Debt Assessment

```
/sprintpilot-assess
```

Runs after `sprintpilot-codebase-map`. Launches 3 agents:
- **Dependency Auditor** — CVEs, outdated packages, deprecations
- **Debt Classifier** — categorizes and prioritizes tech debt
- **Migration Analyzer** — framework upgrade paths and effort

Produces `brownfield-assessment.md` with prioritized action items.

### Reverse Architecture

```
/sprintpilot-reverse-architect
```

Extracts architecture from existing code. Launches 3 agents:
- **Component Mapper** — module boundaries, public APIs, dependency graph
- **Data Flow Tracer** — request lifecycle, state management, async flows
- **Pattern Extractor** — design patterns, conventions, error handling

Produces BMad Method-compatible `architecture.md` that feeds into `bmad-create-epics-and-stories`.

### Migration Planning

```
/sprintpilot-migrate
```

12-step migration workflow for moving from current stack to a target stack. Requires:
- Target stack specification (from user)
- Codebase analysis outputs (from `sprintpilot-codebase-map`)

Launches 4 agents across steps:
- **Stack Mapper** + **Dependency Analyzer** (step 3, parallel)
- **Test Parity Analyzer** (step 9)
- **Risk Assessor** (step 10)

Produces `migration-plan.md`, `migration-epics.md` (BMad Method-compatible), and `migration-tracking.yaml`.

### Parallel Research

```
/sprintpilot-research
```

Provide a list of research topics with types (technical/domain/market). Each topic gets its own agent with `WebSearch`/`WebFetch` access. Results are collected and synthesized.

### Party Mode (Parallel)

```
/sprintpilot-party-mode
```

Select 2-3 BMad Method personas (architect, PM, QA, dev, etc.) and a topic. Each persona runs as a parallel agent. Supports multiple discussion rounds where personas respond to each other.

---

## Recommended Workflows

### Greenfield Project

```
bmad-product-brief → bmad-create-prd → bmad-create-architecture
    → bmad-create-epics-and-stories → /sprint-autopilot-on
```

### Brownfield Project

```
/sprintpilot-codebase-map → /sprintpilot-assess → /sprintpilot-reverse-architect
    → bmad-create-prd (informed by analysis)
    → bmad-create-epics-and-stories → /sprint-autopilot-on
```

### Migration Project

```
/sprintpilot-codebase-map → /sprintpilot-assess → /sprintpilot-migrate
    → bmad-sprint-planning (from migration epics)
    → /sprint-autopilot-on
```

---

## Handoff report

The handoff report is emitted whenever the autopilot halts at a session boundary. It's generated by `_Sprintpilot/lib/orchestrator/report.js` from the persisted state and the append-only `ledger.jsonl`. Re-print on demand:

```bash
node _Sprintpilot/bin/autopilot.js report
```

The report is a single markdown block with five sections:

```markdown
# Autopilot Session Report

**Current story:** 1-3-add-auth
**Current phase:** PATCH_RETEST
**Sprint complete:** false
**Last updated:** 2026-05-15T10:42:18.041Z

## Ledger summary
- action_emitted: 47
- signal_recorded: 47
- decisions_appended: 12
- halt: 1

## Last 10 actions
- [2026-05-15T10:41:50Z] DEV_GREEN → invoke_skill bmad-dev-story
- [2026-05-15T10:42:01Z] CODE_REVIEW → invoke_skill bmad-code-review
- [2026-05-15T10:42:14Z] PATCH_APPLY → run_script post-green-gates.js
- …

## Recent decisions (3)
- [2026-05-15T10:38Z] story=1-3-add-auth phase=dev-story:RED ids=d-117,d-118
- [2026-05-15T10:40Z] story=1-3-add-auth phase=code-review ids=d-119
- …

## Recent halts
- [2026-05-15T10:42:18Z] phase=PATCH_RETEST reason=session_story_limit

## Next action

Run `autopilot next` to emit the action for phase=PATCH_RETEST on profile=medium.
```

Section purpose:

- **Header** — current story, phase, sprint-complete flag, last write timestamp. Quick "where are we?" snapshot.
- **Ledger summary** — counts of every kind of event in `ledger.jsonl`. Spikes in `halt` or `failure` indicate trouble.
- **Last 10 actions** — the most recent `invoke_skill` / `run_script` / `git_op` actions with their phase.
- **Recent decisions** — small judgment calls the LLM attached as `decisions[]` (architecture / test-strategy / dependency / review-triage / scope / workaround).
- **Recent halts** — the last 3 reasons the autopilot stopped. Empty on a healthy session.
- **Next action** — explicit hint of what running `/sprint-autopilot-on` (or `autopilot next`) will do next, including the `sprint_finalize_pending` special case.

---

## User commands

The orchestrator scans the host chat for user interjections every turn. The LLM translates phrasing into structured `user_input` commands validated by `user-commands.js`:

| Command | What it does |
|---|---|
| `skip_story` | Drop the current story; transition to next-story-start. The CLI is responsible for marking sprint-status; this command records the intent. |
| `abort_sprint` | Mark sprint complete and halt with `sprint_complete`. Use to end a sprint early. |
| `force_continue` | Accept a `resume_divergence` or `verify_rejected` finding and proceed. Resets retry / verify counters; keeps phase. |
| `override_decision` | Reject the orchestrator's last decision with a reason. Entry appended to `decision-log.yaml`. |
| `change_profile` | Switch active complexity profile mid-session (re-seeds retry budgets). |
| `pause` | Halt this session cleanly; next `/sprint-autopilot-on` resumes. |
| `accept_alternative` | Dispatch the orchestrator's pending `propose_alternative` (cleared after use). |
| `trigger_retrospective` | Force-route to RETROSPECTIVE for the current epic regardless of `remaining_stories_in_epic`. Use when explicitly closing out an epic with non-terminal stories. |

Phrase the intent naturally — the LLM maps your message to the right command. Malformed commands are rejected with a clear error, never silently dropped.

---

## Crash recovery

If a session crashes — process killed, machine rebooted, hook failed mid-commit — the next `/sprint-autopilot-on` runs a health check on `.worktrees/` *before* any new state-machine work. Each worktree is classified and handled deterministically:

| Classification | Condition | Action |
|---|---|---|
| `COMMITTED` | Branch has commits beyond `base_branch` | Worktree reactivated; committed-but-unpushed work is pushed + PR'd |
| `CLEAN_DONE` | Story marked `done` in sprint-status, worktree clean | Worktree removed |
| `STALE` | No commits beyond base; story not done | Work was lost; worktree removed |
| `DIRTY` | Uncommitted changes | User prompted: stash, commit, or discard |
| `ORPHAN` | Worktree directory exists but branch was deleted | Worktree removed |

Stale `.autopilot.lock` files (older than `git.lock.stale_timeout_minutes`, default 30) are auto-taken-over at this stage, so a crashed session never blocks the next one indefinitely.

---

## Troubleshooting

### `resume_divergence` halts on every start

Sprint-status, `_bmad-output/`, or branch HEADs moved between sessions.

- If `current_story` is now `done` in sprint-status → auto-acknowledged, proceeds automatically.
- Otherwise → pass `--accept-divergence` on the next start, OR finish externally-merged stories first so sprint-status reflects reality.

The audit trail (`kind: resume, divergence: {…}`) records every bypass.

### `verify_rejected` on `dev_red`: "no test_files reported"

The LLM signaled success but the verifier couldn't find test-shaped files in `git diff` + untracked files.

- Check `git status` — did the LLM actually write a test?
- Test-shape recognition: `*.test.{js,ts,jsx,tsx,mjs,cjs}`, `*.spec.*`, `test_*.py`, `*_test.py`, `*_test.go`, `tests/*.rs`, `*Tests.swift`, `*Test.kt`/`Test.java`, `*_test.rb`, `*_spec.rb`.
- If the language convention differs, re-run `bmad-dev-story` with `test_files: [...]` explicitly echoed in the signal output.

### `verify_rejected` on `dev_red`: "test file missing: \<path\>"

The LLM reported a path that doesn't exist on disk. Relative paths resolve against `projectRoot` (the autopilot's `--project-root`, not `process.cwd()`).

- Run `ls <path>` from the project root to confirm.
- If the LLM wrote the file under a different directory than reported, re-run.

### `verify_rejected` on `story_done`: "git_steps_completed must be true"

The LLM didn't set the canonical flag AND the underlying git state probe didn't confirm.

- The probe: `git cat-file -e <commit_sha>` + `git ls-remote --heads origin <branch>`. Both must succeed and the remote sha must match.
- Most common cause: `git push` failed or wasn't run. Push the branch manually and re-record.

### Epic won't close out with retrospective

`remaining_stories_in_epic > 0`. Two options:

1. **Mark deferred stories with a terminal status** in sprint-status:
   ```yaml
   development_status:
     4-7-deferred-feature: deferred
     4-8-stretch: skipped
   ```
   Accepted terminal values: `done`, `skipped`, `wont_do`, `won't_do`, `cancelled`, `canceled`, `deferred`, `abandoned`.

2. **Emit `trigger_retrospective`** as a `user_input` command — force-routes to RETROSPECTIVE for the current epic regardless of remaining count.

### `.autopilot.lock` held but no session is running

The previous session crashed before releasing the lock.

- Wait `git.lock.stale_timeout_minutes` (default 30) and the next `autopilot start` auto-takes-over.
- To skip the wait: `rm .autopilot.lock`.

### LLM keeps inventing pause justifications

Pattern: `details: "User-initiated checkpoint to control session length / context"` or similar narrative-tone pauses you didn't issue.

- The `workflow.orchestrator.md` contract forbids LLM-initiated pause. Heuristics like "natural breakpoint", "context budget", "merge cadence", "PR opened, time for review" are explicitly invalid pause reasons.
- If the pattern persists: run `/sprintpilot-update` to pick up the latest contract docs. Verify `_Sprintpilot/skills/sprint-autopilot-on/SKILL.md` is current.
- Audit trail: every pause is logged in `ledger.jsonl` with the LLM-supplied `details` string — compare against your actual chat input.

### `mid_sprint_queue_overwrite` error on `autopilot start`

A sprint is in progress (`current_story` set or `story_queue` non-empty) and you tried to start a different one without `--force`.

- Confirm you want to discard the current story: add `--force` to the start invocation.
- Or finish / pause the current story first.

### Worktree health check halts at boot

Orphan worktrees from a crashed session are flagged. The `--worktrees-dir .worktrees` output lists them.

- Inspect each: `ls .worktrees/<name>`.
- If safe to remove: `git worktree prune` then `rm -rf .worktrees/<name>` per orphan.
- The autopilot's `worktree.cleanup_on_merge` (default `true`) prevents this accumulating during normal runs — the failure mode is crashed sessions before merge.
