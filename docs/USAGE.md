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

### Tiered, Change-Aware Test Scope (v2.3.18+)

By default, every test-running phase (`DEV_RED`, `DEV_GREEN`, `PATCH_APPLY`, `PATCH_RETEST`, `NANO_QUICK_DEV`) runs an **affected subset** rather than the full suite. The orchestrator computes the recommended command per emission using a framework adapter and threads it into the dev-story template — the LLM runs that command instead of `npm test`/`pytest`. CI remains the full-suite safety net (it already gates `STORY_LAND` under `merge_strategy: land_as_you_go`).

Per-phase command: derived from `git diff` against `base_branch` plus the story's authored test files.

| Adapter | Detection | Affected command shape |
|---|---|---|
| Vitest | `vitest.config.*` or `vitest` in deps | `npx vitest run --changed origin/<base> <new-test-files>` |
| Jest | `jest.config.*` or `jest` in deps / package.json | `npx jest --findRelatedTests <changed-files> <new-test-files>` |
| pytest | `pytest.ini` / `conftest.py` / `[tool.pytest]` | `pytest --testmon` (if `.testmondata` exists) or `pytest <dir-mapped tests>` |
| Generic | always last; matches everything | User's `testing.commands.affected` override, or signal "no recommendation" → resolver falls back to `full` |

**Widening for structural changes.** When the LLM realizes a story touches code that ripples through unrelated tests (shared util refactor, dep bump, schema migration, renamed exported symbol), it can echo `test_scope_hint: { scope: 'full' }` or `test_scope_hint: { include_dirs: [...] }` in its success signal. The hint widens the scope for the next phase in the same story and clears at the story boundary.

**Manual override.** `autopilot next --test-scope full` forces full regression for one emission without editing config — useful when you suspect the affected detection might miss something on a known-risky story.

**Audit.** Every emission writes a `test_scope_decision` ledger entry: adapter, command, reason, fallback flag, file counts.

