# BMad Method Workflow — Mandatory for All AI Agents

This project uses the **BMad Method** with **Sprintpilot** (autopilot + multi-agent addon). Always use the BMad Method workflow for every story. Never skip steps. When unsure, invoke `bmad-help` first.

---

## Navigation & orientation

| Skill | When to use |
|-------|-------------|
| `bmad-help` | First resort when unsure what to do next — analyzes current state and recommends the right skill or workflow |

---

## Sprintpilot — autopilot & git workflow

| Skill | When to use |
|-------|-------------|
| `sprint-autopilot-on` | Start autonomous story execution with git branching, commits, and PRs |
| `sprint-autopilot-off` | Disengage autopilot, show sprint + git status report |

When Sprintpilot or the git addon is active:
- **NEVER** use `git add -A` or `git add .` — always stage files explicitly by name
- **NEVER** commit secrets, API keys, tokens, or credentials
- Each story gets its own isolated worktree and branch (`story/<key>`)
- Commits use conventional format: `feat(<epic>): <title> (<key>)`

### Autopilot configuration

Edit `_Sprintpilot/modules/autopilot/config.yaml`:

| Setting | Default | Values | Purpose |
|---------|---------|--------|---------|
| `autopilot.session_story_limit` | `3` (nano: `5`) | integer ≥ 0 | Stories fully implemented per autopilot run before checkpoint. `0` = unlimited. Nano is cheaper per story and fits a higher cap. |
| `autopilot.retrospective_mode` | `auto` | `auto` / `stop` / `skip` | How epic-end retrospectives are handled (see below). |
| `autopilot.auto_infer_dependencies` | `false` (was `true` pre-v2.3.0) | bool | **Legacy flag — superseded by `auto_plan_on_start` in v2.3.0.** See "Sprint Planning + DAG-Aware Execution" below. |
| `autopilot.auto_plan_on_start` | `false` | bool | **v2.3.0.** When `true`, `autopilot start` emits `invoke_skill: sprintpilot-plan-sprint` on greenfield projects (no `sprint-plan.yaml`). Default `false`: missing plan → fall back to sprint-status order. Once a plan exists, staleness triggers auto-derive regardless of this knob. |
| `autopilot.fast_lane.enabled` | `false` | bool | **Fast lane.** When `true`, a full profile (`small`/`medium`/`large`) may route *individual* low-risk stories through one-shot `bmad-quick-dev` instead of the 7-step cycle. A conservative pre-story gate decides `fast\|full` (defaults `full` on doubt); any failure bounces the story back to the full cycle and remembers it. Prompted at install. See "Fast lane" below. |
| `autopilot.fast_lane.max_ac` | `3` | integer ≥ 0 | Stories with more Acceptance Criteria than this never fast-lane (a size gate that beats an explicit fast tag). |
| `autopilot.fast_lane.allow_globs` | `"docs/**,**/*.md"` | comma-sep globs | A story only *infers* `fast` when every path it declares is allow-listed here. |
| `autopilot.fast_lane.deny_globs` | `"**/auth/**,**/migrations/**,**/*secret*,**/*secret*/**"` | comma-sep globs | Any declared path matching these forces `full` — hard safety, beats a fast tag. |
| `autopilot.fast_lane.require_story_tag` | `false` | bool | When `true`, only stories explicitly tagged `fast_lane: true` / `risk: low` fast-lane. |
| `git.lock.stale_timeout_minutes` | `30` | integer ≥ 0 | `.autopilot.lock` older than this is auto-taken-over by the next session. `0` disables auto-takeover (locks held until released manually). |
| `git.worktree.health_check_on_boot` | `true` | bool | At session start, scan `.worktrees/` for orphans from crashed sessions and halt with a prune hint when any are found. |
| `git.worktree.cleanup_on_merge` | `true` | bool | After an epic merges, prune worktree metadata and remove `.worktrees/<key>/` directories whose branches no longer exist locally or on origin. |
| `git.lint.enabled` | `false` | bool | After `dev_green` verify passes, run the composed lint pipeline (`scripts/post-green-gates.js`: lint-changed + lint-test-pitfalls + ci-parity scan). |
| `git.lint.blocking` | `false` | bool | When true, a failing lint gate rejects verify so the LLM gets a fix-loop. When false, failures are recorded but don't gate the autopilot. |
| `git.lint.output_limit` | `100` | integer ≥ 0 | Max lines of lint output injected back as context. |
| `git.lint.linters` | (auto-detect) | map of language → ordered list | Per-language linter preference. Languages: `python` / `javascript` / `typescript` / `rust` / `go` / `ruby` / `java` / `c` / `cpp` / `csharp` / `swift` / `sql` / `kotlin` / `php`. `javascript` and `typescript` merge into a single `js-ts` bucket. An empty list disables linting for that language. |
| `testing.scope` | `affected` (legacy: `full`) | `affected` / `full` | **v2.3.18.** Per-phase test scope for `DEV_RED` / `DEV_GREEN` / `PATCH_APPLY` / `PATCH_RETEST` / `NANO_QUICK_DEV`. `affected` derives a change-aware command per emission (Vitest `--changed`, Jest `--findRelatedTests`, pytest `--testmon` / directory-mapped, or a configurable generic adapter). CI gates the full suite via `gh pr checks` on `STORY_LAND`. |
| `testing.fallback` | `full` | `full` / `directory` / `halt` | What happens when affected-detection fails (no adapter match, no diff). `full` is the safe default. |
| `testing.full_suite_on_story_land` | `ci` | `ci` / `background` / `skip` | Where the regression-net full suite runs. `background` is **deferred to v2.3.19** (currently warns when set). |
| `testing.commands.affected` / `testing.commands.full` | `null` | string | Verbatim overrides for the adapter-built commands. Useful for monorepos (`nx affected`, `turbo run test`, `lerna run test --since`). |
| `autopilot.resume_mid_skill` | `true` | bool | **v2.6.0.** When true, `autopilot start` detects skill invocations interrupted by a crash / OS kill and threads a structured `resume_hint` (AC checkboxes, files changed since `phase_started_at`, last `verify_result`, `patch_commits`, last `skill_checkpoint`) into the next `invoke_skill` action so the skill skips already-done work instead of restarting from zero. Skills emit progress via `signal.output.checkpoint` (`{ summary, ac_done, tests_passing, tests_failing, files_touched, next_step }`). Manual override: `autopilot resume [--no-emit] [--force]`. Set to `false` for byte-for-byte v2.5.x semantics. |

