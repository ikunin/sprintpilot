# Sprintpilot — Autopilot & Multi-Agent Addon for BMad Method

[![npm version](https://img.shields.io/npm/v/@ikunin/sprintpilot.svg?style=flat)](https://www.npmjs.com/package/@ikunin/sprintpilot)
[![npm downloads](https://img.shields.io/npm/dm/@ikunin/sprintpilot.svg?style=flat)](https://www.npmjs.com/package/@ikunin/sprintpilot)
[![License Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg?style=flat)](LICENSE)
[![BMad Method](https://img.shields.io/badge/BMad%20Method-v6.2%2B-green.svg?style=flat)](https://github.com/bmad-code-org/BMAD-METHOD)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg?style=flat)](https://nodejs.org)
[![Tools](https://img.shields.io/badge/tools-9%20supported-orange.svg?style=flat)](#tools-9-supported)
[![GitHub stars](https://img.shields.io/github/stars/ikunin/sprintpilot.svg?style=flat)](https://github.com/ikunin/sprintpilot/stargazers)

Sprintpilot drives [BMad Method](https://github.com/bmad-code-org/BMAD-METHOD) v6 sprints to completion autonomously. One command turns your sprint plan into reviewed, tested, PR-ready code — story by story, with full git workflow and multi-agent intelligence.

BMad Method's manual flow is dozens of skills, menus, and git operations per story. Sprintpilot drives all of it for you — one command per sprint.

Flow control is owned by a deterministic Node.js state machine (`_Sprintpilot/bin/autopilot.js`) that enforces the BMad 7-step sequence. The LLM keeps in-skill execution, diagnosis, triage, and small-judgment decisions; the orchestrator owns sequencing and BMad-step enforcement. BMad skills are invoked verbatim — Sprintpilot never invents workflows or templates of its own.

> **Independent project.** Sprintpilot is not affiliated with or endorsed by BMad Code, LLC. See [TRADEMARK.md](TRADEMARK.md).
>
> **Migrating from `bmad-autopilot-addon` v1?** See [MIGRATION.md](MIGRATION.md). `sprintpilot install` auto-detects v1 and cleanly replaces it.

## Quick Start

```bash
# 1. Install BMad Method (interactive — pick your tool when prompted)
npx bmad-method install --modules bmm,tea

# 2. Install Sprintpilot (interactive — pick tool + complexity profile)
npx @ikunin/sprintpilot@latest

# 3. In your IDE, run:
/sprint-autopilot-on
```

Non-interactive install:

```bash
npx @ikunin/sprintpilot@latest install --tools claude-code --profile medium --yes
```

Runs on Windows, macOS, and Linux — every workflow call site is portable across bash, zsh, Git Bash, PowerShell, and cmd.

## What It Does, Story by Story

When you run `/sprint-autopilot-on`, the autopilot drives your entire sprint to completion:

1. **Reads your sprint plan** — picks the next story from `sprint-status.yaml`
2. **Creates an isolated worktree** — each story gets its own branch via `git worktree add`, keeping `main` clean
3. **Implements the story** — invokes `bmad-dev-story`, which writes code and tests following TDD (RED then GREEN)
4. **Lints the code** — auto-detects your language and runs the right linter on changed files only (not the whole repo)
5. **Stages explicitly** — never `git add -A`. Only changed files, with secrets / size / binary pre-commit checks.
6. **Commits with conventional messages** — `feat(epic): story title (story-key)`, placeholders resolved from your sprint artifacts
7. **Runs parallel code review** — three reviewers in parallel (see [Multi-Agent Intelligence](#multi-agent-intelligence))
8. **Applies every patch finding** — auto-accepts review fixes, commits each one separately for clean history
9. **Pushes and creates a PR** (configurable) — auto-detects GitHub / GitLab / Bitbucket / Gitea. With `create_pr: false`, merges directly to `main`.
10. **Moves to the next story** — exits the worktree, commits artifacts to `main`, picks up the next story
11. **Runs retrospective** per epic — when all stories in an epic are done, lists all PR URLs ready for merge

## What Makes It Autonomous

The autopilot handles everything that normally requires you to be present:

- **Deterministic state machine** — `_Sprintpilot/bin/autopilot.js` emits typed Actions (`invoke_skill`, `run_script`, `git_op`, `parallel_batch`, `user_prompt`, `halt`) and consumes typed Signals (`success`, `failure`, `blocked`, `propose_alternative`, `user_input`, `verify_override`). The LLM executes one BMad skill at a time per action — it doesn't pick the next step.
- **BMad bookkeeping enforced** — `verify.js` checks more than artifact existence: acceptance-criteria bullets exist, `[ ]` task boxes are flipped to `[x]`, `commit_sha` + `branch` are reported, and `git_steps_completed: true` only after every step in the orchestrator's inlined git plan (including `git push`) exits 0. Skipping any of these produces a `verify_rejected` ledger entry and the orchestrator re-emits the same action.
- **Decision audit channel** — small judgment calls (architecture, test-strategy, dependency, review-triage, scope, workaround) attach as `decisions[]` on any signal. The orchestrator stamps id + timestamp + story and appends to `decision-log.yaml` — no separate skill round-trip required.
- **LLM-as-peer protocol** — when the orchestrator emits an action the LLM disagrees with, it can return a `propose_alternative` signal carrying a full alternative Action + reason; the orchestrator decides whether to route. When `verify.js` rejects a `success` signal the LLM knows is correct (e.g., a test file was renamed per a logged decision), the LLM can return `verify_override` with `evidence.expected_paths` + `decision_log_ref` and verification re-runs with augmented expectations. The state machine owns sequencing; the LLM owns judgment.
- **Auto-inferred story DAG** — after `bmad-sprint-planning`, the autopilot infers inter-story dependencies once and writes `_Sprintpilot/sprints/dependencies.yaml`. Parallel dispatch works out of the box; no hand-authored deps file required. Hand-authored sidecars are detected and respected silently.
- **Menu navigation** — BMad skills present menus and confirmations. The autopilot auto-selects "Continue" / "Create Mode" and derives answers from your PRD and architecture docs.
- **Session management** — checkpoints state every N stories, halts with a markdown handoff report, and resumes exactly where it left off in the next session — with fingerprint-based divergence detection if anything moved in between. See [Sessions and the Handoff Report](#sessions-and-the-handoff-report).
- **Crash recovery** — on boot, the autopilot detects orphaned worktrees from a crashed previous run, pushes any committed-but-unpushed work, and cleans up stale state. No lost commits, no manual cleanup.

### When it stops (and only when)

The autopilot runs until the sprint is done or hits one of exactly 5 true blockers:

1. A skill needs **original creative input** not in any project document (e.g., product vision for a PRD)
2. A **new external dependency** is needed that isn't in the project
3. **3 consecutive test failures** with no forward progress
4. A **security vulnerability** requiring architectural decisions beyond the story scope
5. **Conflicting acceptance criteria** that can't be resolved from project docs

Everything else — it decides, documents the decision in one sentence, and moves on.

## The Git Workflow

Controlled by knobs in `_Sprintpilot/modules/git/config.yaml`. The orchestrator inlines every git op as an argv sequence (`git add`, `git commit`, `git push`, …) into the emitted action — the LLM executes the steps verbatim, never improvises. Concurrent git operations (parallel pushes, submodule updates, ref locks) are serialized and retry with jittered backoff — safe under parallel dispatch.

### Pick a mode

| Mode | Knobs | One PR per | Code reaches `main` | Best for |
|---|---|---|---|---|
| **Stacked PRs** *(default)* | `merge_strategy: stacked` | story (or epic, on nano) | After human PR approval & merge | Team workflows where every story needs review before it lands |
| **Land-as-you-go** | `merge_strategy: land_as_you_go` + `land_when` | story | Right after each story (CI/review gated) | Solo / fast-iteration sprints where waiting for stack approval is the bottleneck |
| **Direct merge** | `push.create_pr: false` | — *(no PR opened)* | Right after each story's push | Prototypes, hobby projects, internal tools without CI |
| **Reuse your branch** | `reuse_user_branch: true` | sprint (one PR for all stories) | After human PR approval & merge | Feature-branch workflows where you already have the branch you want |

All modes use isolated worktrees (`.worktrees/<story-key>/`) so `main` never has half-finished story code. The autopilot tracks git metadata in its own `git-status.yaml` — it never modifies BMad Method's `sprint-status.yaml`. After each story's push, the orchestrator syncs `_bmad-output/` planning and bookkeeping artifacts onto the base branch, so `git log <base>` is the canonical sprint audit trail regardless of merge strategy.

### Stacked PRs (default)

Stories are pushed and PRs are created. No auto-merge. Each story branches from the previous story's branch and targets it. Reviewers see each story's diff in isolation while the next story is already in progress. When a PR is merged on the platform, subsequent PRs automatically retarget.

```
main ─────────────────────────────────────────────────────────
  │                                          (artifacts only)
  ├── story/1-1 ──→ push + PR #42 (→ main)
  │        │
  │        └── story/1-2 ──→ push + PR #43 (→ story/1-1)
  │                 │
  │                 └── story/1-3 ──→ push + PR #44 (→ story/1-2)
  │
  Epic 1 complete → retrospective
  → "Ready to merge: PR #42, #43, #44"
```

Trade-off: zero waiting for review during the sprint, but you end up with a stack to merge afterward.

### Land-as-you-go

After every `STORY_DONE`, the orchestrator runs a new `STORY_LAND` state to merge that story's PR immediately instead of letting the stack grow. Each subsequent story branches from the already-merged base, so there is no stack to unwind at sprint-end.

```
main ── story/1-1 ──→ PR #42 ──→ ✓ CI / review ──→ merge ──→
   │                                                         ╲
   ├── story/1-2 ──→ PR #43 ──→ ✓ CI / review ──→ merge ──→  ╲
   │                                                          ╲
   └── story/1-3 ──→ PR #44 ──→ ✓ CI / review ──→ merge ──→  done
```

| Knob | Default | What it does |
|---|---|---|
| `land_when` | `ci_pass` | `no_wait` = merge synchronously, no CI wait. `ci_pass` = wait for `gh pr checks` (or platform equivalent) to report all checks green. `ci_and_review` = also wait for an `approved` PR review. |
| `land_wait_minutes` | `30` | Max wait for CI / review before the orchestrator halts and prompts you. |

**Rebase recovery.** If `main` moves while the story is in flight, the orchestrator runs `git rebase origin/<base>` and re-pushes. On rebase conflicts it halts with a `user_prompt`; resume reads `state.land_pending` and retries the land step after you resolve.

Trade-off: cleaner history and no end-of-sprint merge marathon, but each story blocks on CI before the next one starts — slower wall-clock if your CI is slow or you set `ci_and_review`.

### Direct merge (no PR)

Stories are merged straight into the base branch after push — no PR opened, no human review gate.

```
main ── story/1-1 ──→ merge ── story/1-2 ──→ merge ── story/1-3 ──→ merge
```

Use only when you genuinely don't want PRs (prototypes, tutorials, dev branches where you'll squash later). No CI gate, no review gate, no rebase recovery.

### Reuse your own branch

You create the branch yourself, then run the autopilot. It detects the current non-base branch on boot and commits **every** story directly onto it. No `story/*` or `epic/*` branches are created. One PR opens against `base_branch` at sprint-end.

```
main ─────────────────────────────────────────────────
  │
  └── feature/payments-rewrite (your branch, you created it)
        ├── feat(1): story 1-1 ─→ commit
        ├── feat(1): story 1-2 ─→ commit
        ├── feat(2): story 2-1 ─→ commit
        └── …                  ─→ push + PR (→ main, at sprint-end)
```

Useful for feature-branch workflows where you already have the branch you want to work on, or when you want a single end-of-sprint review.

### Branch naming

Branches created by the autopilot use the `branch_prefix` knob (default `story/`):

- Story granularity (default, all profiles except nano): `<branch_prefix><story-key>` → `story/1-3-add-auth`
- Epic granularity (nano profile): `<branch_prefix>epic-<epic-id>` → `story/epic-1`
- Reuse mode: no autopilot branches; your existing branch is used as-is.

The `_bmad-output/` sync after each story uses the argv sequence `git switch <base> → git checkout <branch> -- _bmad-output → git commit --allow-empty → git push origin <base> → git switch <branch>` — the orchestrator inlines those steps; the LLM runs them verbatim.

### Pre-commit safety

Before every commit the orchestrator runs deterministic checks against the staged files. None of these require LLM cooperation — they're enforced by Node.js scripts:

| Check | What it does |
|---|---|
| **Explicit staging** | Files are staged by name (`git add -- file1 file2`) — never `git add -A`, `git add .`, or `git add -u`. The set of staged files is cross-referenced against the story's `## File List`; unexpected or missing files are warned. |
| **Secrets scan** | Greps staged content for `API_KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `aws_access`, `private_key`. WARN severity by default — surfaced in the log but does not block the commit. Allowlist patterns live in `.secrets-allowlist`. |
| **File size** | Rejects files larger than `staging.max_file_size_mb` (default `1`). |
| **Binary detection** | Warns on binary files detected via `file --mime-encoding`. |
| **Gitignore check** | Verifies `.gitignore` covers `.autopilot.lock` and `.claude/.addon-backups/`. |

For each story, every commit (the main story commit + each code-review patch commit) runs the full check chain.

See [`modules/git/branching-and-pr-strategy.md`](_Sprintpilot/modules/git/branching-and-pr-strategy.md) for the full decision matrix.

## Sessions and the Handoff Report

A sprint usually doesn't fit in one LLM session. Long contexts rot — the model starts dropping steps, forgetting decisions, and skipping cleanup. Sprintpilot pre-empts this by checkpointing every N stories, halting cleanly, and resuming exactly where it left off in a fresh session.

### When the autopilot halts

| Trigger | What happens | How you resume |
|---|---|---|
| `session_story_limit` reached *(default 3, nano: 5)* | Orchestrator writes state + ledger, prints the report, releases the lock | Run `/sprint-autopilot-on` again — picks up at the next story |
| `sprint_finalize_pending` *(last story done)* | Orchestrator stops **before** cleanup — keeps that for a fresh context | Run `/sprint-autopilot-on` once more; finalize runs deterministically |
| Sprint complete | State + ledger files deleted; final report printed | Nothing to resume — the sprint is done |
| One of the 5 [true blockers](#when-it-stops-and-only-when) | Orchestrator halts with `user_prompt` | Answer the prompt, then `/sprint-autopilot-on` |
| Verify-reject budget exhausted | Orchestrator halts with the verifier's issues | Inspect, fix the underlying problem, then resume |

In every case, the same handoff report is emitted so you (and the next session) know exactly where things stand.

### The handoff report

Generated by `_Sprintpilot/lib/orchestrator/report.js` from the persisted state and the append-only `ledger.jsonl`. It's printed automatically whenever the autopilot halts at a session boundary, and you can re-print it on demand:

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

What each section is for:

- **Header** — current story, phase, sprint-complete flag, last write timestamp. Quick "where are we?" snapshot.
- **Ledger summary** — counts of every kind of event in `ledger.jsonl`. Spikes in `halt` or `failure` indicate trouble.
- **Last 10 actions** — the most recent `invoke_skill` / `run_script` / `git_op` actions with their phase. The trail of what just ran.
- **Recent decisions** — small judgment calls the LLM attached as `decisions[]` (architecture / test-strategy / dependency / review-triage / scope / workaround). The audit trail of the LLM's work.
- **Recent halts** — the last 3 reasons the autopilot stopped. Empty on a healthy session.
- **Next action** — explicit hint of what running `/sprint-autopilot-on` (or `autopilot next`) will do next, including the `sprint_finalize_pending` special case.

### Resuming with divergence detection

On the next `autopilot start`, the orchestrator fingerprints `_bmad-output/`, `sprint-status.yaml`, and per-story branch HEADs against the fingerprint recorded at the last halt. If anything moved between sessions (you edited a story file by hand, merged a PR on the platform, force-pushed a branch, …) the orchestrator surfaces it as a `resume_divergence` action with a diff of what changed:

```json
{
  "type": "user_prompt",
  "prompt": "Resume divergence detected. Differences: branch story/1-2 HEAD moved (a1b2c3 → d4e5f6). Choose: force_continue | override_decision",
  "kind": "resume_divergence",
  "differences": { ... }
}
```

You answer via a `user_input` signal (`force_continue` to accept and keep going, `override_decision` to reject with a reason) and the state machine resumes. Nothing is silently overwritten.

### Steering the autopilot mid-session

The autopilot isn't fire-and-forget. The orchestrator scans the host chat for user interjections every turn; if you say something while it's running, the LLM records it as a `user_input` signal and the state machine reacts on the next transition. Available commands (validated server-side by `user-commands.js` — malformed input is rejected with a clear message, never silently dropped):

| Command | What it does |
|---|---|
| `force_continue` | Accept a `resume_divergence` or `verify_rejected` finding and keep going |
| `override_decision` | Reject the orchestrator's last decision with a reason; entry appended to `decision-log.yaml` |
| `skip_story` | Mark the current story as skipped (BMad-side sprint-status change) |
| `halt` | Stop cleanly at the next safe checkpoint |
| `inject_decision` | Append a free-form decision entry without changing flow |

You don't have to learn these commands by name — phrase the intent naturally and the LLM maps your message to the right command + arguments before signalling.

### Crash recovery and orphaned worktrees

If a session crashes — process killed, machine rebooted, hook failed mid-commit — the next `/sprint-autopilot-on` runs a health check on `.worktrees/` *before* any new state-machine work. Each worktree is classified and handled deterministically:

| Classification | Condition | What happens |
|---|---|---|
| `COMMITTED` | Branch has commits beyond `base_branch` | Worktree is reactivated; committed-but-unpushed work is pushed + PR'd |
| `CLEAN_DONE` | Story marked `done` in sprint-status, worktree clean | Worktree removed |
| `STALE` | No commits beyond base; story not done | Work was lost; worktree removed |
| `DIRTY` | Uncommitted changes | You're prompted: stash, commit, or discard |
| `ORPHAN` | Worktree directory exists but branch was deleted | Worktree removed |

Stale locks (`.autopilot.lock` older than 30 minutes) are also auto-removed at this stage, so a crashed session never blocks the next one indefinitely.

### Fresh-context finalize

When the last story of the sprint hits `STORY_DONE`, the state machine transitions to `sprint_finalize_pending` — a terminal halt state — instead of running cleanup in the same session that just finished the last story. The next `/sprint-autopilot-on` reads the pending marker, jumps straight to the finalize state, and runs deterministic cleanup (mark-done-stories task checkboxes, worktree removal, artifact commits, retrospective, final report) with a clean context window.

This trades one short extra session (~60–100 turns, usually under $2) for reliable end-of-sprint hygiene. Without it, the tail of a long session regularly drops cleanup actions because the context is already full of story implementation work.

## Adaptive Process Scaling

The right amount of process for a 2-story bug-fix sprint is different from a 30-story green-field rebuild — running the heavy flow on a small change costs more LLM turns, more context rot, more time. One knob picks the right balance:

| Profile | Per-story flow | Branching | Worktrees | Parallel stories | Use it for |
|---------|---------------|-----------|-----------|------------------|-----------|
| `nano` | `bmad-quick-dev` (one-shot) | `epic` (one PR per epic) | off | n/a | Tiny patch sprints, hot-fix runs |
| `small` | Full 7-step BMad cycle | `story` (one PR per story) | on | off | Single-developer projects, ≤10 stories |
| `medium` *(default)* | Full 7-step BMad cycle | `story` | on | off | Default — balanced for most sprints |
| `large` | Full 7-step BMad cycle | `story` | on | **on** (Claude Code) | Multi-epic sprints, 20+ stories |
| `legacy` | Pinned to v1.0.5 behavior byte-for-byte | `story` | on | off | Existing installs that want zero behavior change |

Pick the profile at install time — `--profile <nano|small|medium|large|legacy>` non-interactively. Missing profile defaults to `medium` with no behavior change vs. v1.0.5.

**Nano safety net** — if `bmad-quick-dev` tests fail or its review classifies a finding as `high` severity, the autopilot escalates the session to the full 7-step cycle (session-scoped — never written back to config). Fast track for routine work, full rigor when something needs it.

### v2 optimization layers

Each can be disabled independently per profile in `_Sprintpilot/modules/autopilot/profiles/<profile>.yaml`:

- **Auto-inferred story DAG** — see above.
- **Phase timing instrumentation** — emits `duration` records per skill phase. `summarize-timings.js` reports hotspots over 5% of total runtime, so you can see where a sprint actually spends its time.
- **State sharding** — non-critical writes accumulate in `.pending/` shards, flushed atomically at story boundaries / session checkpoints / sprint complete. Crash-recovery keys still write straight through. This is what makes parallel dispatch safe under contention.
- **Conditional boot work** — on clean repos (main worktree only, no in-progress stories), skips the slow health-check / branch-reconciliation block, saving 8–30s per session. Disabled on `large` and `legacy` profiles, which always run full reconciliation.
- **Cached reads** — TTL + source-mtime aware file cache for hot reads; any writer's mtime advance auto-invalidates without explicit calls.
- **Parallel story dispatch** — when the host supports it, layer-aware dispatch runs N stories concurrently in their own worktrees, then merges their state shards. Claude Code today; Gemini CLI experimentally. See [Parallel Story Dispatch](#parallel-story-dispatch).

## Parallel Story Dispatch

When the active profile allows parallelism (`large` by default; opt-in on `medium`), the host supports concurrent subagents (Claude Code today; Gemini CLI experimentally), and the inferred DAG has ≥ 2 independent stories in the next layer, the orchestrator runs them concurrently instead of one after another:

1. **Resolve the next layer** — `resolve-dag.js layers --epic <id>` returns the next batch of stories with no unfinished prerequisites.
2. **Pre-create worktrees** — `dispatch-layer.js` creates one worktree per story and writes `.layer-plan.json` so each sub-agent knows its scope.
3. **Spawn N sub-agents in a single message** — each runs the full per-story flow (`bmad-create-story` → `bmad-dev-story` RED/GREEN → `bmad-code-review` → patches → commit/push/PR) inside its assigned worktree.
4. **Merge shards on return** — per-story state lives in `.autopilot-state/<story>.yaml` and `.decision-log/<story>.yaml` shards. `merge-shards.js --archive` collapses them into the project YAMLs atomically; the merged shards are archived under `.archive/layer-<id>/` for debugging.
5. **Loop to the next layer** — `parallel_batch` is a resolver in the state machine, not a one-shot. The orchestrator loops back to step 1 until the DAG is exhausted.

Per-story shards make this safe under contention: each sub-agent is the only writer of its shard, so concurrent YAML writes never corrupt each other. The coordinator (parent autopilot) is the only process that ever merges, and only at layer boundaries.

### Steering the DAG

After `bmad-sprint-planning`, the autopilot writes `_Sprintpilot/sprints/dependencies.yaml` with one inferred edge set per epic. Each story entry has a one-sentence `rationale` — review them once before parallel dispatch begins, because over-serialization (a spurious dependency the LLM inferred) silently slows the sprint instead of breaking it.

If detection got something wrong, edit the `overrides:` block:

```yaml
overrides:
  - epic: 2
    force_independent: ["2-1", "2-2"]    # detection was over-cautious
    force_sequential: ["2-3", "2-4"]     # detection missed a known conflict
```

The next planning cycle regenerates only the `stories:` block; `overrides:` and `epics:` are preserved verbatim. Hand-authored sidecars (no `# AUTO-INFERRED` marker) are detected and respected silently — no inference runs on top of them.

### Failure handling

| Failure | Response |
|---|---|
| One parallel story's tests fail | That story is isolated; siblings in the layer continue; downstream stories that depend on the failed one are blocked; reported at layer boundary |
| Merge conflict at layer boundary | Retry once after rebase; on second failure, abort that story and force sequential for the rest of the epic |
| `max_consecutive_conflicts` reached *(default 2)* | Parallelism auto-disables for the rest of the session, logged to `decision-log.yaml` |
| Worktree disk / permission failure | `parallel_batch` resolver downgrades to sequential per-profile |

## Multi-Agent Intelligence

Beyond the autopilot, Sprintpilot includes 7 multi-agent skills that launch parallel subagents for tasks that benefit from diverse perspectives.

### Parallel Code Review (`/sprintpilot-code-review`)

Three independent reviewers run **simultaneously** on the same diff — not serially. Each comes with a different bias by design:

| Agent | Perspective | Access |
|-------|------------|--------|
| **Blind Hunter** | Pure adversarial — finds bugs from code alone | Diff only, no project context |
| **Edge Case Hunter** | Boundary conditions, race conditions, missing validation | Full codebase access |
| **Acceptance Auditor** | Verifies every acceptance criterion is met | Diff + story spec |

Results are triaged: duplicates merged, contradictions flagged, findings classified as **PATCH / WARN / DISMISS**. The autopilot auto-accepts every PATCH finding and commits each fix separately.

### Brownfield Analysis Pipeline

> Codebase mapping inspired by [GSD's map-codebase](https://github.com/gsd-build/get-shit-done). Adapted with a distinct output format, enriched agent prompts, and BMad Method-specific downstream integration.

For existing codebases, three skills chain together:

**`/sprintpilot-codebase-map`** — 5 parallel agents scan the codebase simultaneously:
- Stack Analyzer (languages, frameworks, versions)
- Architecture Mapper (modules, patterns, data flow)
- Quality Assessor (tests, CI/CD, conventions)
- Concerns Hunter (TODOs, deprecated APIs, security issues, dead code)
- Integration Mapper (external APIs, databases, env vars)

Output files (`_bmad-output/codebase-analysis/`):

| File | Content |
|------|---------|
| `stack-analysis.md` | Languages, frameworks, versions, runtime requirements, package health |
| `architecture-analysis.md` | Project structure, architectural pattern, module boundaries, data flow |
| `quality-analysis.md` | Test coverage, CI/CD pipeline, code conventions, complexity metrics |
| `concerns-analysis.md` | TODOs/FIXMEs, security issues, dead code, deprecated patterns, error handling gaps |
| `integrations-analysis.md` | External APIs, databases, message queues, cloud services, env vars |

Scanned file types: TypeScript, JavaScript, Python, Java, Go, Rust, Ruby, C, C++, C#, SQL, PL/SQL (`.sps`, `.spb`), XML, Shell.

**`/sprintpilot-assess`** — 3 parallel agents produce actionable findings:
- Dependency Auditor (CVEs, outdated packages, upgrade paths)
- Debt Classifier (prioritized tech debt with effort estimates)
- Migration Analyzer (framework upgrade paths and phased roadmap)

Output: `_bmad-output/codebase-analysis/brownfield-assessment.md` — prioritized findings with severity, confidence, effort, and migration paths.

**`/sprintpilot-reverse-architect`** — 3 parallel agents extract architecture from code:
- Component Mapper (module boundaries, dependency graph)
- Data Flow Tracer (request lifecycle, state management)
- Pattern Extractor (design patterns, conventions, error handling)

Output: `{planning_artifacts}/architecture.md` — BMad Method-compatible, feeds directly into `bmad-create-epics-and-stories`.

### Migration Planning (`/sprintpilot-migrate`)

A 12-step workflow for taking a codebase from one stack to another, with 4 subagent fan-outs:

1. Validate prerequisites and get target stack from user
2. Auto-recommend migration strategy (strangler fig / big bang / branch-by-abstraction / parallel run)
3. **Parallel**: Stack Mapper + Dependency Analyzer produce compatibility matrix
4. Design coexistence layer (old + new code running together)
5. Build phased roadmap ordered by dependency graph
6. Generate per-component migration cards with effort/risk
7. Plan data migration (schema changes, dual-write, backfill)
8. Design API compatibility (versioning, deprecation timeline)
9. **Parallel**: Test Parity Analyzer maps old tests to new equivalents
10. **Parallel**: Risk Assessor produces per-phase risk matrix with rollback triggers
11. Generate BMad Method-compatible epics for sprint planning
12. Finalize migration plan, epics, and tracking artifacts

Output:

| File | Location | Content |
|------|----------|---------|
| `migration-plan.md` | `{planning_artifacts}/` | Strategy, compatibility matrix, coexistence design, phased roadmap, component cards, data/API migration, risk matrix |
| `migration-epics.md` | `{planning_artifacts}/` | Epics with stories, acceptance criteria, effort estimates (BMad Method-compatible) |
| `migration-tracking.yaml` | `{implementation_artifacts}/` | Phase-by-phase progress tracking for sprint execution |

### Research and Discussion

**`/sprintpilot-research`** — fan out research across multiple topics in parallel, each with web search access. Results synthesized into a unified report.

**`/sprintpilot-party-mode`** — launch 2–3 BMad personas (architect, PM, QA, dev, etc.) as parallel agents debating a topic. Multiple rounds where personas respond to each other. Produces consensus points, disagreements, and action items.

## Skills Reference

| Skill | What it does |
|-------|--------------|
| `/sprint-autopilot-on` | Engage autonomous sprint execution |
| `/sprint-autopilot-off` | Disengage and show status |
| `/sprintpilot-update` | Check for updates and install the latest version |
| `/sprintpilot-code-review` | Parallel 3-layer adversarial code review |
| `/sprintpilot-codebase-map` | 5-stream brownfield codebase analysis |
| `/sprintpilot-assess` | Tech debt, dependency audit, migration assessment |
| `/sprintpilot-reverse-architect` | Extract architecture document from existing code |
| `/sprintpilot-migrate` | 12-step legacy migration planning |
| `/sprintpilot-research` | Parallel web research fan-out |
| `/sprintpilot-party-mode` | Multi-persona BMad agent discussions |

## Compatibility

### Tools (9 supported)

Sprintpilot uses the universal SKILL.md format — same skills work everywhere:

| Tool | Directory | Tool | Directory |
|------|-----------|------|-----------|
| Claude Code | `.claude/skills/` | Roo Code | `.roo/skills/` |
| Cursor | `.cursor/skills/` | Trae | `.trae/skills/` |
| Windsurf | `.windsurf/skills/` | Kiro | `.kiro/skills/` |
| Gemini CLI | `.gemini/skills/` | GitHub Copilot | `.github/copilot/skills/` |
| Cline | `.cline/skills/` | | |

For non-interactive installs:

```bash
npx @ikunin/sprintpilot@latest install --tools <tool1>,<tool2> --yes
```

Valid values: `claude-code`, `cursor`, `windsurf`, `gemini-cli`, `cline`, `roo`, `trae`, `kiro`, `github-copilot`, or `all`.

### Git platforms

| Platform | CLI | Auto-detect | API fallback |
|----------|-----|-------------|--------------|
| GitHub | `gh` | `github.com` | No |
| GitLab | `glab` | `gitlab.*` | No |
| Bitbucket | `bb` | `bitbucket.org` | Yes (`BITBUCKET_TOKEN`) |
| Gitea | `tea` | Explicit config | Yes (`GITEA_TOKEN` + `base_url`) |

No CLI installed? Falls back to **git_only mode** (direct merge, no PRs).

### Linters (auto-detected, changed files only)

| Language | Linters | Language | Linters |
|----------|---------|----------|---------|
| Python | ruff, flake8, pylint | Java | checkstyle, pmd |
| JavaScript/TS | eslint, biome | C/C++ | cppcheck, clang-tidy |
| Rust | cargo clippy | C# | dotnet format |
| Go | golangci-lint | Swift | swiftlint |
| Ruby | rubocop | PL/SQL | sqlfluff |
| Kotlin | ktlint, detekt | PHP | phpstan, phpcs |

First found wins per language. Multi-language monorepos lint all languages in one pass. See [Extending](docs/EXTENDING.md) to add more.

## Configuration

All settings live in YAML files under `_Sprintpilot/modules/`. Most projects only ever change a handful — the rest have sensible profile-aware defaults.

**Most-tweaked settings:**

| Setting | File | Default | What it controls |
|---------|------|---------|------------------|
| `complexity_profile` | `autopilot/config.yaml` | `medium` | One of `nano`/`small`/`medium`/`large`/`legacy` — picks the per-story flow + which v2 layers are enabled |
| `autopilot.implementation_flow` | `autopilot/config.yaml` | `full` (nano: `quick`) | `full` runs the 7-step BMad cycle; `quick` routes every story through `bmad-quick-dev` and boots fresh sessions directly at `NANO_QUICK_DEV` |
| `git.push.create_pr` | `git/config.yaml` | `true` | `true` = push + PR (no auto-merge), `false` = direct merge to base branch |
| `git.merge_strategy` | `git/config.yaml` | `stacked` | `stacked` keeps every story branch open until sprint-end; `land_as_you_go` merges each PR right after `STORY_DONE` (gated by `land_when` / `land_wait_minutes`) |
| `git.reuse_user_branch` | `git/config.yaml` | `false` | When `true`, autopilot commits every story onto the user's current branch instead of creating per-story / per-epic branches; one PR opens at sprint-end |
| `git.branch_prefix` | `git/config.yaml` | `story/` | Prefix for autopilot-created branches (e.g., `story/1-3-add-auth`, `story/epic-1`) |
| `git.lint.blocking` | `git/config.yaml` | `false` | `true` = lint errors halt the autopilot |
| `autopilot.session_story_limit` | `autopilot/config.yaml` | `3` (nano: `5`) | Stories per session before checkpoint. `0` = unlimited |
| `multi_agent.enabled` | `ma/config.yaml` | `true` | Enable parallel agent skills |

**Profile-level overrides** — settings like `parallel_stories`, `state_sharding`, `phase_timings`, `cache_shared_reads`, and `conditional_boot_work` live in profile files at `_Sprintpilot/modules/autopilot/profiles/<profile>.yaml`, not in `autopilot/config.yaml` or `ma/config.yaml`. Their effective value depends on the active `complexity_profile`.

See the [Configuration Reference](docs/CONFIGURATION.md) for every setting, default, and profile-level override.

## Requirements

- [BMad Method](https://github.com/bmad-code-org/BMAD-METHOD) v6.2.0+
- A supported AI code agent (see [Tools](#tools-9-supported))
- Git repository with at least one commit
- Platform CLI for PR creation (optional — see [Git platforms](#git-platforms))

## Documentation

- [Installation Guide](docs/INSTALLATION.md)
- [Usage Guide](docs/USAGE.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Configuration Reference](docs/CONFIGURATION.md)
- [Extending (Platforms & Languages)](docs/EXTENDING.md)
- [Contributing](docs/CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## License

Apache 2.0