Full configuration reference: see [Tiered Testing Configuration](CONFIGURATION.md#tiered-testing-configuration-modulestestingconfigyaml).

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

**v2.3.0:** dependency inference moved into the opt-in `/sprintpilot-plan-sprint` workflow. The default `autopilot start` no longer infers anything — it runs stories in sprint-status order. To get LLM-inferred dependencies + a curated execution plan, either:

1. Run `/sprintpilot-plan-sprint` manually any time after `bmad-sprint-planning`, or
2. Set `autopilot.auto_plan_on_start: true` so missing-plan triggers the skill automatically on next `autopilot start`.

See the **Sprint Planning + DAG-Aware Execution (v2.3.0)** section below for the full walkthrough.

**Legacy v2.0–v2.2.x behavior:** the autopilot ran an automatic LLM inference pass after `bmad-sprint-planning` and wrote `_Sprintpilot/sprints/dependencies.yaml`. That file is auto-migrated on first v2.3.0 `autopilot start` (see migration notes below) and the auto-inference behavior has been retired. The new flow gives the same DAG awareness *plus* curation, mid-flight reordering, cross-epic edges, issue-tracker links, and a visual mermaid render — but only when you opt in.

**Pinning relationships:** edit the `overrides:` block in `sprint-plan.yaml` — `force_independent: [keys]` drops inbound edges; `force_sequential: [keys]` chains. The skill's regeneration only touches `dependencies.stories.*` and `cross_epic_deps`; `overrides:` is preserved verbatim.

**Failure modes:** if the LLM emits invalid JSON or the script rejects it, `infer-dependencies.js dry-run` returns the errors and the skill iterates (max 3 retries per epic). On 3 consecutive failures, the skill saves `sprint-plan.yaml.partial` + a `.sprint-plan-validation-failed` sentinel and halts so you can inspect.

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

---

## Sprint Planning + DAG-Aware Execution (v2.3.0)

### Default behavior (no plan, no setup)

`autopilot start` runs stories in **sprint-status.yaml order** — exactly as it has since v1.0.5. No `sprint-plan.yaml`, no LLM-driven inference, no skill invocations. Greenfield projects upgrading from v2.2.x see zero behavior change.

### When to opt in to sprint planning

Sprint planning becomes useful when:

- You want **dependency-aware ordering** so `1-3-add-auth` runs after its dependencies (`1-1-bootstrap`, `1-2-models`) rather than alphabetical sprint-status order.
- You want **cross-epic dependencies** honored (epic-2 stories that depend on something in epic-1).
- You want to **curate a subset** of sprint-status stories into the active sprint while keeping the others for context.
- You want **external issue tracker links** (Jira / Linear / GitHub / GitLab IDs persisted per story).
- You want **mid-flight reordering** with DAG validation against your dependency graph.

### Invoking the planner

```
/sprintpilot-plan-sprint
```

The skill reads `epics.md`, `architecture.md`, and `sprint-status.yaml`, infers per-epic + cross-epic dependencies via piped LLM envelopes (validated server-side by `infer-dependencies.js`), presents the DAG, lets you curate which stories belong in the active plan, and writes `_bmad-output/implementation-artifacts/sprint-plan.yaml`. See `_Sprintpilot/skills/sprintpilot-plan-sprint/workflow.md` for the 14-step flow.

### Selecting what goes into the next sprint

The planning skill's curation step (Step 11) controls which stories the autopilot actually runs vs. which are kept around for context only. The interactive prompt looks like this:

```
Which stories do you want to run in this sprint?
Default: ALL non-done stories.
  [Enter]  accept default
  [e]      edit selection (toggle individual stories by number)
  [a:KEY]  add a specific story
  [r:KEY]  remove a specific story
```

**What "included" vs "excluded" means:**

| Selection | `plan_status` | Picked by queue? | Visible in plan? |
|---|---|---|---|
| Included (default) | `pending` | Yes — runs in priority order | Yes |
| Excluded via `[r:KEY]` | `excluded` | No | Yes (kept for context — e.g., as upstream of an included story already done in sprint-status) |
| Not selected during `[e]` toggle | `excluded` | No | Yes (same as above) |
| Added via `[a:KEY]` | `pending` | Yes | Yes |

Excluded stories aren't deleted — they remain in `sprint-plan.yaml` so the DAG can still reason about their relationships. They just don't enter the execution queue. This matters when an excluded story is upstream of an included one: the validator (Step 12) flags this and asks you to either add the upstream or accept the downstream blocking.

**Three common curation patterns:**

```
# 1. Accept everything (full sprint of all non-done stories)
[Enter]

# 2. Focused mini-sprint (only the auth epic this week)
[e]
> deselect: 2-1, 2-2, 3-1, 4-1
> [Enter] to confirm

# 3. Cherry-pick specific stories
[a:1-3-add-auth]
[a:2-1-foo]
[Enter]
```

**Natural-language entry:**

You can also tell the LLM session what you want directly — it translates into the structured selection:

> "Only include the bootstrap and auth stories for this sprint."
> → planner deselects everything else; presents the result; you confirm.

> "Skip story 2-3-payments for now."
> → planner adds `2-3-payments` to the excluded set.

> "Add 4-1-admin-panel to the next sprint."
> → planner adds it as `plan_status: pending`.

**Validation pass (Step 12):**

Before writing the plan, the skill checks every selected story's transitive upstreams. If a story is included but one of its upstreams is excluded AND not done in sprint-status, you'll see:

> "Story `1-3-add-auth` (included) depends on `1-1-bootstrap` which is not in the plan and not done. Options:
>   [a] add `1-1-bootstrap` to the plan
>   [r] remove `1-3-add-auth` from the plan
>   [x] exclude `1-3-add-auth` (keeps it visible but won't run)"

This loop continues until the selection is DAG-consistent — the autopilot will never start a story whose upstream isn't satisfied.

**Mid-flight curation (after the plan exists):**

Once `sprint-plan.yaml` is written, you don't need to re-run the full skill to adjust the sprint. Use the `user_input` commands during an autopilot session:

| Want to... | Use |
|---|---|
| Add stories to the active plan | `add_to_sprint { story_keys: [...], position?, issue_ids? }` |
| Remove stories (mark skipped/deferred) | `remove_from_sprint { story_keys: [...], mark_status? }` |
| Reorder execution priority | `reorder_queue { order: [...] }` (DAG-validated) |
| Rebuild the plan from scratch | `replan_sprint { reason? }` |

The LLM session translates natural-language directives ("add the payments story", "skip 2-3 for now", "do auth before models") into these structured commands.

### Auto-derive triggers (opt-in)

After your first manual `/sprintpilot-plan-sprint`, subsequent `autopilot start` calls auto-detect plan staleness and re-run the planner when:

- A story was **added** to `sprint-status.yaml` that's not in the plan (`reason: stale_added_stories`).
- A story was **removed** from `sprint-status.yaml` but still appears in the plan (`reason: stale_removed_stories`).

To opt into auto-derive on greenfield projects (no plan yet), set in `_Sprintpilot/modules/autopilot/config.yaml`:

```yaml
autopilot:
  auto_plan_on_start: true
```

Default is `false` — greenfield projects fall back to sprint-status order.

To skip auto-derive for a single run: `autopilot start --no-auto-plan`.

### Migration from pre-v2.3.0 (`_Sprintpilot/sprints/dependencies.yaml`)

If your project has a legacy `_Sprintpilot/sprints/dependencies.yaml` sidecar (from v2.0.2–v2.2.x's `auto_infer_dependencies` flow), the autopilot auto-migrates it on the first `autopilot start` of v2.3.0:

- `_Sprintpilot/sprints/dependencies.yaml` → archived to `.archive/dependencies.yaml.migrated`
- Stories + overrides imported into `_bmad-output/implementation-artifacts/sprint-plan.yaml`
- Legacy `epics: {independent: ...}` block dropped with a `warning` field (parallel execution moves to v2.4.0 mechanisms).

Or run the migrate command manually:

```
node _Sprintpilot/scripts/infer-dependencies.js migrate --project-root .
```

Idempotent — no-op when the legacy file is absent.

### Mid-flight commands

While the autopilot is running, send these as `user_input` signals from chat. The LLM session translates natural-language directives into structured commands.

| Command | Effect |
|---|---|
| `reorder_queue { order: [...] }` | Rewrite priorities. DAG-validated against per-epic + cross-epic upstreams; violations surface as a `plan_reorder_rejected` ledger entry with `suggestion` strings. |
| `add_to_sprint { story_keys: [...], position?, issue_ids? }` | Add stories to the plan. `position` accepts `'end'` (default), `'after:<key>'`, or an integer index. Optional `issue_ids` map populates `issue_id` per story. |
| `remove_from_sprint { story_keys: [...], mark_status? }` | Mark stories `plan_status: skipped` (default) or `'deferred'`. Doesn't delete entries — keeps them visible for context. |
| `replan_sprint { reason? }` | Halts at the next story boundary and emits `invoke_skill: sprintpilot-plan-sprint` on the next `autopilot start`. |

### `autopilot progress` CLI

Snapshot view of where the autopilot is. When `sprint-plan.yaml` has an `issue_tracker` block configured + per-story `issue_id` fields, those are surfaced inline so the output cross-references back to your Jira / Linear / GitHub / GitLab tickets:

```
$ node _Sprintpilot/bin/autopilot.js progress
Sprint plan: plan_id=abc-123
Progress: 3/8 done, 5 pending
Bar: [===========                   ] 37%
Issue tracking: 6/8 stories linked to jira (PROJ)
Current story: 1-3-add-auth [PROJ-101] (step: dev_green)
Recent step events:
  [142] 14:23:11 step_completed — 1-3-add-auth [PROJ-101] / dev_red (success)
  [143] 14:23:12 step_started — 1-3-add-auth [PROJ-101] / dev_green
```

When no issue tracker is configured, the `Issue tracking:` line and `[<id>]` brackets are silently omitted — output is unchanged from before.

Modes:
- Default: human-readable single snapshot.
- `--json`: machine-readable (for IDE extensions / dashboards). Adds `issue_tracker`, `current_issue_id`, `issue_tracking` (coverage stats), and an `issue_id` field on every `recent_events[]` entry.
- `--story <key>`: narrow to one story's detail. Renders a labeled block including `Issue ID:` (or `(not set)` when null).

```
$ node _Sprintpilot/bin/autopilot.js progress --story 1-3-add-auth
...
Story detail:
  Key:           1-3-add-auth
  Epic:          1
  Plan status:   pending
  Bmad status:   in-progress
  Priority:      3
  Current step:  dev_green
  Issue ID:      PROJ-101
```

Live tailing is not yet built-in; `watch -n 1 'autopilot progress'` works as a Unix-native alternative.

### `/sprintpilot-sprint-progress` skill

A read-only diagnostic that wraps `autopilot progress` with LLM judgment. Use it when you want a one-shot health check + a recommended next action, rather than scrolling through the raw JSON:

```
> /sprintpilot-sprint-progress

Sprint progress
  Plan:     abc-123 — 3/8 done (5 pending, 0 skipped, 0 excluded)
  Bar:      [===========                   ] 37%
  Tracker:  6/8 stories linked to jira (PROJ)
  Current:  1-3-add-auth [PROJ-101] (step: dev_green)
  Recent:   step_completed 1-3-add-auth [PROJ-101] / dev_red (12s ago)
            step_started 1-3-add-auth [PROJ-101] / dev_green (10s ago)

Health:   HEALTHY
Reason:   Autopilot is actively progressing through dev_green.
Suggest:  Continue running; nothing requires attention.
```

The skill classifies the sprint into one of `HEALTHY` / `STALLED` / `NEEDS-INPUT` / `EXHAUSTED` / `NO-PLAN` based on the last 40 ledger entries (halts, verify rejections, `consecutive >= 3` retry loops, plan_exhausted halts, etc.) and suggests exactly one next action. Add a story key as an argument (`/sprintpilot-sprint-progress 1-3-add-auth`) to drill into that story's plan entry.

**When to use which:**

| Use case | Tool |
|---|---|
| Live tail in a script / CI | `node _Sprintpilot/bin/autopilot.js progress --json` |
| Quick terminal snapshot | `node _Sprintpilot/bin/autopilot.js progress` |
| One-shot health check + LLM judgment + next-action suggestion | `/sprintpilot-sprint-progress` |
| Visualize the dependency graph | `/sprintpilot-dependency-graph` |
| Build / re-infer the dependency graph | `/sprintpilot-plan-sprint` |
| Full sprint-status report (BMad-native) | `bmad-sprint-status` |

### Visualizing the DAG

Use the dedicated skill — no shell commands required:

```
/sprintpilot-dependency-graph mermaid
```

The skill renders the graph inline in chat as a mermaid block and writes `_bmad-output/implementation-artifacts/sprint-plan-dag.mmd` so you can preview elsewhere (GitHub, VS Code Mermaid Preview, etc.).

Supported formats (pass as the first argument, or omit for an interactive prompt):

| Format | Output | Use for |
|---|---|---|
| `mermaid` *(default)* | Inline diagram + `.mmd` file | Quick visual check, PR review, design discussion |
| `graphviz` | `.dot` file (requires `dot` in PATH) | High-quality renderable graphs (PNG, SVG, PDF via `dot -Tpng …`) |
| `text` | Topological-tree rendered in chat | Terminal-only contexts, scripts |
| `layers` | JSON `[[layer1], [layer2], ...]` | Parallel-execution planning, automation |
| `json` | Raw `{nodes, edges, epic}` | IDE extensions, dashboards, custom tooling |

Additional invocation patterns:

```
/sprintpilot-dependency-graph                      # interactive prompt
/sprintpilot-dependency-graph graphviz             # graphviz mode
/sprintpilot-dependency-graph mermaid epic 1       # per-epic scope (no cross-epic edges)
/sprintpilot-dependency-graph mermaid --output dag.mmd
```

When `dot` isn't installed, graphviz mode falls back to mermaid with a clear notice — install it (`brew install graphviz` / `apt install graphviz`) to get .dot output.

The skill halts politely when `sprint-plan.yaml` doesn't exist yet — it points you at `/sprintpilot-plan-sprint` rather than trying to build the plan itself.

**Issue ID prefixes:** when `plan.stories[*].issue_id` or `plan.epics[*].issue_id` is set, the rendered labels are prefixed with `<issue_id>: ` so the diagram cross-references your tracker (Jira / Linear / GitHub / GitLab) at a glance:

```mermaid
flowchart LR
  subgraph epic_1 ["PROJ-100: Epic 1"]
    1-1-bootstrap["PROJ-101: 1-1-bootstrap"]:::done
    1-3-add-auth["1-3-add-auth"]:::pending   %% no issue_id set
  end
```

Stories and epics without an `issue_id` render with the bare key — silence communicates "not tracked", same convention as `autopilot progress`.

**Power-user / scripting note:** the skill wraps `node _Sprintpilot/scripts/resolve-dag.js render` (and `layers` / `graph` / `width` for the structured modes). Call those directly if you're scripting against the CLI; the skill exists so end users in chat don't need to.

### `plan_exhausted` halt

When every story in `sprint-plan.yaml` reaches a terminal `plan_status` (`done` / `skipped` / `excluded`), the autopilot emits a `user_prompt` halt:

> Sprint plan complete. All 8 planned stories are done (6 done, 1 skipped, 1 excluded). Run `/sprintpilot-plan-sprint` to build a new plan from remaining sprint-status stories, or run `autopilot start --no-auto-plan` to continue in sprint-status order.

The plan is archived to `.archive/sprint-plan-<plan_id>.yaml` so subsequent `autopilot start` calls see no live plan. Choose:

1. **Re-plan** via `/sprintpilot-plan-sprint` to build a new plan from remaining sprint-status stories.
2. **Drop planning** via `--no-auto-plan` to revert to sprint-status execution order.

### When NOT to use sprint planning

- BMad's `sprint-status.yaml` is your single source of truth and you don't have inter-story dependencies → stick with the default.
- You're running `complexity_profile: nano` with single-story sessions and want the bmad-quick-dev one-shot flow → plan-aware queue works for nano too (composeRuntimeState is profile-agnostic), but the visible benefit is smaller.
- You're upgrading from v2.2.x and want zero behavior change → leave `auto_plan_on_start: false` (the default).

### Onboarding for new users

The v2.3.0 installer prompts for one new question:

```
? Auto-build a sprint plan on first `autopilot start`? (Y/N)
```

Default `N` — net-new projects fall back to sprint-status execution order. You can always invoke `/sprintpilot-plan-sprint` manually regardless of this setting, so it's safe to say no.

The closing banner shows a recipe for the first sprint:

```
First steps for a new sprint:
  1. BMad sprint planning:        /bmad-sprint-planning
  2. (optional) Sprint plan:      /sprintpilot-plan-sprint
  3. Start autopilot:             /sprint-autopilot-on
  4. Check live progress:         /sprintpilot-sprint-progress
```

**Upgrading from v2.2.x:** the installer detects the legacy `_Sprintpilot/sprints/dependencies.yaml` file and surfaces a notice that it will auto-migrate on first `autopilot start`. If your existing config has `autopilot.auto_infer_dependencies: true` (the v2.2.x default), the installer notes that the flag is now a no-op (superseded by `auto_plan_on_start`) and safe to remove. Neither behavior blocks the install.

The installer also runs a post-install hygiene check: it cross-references `_Sprintpilot/manifest.yaml`'s `installed_skills` list against the on-disk `SKILL.md` files and warns on any mismatch. This catches the "added skill to manifest but forgot to ship the files" packaging bug at install time rather than at first invocation.

### Concurrent execution + safety

Sprintpilot v2.3.0 ships with cross-process mutual exclusion for `sprint-plan.yaml` writes — you don't need to think about it, but understanding it helps debug rare contention scenarios.

**Single-writer guarantee.** Every mutation of `sprint-plan.yaml` (markDone, addStories, removeStories, reorder, setIssueId, setIssueTracker, refreshBmadStatus, archive) acquires `.sprintpilot/plan.lock` via the project's existing `lock.js` primitive — the same one used by `preflight-merge.js` and submodule cleanup. Two concurrent autopilot sessions, or an autopilot session running alongside `/sprintpilot-plan-sprint`, will serialize their writes. The first wins; the second waits up to 30 seconds and then errors with `lock_timeout`.

**Lock file.** `.sprintpilot/plan.lock`. Stale-detection timeout is 5 minutes (a session that crashed mid-mutate releases the lock automatically on the next acquire attempt). You generally don't need to clean it up manually; if you do (e.g., killed a long-running operation hard), `rm .sprintpilot/plan.lock` is safe.

**Failure surfacing for mid-flight commands.** When a `user_input` command (`reorder_queue`, `add_to_sprint`, `remove_from_sprint`) fails — DAG violation, missing keys, validation error, plan corruption — the autopilot emits a `user_prompt` halt with a structured diagnostic rather than silently logging the failure:

```
plan_reorder_rejected: reorder_queue violates the dependency DAG. Violations:
  - 1-3-add-auth depends on 1-1-bootstrap (suggestion: insert 1-1-bootstrap before 1-3-add-auth)
  - 2-1-foo depends on 1-3-add-auth (suggestion: insert 1-3-add-auth before 2-1-foo)

Resubmit reorder_queue with a corrected order, or use add_to_sprint to bring missing upstreams into the plan first.
```

Same pattern for `add_to_sprint_failed`, `remove_from_sprint_failed`, `plan_reorder_failed` (corrupt plan, missing plan, write error). The LLM session sees the prompt and can either retry with corrected input or surface it to the user.

### Issue ID validation rules

The `issue_id` field on stories and epics is captured as free text during the planning skill's Step 7 (and via `setIssueId` from the script API). v2.3.0 enforces a small reject set:

- **Forbidden characters**: `[ ] < > | ; & \n \r` + ASCII control characters (`\x00`–`\x1f`, `\x7f`) + Unicode RTL/LTR override marks
- **Max length**: 200 characters

Legitimate tracker IDs from Jira (`PROJ-101`), Linear (`LIN-42`), GitHub (`org/repo#123`), and GitLab don't contain any of these. The reject set defends against:
- DAG render corruption (`]` and `|` are mermaid syntax; entity prefixes break in graphviz)
- Visual reordering attacks (RTL marks)
- Terminal control byte injection (`\x1b`, `\x07`)

If the planning skill captures a bad value, `setIssueId` throws — the skill should re-prompt with the validation reason rather than retry the same input.

### Verify-loop diagnostic

When the autopilot's verify pass (`verify.js`) rejects the LLM's success signal repeatedly with the **same set of issues**, the budget-exhausted halt now includes a loop-detection hint:

```
verify.js rejected 3 consecutive success signals on story_done.
Last issues: ["branch required","git_steps_completed must be true — skipping git push is the most common cause","sprint-status.yaml shows story X as 'ready-for-dev', expected 'done'"]

⚠ Verify rejected the SAME 3 issues 3 times in a row — this is a loop, not random noise. The LLM is re-sending an identical broken signal each retry. Action: read each issue text below and fix the underlying cause (e.g., if "git_steps_completed must be true — skipping git push is the most common cause", verify your git_op action actually ran `git push` to exit 0); don't just retry the same signal.
```

The hint fires when 2+ consecutive rejections have identical issues (whitespace + ordering-insensitive). When rejections vary (different errors each time), only the generic budget-exceeded message appears. The trackers (`last_verify_issues_signature`, `consecutive_identical_rejections`) are part of CRITICAL_KEYS so the count survives crashes — a SIGKILL between rejections doesn't reset the loop counter to zero.