`retrospective_mode` options:
- **`auto`** *(default)* — autopilot writes a deterministic retrospective artifact from `sprint-status.yaml` + `decision-log.yaml`, then continues. Single pass, no external skill call, safe under every CLI.
- **`stop`** — autopilot pauses at epic completion. Run `/bmad-retrospective` interactively, then re-run `/sprint-autopilot-on` to resume. Use this when you want the full multi-persona discussion as part of your process.
- **`skip`** — no retrospective artifact is written. **Not recommended** — you lose the epic-level learning record.

Both settings are prompted during `sprintpilot install` (interactive mode) with existing values as defaults, so reinstalls preserve your choices.

#### Fast lane (per-story quick-dev under full profiles)

**Default OFF.** When `autopilot.fast_lane.enabled` is true, a deterministic pre-story gate routes **individual low-risk stories** through `bmad-quick-dev` (one-shot) under a full profile, while substantial stories keep the mandatory 7-step cycle. This is a sanctioned, opt-in relaxation of the RED-first rule — the same kind of exception as `nano`, not a silent skip. The installer asks whether to enable it.

How a story is routed (the gate is conservative — **any uncertainty → `full`**):

- more Acceptance Criteria than `max_ac` → `full` (beats a fast tag);
- any declared path matching `deny_globs` (auth / migrations / secrets) → `full`, even against an explicit fast tag;
- inference routes `fast` only when **every** path the story declares is covered by `allow_globs`;
- an explicit tag forces the decision — in the story file (`fast_lane: true` / `risk: low|high`) or on the story's **epic entry** in `sprint-plan.yaml` (story-file tag wins). A `full`-forcing tag always beats a `fast` one.

