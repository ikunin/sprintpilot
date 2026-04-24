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
| `autopilot.session_story_limit` | `3` (nano: `5`) | integer ≥ 0 | Stories fully implemented per autopilot run before checkpoint. `0` = unlimited. Retuned in 2.0.1 after context-rot exposure on longer sessions; nano is cheaper per story so fits a higher cap. |
| `autopilot.retrospective_mode` | `auto` | `auto` / `stop` / `skip` | How epic-end retrospectives are handled (see below). |

`retrospective_mode` options:
- **`auto`** *(default)* — autopilot writes a deterministic retrospective artifact from `sprint-status.yaml` + `decision-log.yaml`, then continues. Single pass, no external skill call, safe under every CLI.
- **`stop`** — autopilot pauses at epic completion. Run `/bmad-retrospective` interactively, then re-run `/sprint-autopilot-on` to resume. Use this when you want the full multi-persona discussion as part of your process.
- **`skip`** — no retrospective artifact is written. **Not recommended** — you lose the epic-level learning record.

Both settings are prompted during `sprintpilot install` (interactive mode) with existing values as defaults, so reinstalls preserve your choices.

### Mandatory fresh-context finalize

Independent of `session_story_limit`, the autopilot forces an extra session at end-of-sprint. When step 2 detects all stories are done, it writes `current_bmad_step = sprint-finalize-pending` to the state file and halts — it does **not** run step 10 (cleanup) in that session. The next `/sprint-autopilot-on` invocation reads the marker in step 1 and jumps directly to step 10 with a clean context window, where seven CRITICAL deterministic script calls run the cleanup (checkbox marking, worktree removal, lock release, artifact commit, sprint-complete state, verification, state-file delete).

This behavior is not configurable: it's a mitigation for late-session instruction decay that was reliably dropping cleanup actions in long single-session runs. The extra session is short (typically ~60-100 turns, under $2). See `_Sprintpilot/skills/sprint-autopilot-on/workflow.md` step 2 and step 10 for the exact protocol.

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
| `sprintpilot-code-review` | 3 | Parallel adversarial code review (Blind Hunter + Edge Case + Acceptance) |
| `sprintpilot-codebase-map` | 5 | Brownfield codebase mapping (stack, architecture, quality, concerns, integrations) |
| `sprintpilot-assess` | 3 | Tech debt assessment (dependency audit, debt classification, migration analysis) |
| `sprintpilot-reverse-architect` | 3 | Extract architecture from existing code (components, data flow, patterns) |
| `sprintpilot-migrate` | 4 | Full migration planning — 12 steps from current stack to target stack |
| `sprintpilot-research` | N | Parallel research fan-out with web search |
| `sprintpilot-party-mode` | 2-3 | Multi-persona discussion (architect, PM, QA, etc. debating in parallel) |

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