**Guardrails.** Tests are still required (`verifyNanoQuickDev` needs `tests_run > 0`, a commit SHA, and sprint-status `done`). If a fast-laned quick-dev run **fails, reports failing tests, or flags a high-severity finding**, the autopilot bounces that story back to the full 7-step cycle (re-running `bmad-create-story` → the 7 steps) and records it in `fast_lane_forced_full` so it never re-fast-lanes. The re-run carries an escalation note telling the dev step it's hardening existing committed code, not doing greenfield RED.

**Auditing.** Every routing choice is a `fast_lane_decision` ledger entry; `autopilot progress` and the session report show fast-laned and escalated counts.

### Sprint Planning + DAG-Aware Execution (v2.3.0)

`/sprintpilot-plan-sprint` builds the authoritative sprint plan at `_bmad-output/implementation-artifacts/sprint-plan.yaml`. The plan persists per-epic dependencies, cross-epic edges, per-story `plan_status`, priorities, and optional external issue-tracker links. BMad's `sprint-status.yaml` remains the source of truth for *what stories exist*; the plan is the source of truth for *what runs next, in what order, and with what dependencies*.

The skill follows a 14-step workflow (`_Sprintpilot/skills/sprintpilot-plan-sprint/workflow.md`):

1. Load inputs (sprint-status, epics.md, architecture.md, existing plan)
2. One-shot legacy migration (`_Sprintpilot/sprints/dependencies.yaml` → archived)
3. Staleness check
4. Per-epic inference loop (max 3 validation retries per epic; partial saved on 3rd failure)
5. Cross-epic detection (separate prompt; combined-graph cycle check)
6. Optional issue-tracker block setup
7. Optional per-entity issue_id capture (with bulk-skip + pattern options)
8. Finalize dependencies in plan
9. Build sprint-wide DAG via `resolve-dag.js graph`
10. Present DAG (text-mode tree + mermaid render)
11. Curate stories (which belong in the active plan)
12. Validate selection against DAG (every upstream included OR terminal)
13. Atomic write via `sprint-plan.js write`
14. Report

The skill is invoked three ways:

- **User-direct:** `/sprintpilot-plan-sprint` with no arguments.
- **Auto-derive:** autopilot emits `invoke_skill: sprintpilot-plan-sprint` when a plan is missing/stale (gated by `auto_plan_on_start` config + opt-in for greenfield).
- **Replan:** user issues `user_input { kind: 'replan_sprint' }` mid-flight; autopilot halts and emits the skill on next start.

**Mid-flight commands** translate natural-language directives into structured `user_input` signals:

- `reorder_queue { order: [...] }` — DAG-validated reordering; violations surface with suggestions.
- `add_to_sprint { story_keys, position?, issue_ids? }` — adds entries to the plan.
- `remove_from_sprint { story_keys, mark_status? }` — marks `plan_status: skipped` (default) or `'deferred'`.
- `replan_sprint { reason? }` — halts + re-invokes the planning skill.

**`autopilot progress`** CLI provides a one-shot snapshot (or `--json` for machine-readable output) showing plan progress bar, current story + step, and recent step events. When `plan.issue_tracker` is configured, `[<issue_id>]` brackets enrich the current-story line + each recent event, and an `Issue tracking: N/M stories linked to <provider>` coverage line surfaces in the summary.

**`/sprintpilot-sprint-progress`** is the LLM-layered diagnostic on top of the same data — produces a 1-block health report (HEALTHY / STALLED / NEEDS-INPUT / EXHAUSTED / NO-PLAN) with exactly one recommended next action. Read-only; suggests user commands rather than executing them. Pass a story key as argument (`/sprintpilot-sprint-progress 1-3-add-auth`) to drill into a single story's plan entry.

**Plan exhaustion** (every story in `plan_status` terminal) archives the plan to `.archive/sprint-plan-<plan_id>.yaml` and emits a `user_prompt` halt — the user chooses re-plan vs. fall back to sprint-status order.

**Pre-v2.3.0 migration:** the pre-existing `_Sprintpilot/sprints/dependencies.yaml` (from the legacy `auto_infer_dependencies` flow) auto-migrates on the first v2.3.0 `autopilot start`. Stories + overrides import into the new plan; the legacy `epics: {independent: ...}` block is dropped with a warning (parallel-execution config moves to v2.4.0 mechanisms).

Default behavior for greenfield projects (`auto_plan_on_start: false`) is unchanged from v2.2.x: `autopilot start` executes stories in sprint-status order without invoking any LLM-driven planning.

See `docs/USAGE.md#sprint-planning--dag-aware-execution-v230` for the full user-facing walkthrough and `docs/ARCHITECTURE.md#sprint-planning--dag-aware-execution-v230` for the implementation architecture.

### Parallel Story Dispatch (DAG infrastructure)

The DAG built by sprint planning also underwrites `dispatch-layer.js` infrastructure (`planBatch`, `resolve-dag.js`, `merge-shards.js`, `agent-adapter.js`). `ma.parallel_stories: true` enables the building blocks, but the state machine still emits stories one at a time today; intra-epic parallel emission lands in a future minor release. The autopilot logs a clear notice at session start when the flag is set so the behavior is unambiguous.

### Mandatory fresh-context finalize

Independent of `session_story_limit`, the autopilot forces an extra session at end-of-sprint. When step 2 detects all stories are done, it writes `current_bmad_step = sprint-finalize-pending` to the state file and halts — it does **not** run step 10 (cleanup) in that session. The next `/sprint-autopilot-on` invocation reads the marker in step 1 and jumps directly to step 10 with a clean context window, where seven CRITICAL deterministic script calls run the cleanup (checkbox marking, worktree removal, lock release, artifact commit, sprint-complete state, verification, state-file delete).

This behavior is not configurable: it's a mitigation for late-session instruction decay that drops cleanup actions in long single-session runs. The extra session is short (typically ~60-100 turns, under $2). Enforced by the `sprint_finalize_pending` terminal state in `_Sprintpilot/lib/orchestrator/state-machine.js`.

### Resume mid-skill (v2.6.0)

When `autopilot.resume_mid_skill: true` (the default), `autopilot start` walks the ledger backwards on every boot looking for an `action_emitted` (`type: invoke_skill`) whose phase never reached a terminal entry (`signal_recorded`, `halt`, or a prior `phase_resumed`). When one is found — meaning the previous session was killed mid-skill — the orchestrator builds a structured `resume_hint` from observable state and threads it into the next `invoke_skill` action's `template_slots.resume_hint`:

- `phase`, `story_key`, `reason` (`skill_interrupted` or `manual_resume`), `interrupted_at`, `phase_started_at`, `elapsed_minutes`.
- `checkpoint` — the most recent `skill_checkpoint` ledger entry's payload (if any). Shape: `{ summary, ac_done, tests_passing, tests_failing, files_touched, next_step }`.
- `changed_files` — working-tree changes (staged + unstaged + untracked) plus commits made on the branch since `phase_started_at`, capped at 50.
- `ac_completed` / `ac_total` — parsed from the story markdown's `## Acceptance Criteria` checklist.
- `last_test_result` — the most recent `verify_result` ledger entry for the phase, summarised as `{ ok, summary }`.
- `patches_landed` — `state.patch_commits` (PATCH_RETEST / PATCH_APPLY only).
- `summary` — one-line human-readable description for logs / `autopilot watch`.

Skills that know about `resume_hint` should: (1) treat `ac_completed` as a fast-path filter — checked-off ACs don't need re-implementing; (2) trust `checkpoint.tests_passing` — already-green tests don't need re-running unless `changed_files` invalidates them; (3) re-run anything in `checkpoint.tests_failing` first; (4) inspect `changed_files` for in-progress edits.

Long-running skills emit progress checkpoints via `signal.output.checkpoint` (same shape as `resume_hint.checkpoint`). Checkpoints are NOT terminal — the skill keeps running and emits its actual signal when done. The next interruption surfaces the most recent checkpoint to the resuming skill.

Each detected interruption appends a `phase_resumed` ledger entry carrying the full hint payload. `autopilot watch` colorises it like any other informational event.

**Manual override.** `autopilot resume` forces a hint to be built for the current phase even when auto-detection says nothing to resume (useful when a previous session emitted `signal_recorded: success` but the work wasn't in fact complete). `--no-emit` prints the would-be hint without re-emitting the action (preview without ledger pollution). `--force` proceeds even when `resume_mid_skill: false` is set in the profile.

### Resume divergence

At session start, the orchestrator also fingerprints `_bmad-output/`, sprint-status.yaml, and per-story branch HEADs and compares against the fingerprint stamped at the last halt. When they differ, two escape paths proceed without manual state surgery:

- **External completion (auto)** — when the persisted `current_story` is `done` in sprint-status (story merged outside the autopilot: manual PR merge, hotfix, UI action), the stale story identity is cleared and the orchestrator picks the next pending story. Logged as `divergence_accepted, reason: external_completion`.
- **`--accept-divergence` flag** — catch-all for divergence patterns the auto-acknowledge doesn't cover (multiple stories completed externally, branch heads moved, etc.). Logged as `reason: explicit_accept`.

Divergences outside both paths emit `resume_divergence` with the diff so the user/LLM can resolve.

Resume divergence (sprint-level) is independent from resume mid-skill (phase-level) — both run on every `autopilot start` and are complementary: divergence catches sprint-status drift; resume mid-skill catches in-flight phase interruptions.

### Terminal statuses for epic-done routing

A story counts as "non-remaining" for end-of-epic detection when its sprint-status entry is any of: `done` / `skipped` / `wont_do` / `won't_do` / `cancelled` / `canceled` / `deferred` / `abandoned`. Hand-edit sprint-status to flag deferred work without lying it shipped — the orchestrator routes to RETROSPECTIVE once every entry in the epic is terminal.

When deferred entries can't be reclassified in time, the LLM can emit `user_input { kind: 'trigger_retrospective' }` to force-route to RETROSPECTIVE for the current epic regardless of `remaining_stories_in_epic`. This is the canonical way to "close out epic N with retro" while non-terminal stories remain.

---

## Full skill reference by lifecycle phase

### Phase 0 — Project inception (new projects)

| Skill | When to use |
|-------|-------------|
| `bmad-product-brief` | Start here for a new project — collaborative discovery of goals, constraints, users |
| `bmad-create-prd` | Create a full Product Requirements Document from scratch |
| `bmad-edit-prd` | Update or revise an existing PRD |
| `bmad-validate-prd` | Validate a PRD against BMad Method standards before moving to design |
| `bmad-create-architecture` | Create technical architecture and solution design decisions |
| `bmad-create-ux-design` | Plan UX patterns and design specifications |
| `bmad-create-epics-and-stories` | Break PRD + architecture into epics and story list |
| `bmad-generate-project-context` | Generate `project-context.md` with AI rules (run once after inception) |
| `bmad-document-project` | Document an existing (brownfield) project to give AI agents context |

### Phase 1 — Sprint planning (before development starts)

| Skill | When to use |
|-------|-------------|
| `bmad-sprint-planning` | Generate `sprint-status.yaml` tracking file from epics list |
| `bmad-sprint-status` | Check current sprint status and surface risks at any time |
| `bmad-correct-course` | Manage significant scope or direction changes mid-sprint |
| `sprintpilot-plan-sprint` *(v2.3.0)* | **Optional, opt-in.** After BMad sprint planning, build a dependency-aware sprint plan with per-epic + cross-epic edges, plan-aware queue ordering, and optional external issue-tracker links. Auto-triggered when a stale plan is detected; only runs on greenfield projects when `autopilot.auto_plan_on_start: true`. Replaces the legacy `_Sprintpilot/sprints/dependencies.yaml` workflow. See "Sprint Planning + DAG-Aware Execution (v2.3.0)" above. |
| `sprintpilot-sprint-progress` *(v2.3.0)* | **Read-only diagnostic.** Wraps `autopilot progress --json` with LLM judgment: classifies sprint health (`HEALTHY` / `STALLED` / `NEEDS-INPUT` / `EXHAUSTED` / `NO-PLAN`) from the recent ledger tail and suggests one concrete next action. Surfaces `issue_id` brackets when an issue_tracker is configured. Pass a story key as argument to drill into a single story's plan entry. Never mutates state — points users at the appropriate `user_input` command when corrective action is needed. |
| `sprintpilot-dependency-graph` *(v2.3.0)* | **Read-only renderer.** Generates the sprint dependency graph in a chosen format: `mermaid` (default; GitHub-renderable), `graphviz` (.dot), `text` (topological tree), `layers` (JSON parallel groups), or `json` (raw `{nodes, edges, epic}`). Asks interactively when no format is supplied; accepts `epic <id>` for per-epic scope. Inline-renders mermaid into chat. Halts politely when no plan exists — points the user at `/sprintpilot-plan-sprint` rather than building one. |

### Phase 2 — Story development (the mandatory per-story loop)

See **Mandatory sequence per story** section below.

### Phase 3 — Epic close-out

| Skill | When to use |
|-------|-------------|
| `bmad-retrospective` | Run after all stories in an epic are `done`; saves lessons, marks epic `done`. Under autopilot this is driven by `autopilot.retrospective_mode` (`auto` inline, `stop` to pause for interactive use, or `skip`). |

---

## Quick path — for small changes without full story ceremony

| Skill | When to use |
|-------|-------------|
| `bmad-quick-dev` | Implement any user intent (bug fix, tweak, refactor) directly — follows project conventions |

> Use the quick path only for genuinely small, isolated changes. For anything touching multiple components or requiring E2E coverage, use the full story loop.

---

## Sprintpilot multi-agent skills

These launch parallel subagents for deeper, faster analysis:

| Skill | Agents | When to use |
|-------|--------|-------------|
| `sprintpilot-codebase-map` | 5 | Brownfield codebase mapping (stack, architecture, quality, concerns, integrations) |
| `sprintpilot-assess` | 3 | Tech debt assessment (dependency audit, debt classification, migration analysis) |
| `sprintpilot-reverse-architect` | 3 | Extract architecture from existing code (components, data flow, patterns) |
| `sprintpilot-migrate` | 4 | Full migration planning — 12 steps from current stack to target stack |
| `sprintpilot-research` | N | Parallel research fan-out with web search |

### Brownfield analysis pipeline

```
sprintpilot-codebase-map → sprintpilot-assess → sprintpilot-reverse-architect → sprintpilot-migrate
```

Run `sprintpilot-codebase-map` first on any existing codebase. The other multi-agent skills consume its outputs.

---

## Research & discovery skills

| Skill | When to use |
|-------|-------------|
| `bmad-technical-research` | Research technologies, frameworks, or architectural trade-offs |
| `bmad-domain-research` | Research a business domain or industry |
| `bmad-market-research` | Research market competition and customers |
| `bmad-brainstorming` | Facilitate structured ideation sessions |
| `bmad-advanced-elicitation` | Push the model to reconsider and refine recent output |

---

## QA & test architecture skills

| Skill | When to use |
|-------|-------------|
| `bmad-qa-generate-e2e-tests` | Generate E2E tests for existing features (retroactive coverage) |
| `bmad-testarch-framework` | Initialize test framework (Playwright / Cypress) |
| `bmad-testarch-atdd` | Generate failing acceptance tests (TDD cycle) |
| `bmad-testarch-test-design` | Create system-level or epic-level test plans |
| `bmad-testarch-nfr` | Assess non-functional requirements (performance, security, reliability) |
| `bmad-testarch-ci` | Scaffold CI/CD quality pipeline with test execution |
| `bmad-testarch-trace` | Generate traceability matrix and quality gate decisions |
| `bmad-testarch-test-review` | Review test quality against best practices |
| `bmad-testarch-automate` | Expand test automation coverage across the codebase |
| `bmad-teach-me-testing` | Interactive testing education sessions |

---

## Review skills

| Skill | When to use |
|-------|-------------|
| `bmad-code-review` | Full adversarial code review (3 layers) — mandatory step 5 of per-story loop |
| `bmad-review-adversarial-general` | Cynical critical review of any artifact (specs, designs, docs) |
| `bmad-review-edge-case-hunter` | Exhaustive edge-case and boundary analysis of code or specs |
| `bmad-editorial-review-structure` | Structural editing of documents |
| `bmad-editorial-review-prose` | Copy-editing for communication issues in documents |

---

## Agent role personas

These skills activate an interactive agent persona. They stay in character until given an exit command.

| Skill | Persona |
|-------|---------|
| `bmad-agent-pm` | Product Manager |
| `bmad-agent-analyst` | Business Analyst |
| `bmad-agent-architect` | Solution Architect |
| `bmad-agent-ux-designer` | UX Designer |
| `bmad-agent-dev` | Developer |
| `bmad-agent-qa` | QA Engineer |
| `bmad-agent-sm` | Scrum Master |
| `bmad-agent-tech-writer` | Technical Writer |
| `bmad-agent-quick-flow-solo-dev` | Rapid full-stack solo developer |
| `bmad-party-mode` | All agents in one group discussion |

---

## Document utilities

| Skill | When to use |
|-------|-------------|
| `bmad-shard-doc` | Split a large markdown document into organized smaller files |
| `bmad-index-docs` | Generate or update an `index.md` for a docs folder |
| `bmad-distillator` | Lossless LLM-optimized compression of source documents |

---

## Mandatory sequence per story

| Step | Skill | sprint-status.yaml transition | Definition of Done |
|------|-------|-------------------------------|--------------------|
| 1 | `bmad-create-story` | → `ready-for-dev` | Story file exists, all sections complete |
| 2 | `bmad-check-implementation-readiness` | (no change) | Readiness check passes with no blockers |
| 3 | `bmad-dev-story` (RED) | → `in-progress` | Tests written and **confirmed failing** before any implementation |
| 4 | `bmad-dev-story` (GREEN) | → `review` | All tests pass; pass count stated explicitly (e.g. "9/9 passed") |
| 5 | `bmad-code-review` | (no change) | All review layers complete; findings triaged |
| 6 | Apply `patch` findings + re-run tests | → `done` | All patch tasks completed, tests still green, pass count confirmed |
| 7 | `bmad-retrospective` (per epic, after all stories done) | epic → `done` | Retrospective output saved; epic marked done |

## Task list hygiene

BMad Method skills only update `{implementation_artifacts}/sprint-status.yaml` — they do NOT update the coding agent's task list.

The task list must always reflect the full BMad Method work breakdown. Before starting a story, create a task for **each step** above. Keep the list granular enough that anyone can see exactly where work stands at a glance.

Rules:
- Create all step-tasks for a story **before** starting work on it
- Mark each step-task `in_progress` when you begin it
- Mark each step-task `completed` immediately when done — never batch
- Do not start step N+1 until step N is `completed`
- `sprint-status.yaml` is updated automatically by BMad Method skills — do NOT edit it manually

## Issue and patch tracking

When tests fail **or** code review produces `patch` findings, each issue gets its own task:

- Create one task per distinct issue / patch item (not one task for all issues)
- Name it clearly: e.g. "Fix: `deleteTask` transaction not awaited" or "Patch P1: rollback missing on Ctrl+Down"
- Mark it `in_progress` when fixing, `completed` only after the fix is applied **and the relevant test passes**
- State the test result explicitly: "fixed — 10/10 passed"
- Do not mark the parent step-task `completed` until all its issue/patch tasks are `completed`

## Story file updates

After `bmad-dev-story` completes, fill in the story file's `Dev Agent Record` section:
- List all files changed
- Note any non-obvious decisions or deviations from the spec
- Record final test pass count

## Test result transparency

Every time tests are run, state the result explicitly in your response:
- `N/N passed` — or — `N passed, M failed` with failure details
- Never say "tests pass" without the count
