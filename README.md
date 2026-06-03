# Sprintpilot — Autopilot & Multi-Agent Addon for BMad Method

[![npm version](https://img.shields.io/npm/v/@ikunin/sprintpilot.svg?style=flat)](https://www.npmjs.com/package/@ikunin/sprintpilot)
[![npm downloads](https://img.shields.io/npm/dm/@ikunin/sprintpilot.svg?style=flat)](https://www.npmjs.com/package/@ikunin/sprintpilot)
[![License Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg?style=flat)](LICENSE)
[![BMad Method](https://img.shields.io/badge/BMad%20Method-v6.2%2B-green.svg?style=flat)](https://github.com/bmad-code-org/BMAD-METHOD)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.12-brightgreen.svg?style=flat)](https://nodejs.org)
[![Tools](https://img.shields.io/badge/tools-9%20supported-orange.svg?style=flat)](#compatibility)

Sprintpilot drives [BMad Method](https://github.com/bmad-code-org/BMAD-METHOD) v6 sprints to completion autonomously. One slash command runs BMad's full implementation workflow — create-story, readiness check, TDD dev, multi-reviewer code review, patch, retrospective — and the matching git operations (branch, commit, PR, merge) for every story in your sprint, pausing only when a decision genuinely needs you.

> **Independent project.** Sprintpilot is not affiliated with or endorsed by BMad Code, LLC. See [TRADEMARK.md](TRADEMARK.md).
> Migrating from `bmad-autopilot-addon` v1? See [MIGRATION.md](MIGRATION.md).

## What it does

Sprintpilot turns a planned BMad sprint into merged, reviewed, tested code **without you driving each step**. You run one command; it executes BMad Method's full implementation workflow story-by-story — every BMad skill in the mandatory order, every quality gate, and all the git operations your configuration calls for — and pauses only when a real decision needs you.

**Per story it runs the BMad 7-step cycle.** Each skill is invoked *verbatim* from BMad, and each step is gated by an on-disk verifier (the trust boundary between what the LLM claims and what's actually on disk) before the next can begin:

1. **`bmad-create-story`** — writes the next story's spec file (acceptance criteria, tasks) for the next pending story in `sprint-status.yaml`.
2. **`bmad-check-implementation-readiness`** — confirms the story has no blockers before a line of code is written.
3. **`bmad-dev-story` (RED)** — writes the tests *first* and confirms they **fail**. TDD is enforced, not optional — you cannot skip to implementation.
4. **`bmad-dev-story` (GREEN)** — implements until every test passes, with the count stated explicitly (e.g. "9/9 passed").
5. **`bmad-code-review`** — three reviewers run **in parallel** on the diff: **Blind Hunter** (bugs), **Edge Case Hunter** (boundaries), **Acceptance Auditor** (AC coverage). Findings are triaged into block / patch / defer.
6. **Patch + re-test** — every `patch` finding is applied as its own commit and the tests are re-run, still green.
7. **`bmad-retrospective`** — once per epic, after its final story, capturing lessons and listing the PRs ready to merge.

**The git workflow is handled for you, the way you configured it.** Each story gets an isolated worktree + branch (`story/<key>`); changes are staged explicitly (**never** `git add -A`), screened for secrets, committed with a Conventional Commit message, and linted (changed files only). Then — depending on the mode you chose at install — Sprintpilot **opens a stacked PR** (default), **lands the story straight to `main`** as it finishes (land-as-you-go), **merges directly** with no PR, or **reuses your existing feature branch**. CI runs the full test suite as the safety net while local runs stay scoped to affected files.

**`nano` profile** swaps the 7-step cycle for BMad's one-shot `bmad-quick-dev` (Implement → Review → Classify → Commit) — and automatically escalates back to the full cycle if its tests fail or its review flags a high-severity finding.

**You control the loop, not the steps.** The autopilot drives continuously until it has completed `session_story_limit` stories (default 3), the sprint is finished, or it hits one of five genuine blockers — then it halts cleanly with a handoff report. Steer it mid-flight in plain language ("skip this story, the spec is wrong", "pause", "land before the next story") and it maps that to the right action. Under the hood a deterministic Node state machine (`_Sprintpilot/bin/autopilot.js`) decides what runs next and enforces the sequence; the LLM owns in-skill execution and small-judgment calls. Sprintpilot never invents workflows of its own — it composes BMad's skills.

**The benefit:** a planned sprint implements itself overnight with TDD, multi-reviewer code review, and your real git process applied to every story — instead of you hand-running `create-story → readiness → dev → review → patch → commit → PR` dozens of times. You review PRs and answer the occasional genuine question; the autopilot does the mechanical execution faithfully and auditably (every action is logged to an append-only ledger).

## Quick Start

```bash
# 1. Install BMad Method (interactive — pick your tool when prompted)
npx bmad-method install --modules bmm,tea

# 2. Install Sprintpilot (interactive — pick tool + complexity profile)
npx @ikunin/sprintpilot@latest

# 3. In your IDE chat:
/sprint-autopilot-on
```

**What you'll see next.** The orchestrator emits one action at a time and the LLM executes it, announcing each with a plain `NEXT:` line (e.g. `NEXT: 4-1-add-auth · step dev_green · #1 of 6 in epic 4`) so you always know what's running. The first action is `bmad-create-story` for the next pending story in `sprint-status.yaml`, then the cycle above plays out: RED→GREEN tests (scoped to affected files locally — `vitest --changed`, `jest --findRelatedTests`, `pytest --testmon` — while CI runs the full suite), the review pass, patch commits, and the push/PR/merge per your config. It halts cleanly at `session_story_limit` (default 3) with a handoff report; re-run `/sprint-autopilot-on` to continue where it left off.

**Start at a specific story or epic:**

```
/sprint-autopilot-on epic 4
/sprint-autopilot-on stories 3.1, 3.2, 4.5
/sprint-autopilot-on 4-8-realm-wide-matcher-and-session-lock
/sprint-autopilot-on voice identity matcher
```

The skill resolves the natural-language directive against `sprint-status.yaml` and queues the matching stories. Ambiguous matches surface a candidate list — never picks arbitrarily.

**Non-interactive install:**

```bash
npx @ikunin/sprintpilot@latest install --tools claude-code --profile medium --yes
```

Runs on Windows, macOS, and Linux.

## Choose your workflow

One config decision shapes how code reaches `main`. Pick once at install (or edit `_Sprintpilot/modules/git/config.yaml` later):

| Mode | When to use | One PR per | Code reaches `main` |
|---|---|---|---|
| **Stacked PRs** *(default)* | Team workflow where every story needs review before it lands | story | After human PR approval & merge |
| **Land-as-you-go** | Solo / fast-iteration sprint, no end-of-sprint merge marathon | story | Right after each story (CI / review gated) |
| **Direct merge** | Prototype, tutorial, internal tool without CI | — *(no PR opened)* | Right after each story's push |
| **Reuse your branch** | Feature-branch workflow where you already have the branch | sprint | After human PR approval & merge |

All modes use isolated worktrees (`.worktrees/<story-key>/`) so `main` never has half-finished story code. ASCII diagrams of each mode are in [Git workflow](#git-workflow-detailed) below.

## Choose your profile

The right amount of process for a 2-story bugfix is different from a 30-story rebuild. One knob picks the balance:

| Profile | Per-story flow | Branching | Parallel | Use it for |
|---|---|---|---|---|
| `nano` | `bmad-quick-dev` (one-shot) | one PR per epic | n/a | Tiny patch sprints, hot-fix runs |
| `small` | Full 7-step BMad cycle | one PR per story | off | Single-developer projects, ≤ 10 stories |
| `medium` *(default)* | Full 7-step BMad cycle | one PR per story | off | Most sprints — balanced |
| `large` | Full 7-step BMad cycle | one PR per story | **on** (Claude Code) | Multi-epic sprints, 20+ stories |
| `legacy` | Pinned legacy behavior | one PR per story | off | Existing installs that want zero change |

Pick at install: `--profile <name>`. Missing profile defaults to `medium`.

**Nano safety net:** if `bmad-quick-dev` tests fail or its review classifies a finding as `high` severity, the autopilot escalates that session to the full 7-step cycle (session-scoped, never written back to config).

## Running a session

The autopilot scans the host chat for your interjections every turn — you can steer it without learning a command vocabulary:

- *"skip this story, the spec is wrong"* → `skip_story`
- *"close out epic 4 with retro, the remaining stories are deferred"* → `trigger_retrospective`
- *"pause"* → `pause` (halts cleanly; resume with `/sprint-autopilot-on`)
- *"continue, the diff is fine"* → `force_continue` (accept a `verify_rejected` or `resume_divergence`)

The LLM maps your phrasing to the right command + arguments and emits a `user_input` signal. Full command vocabulary in [docs/USAGE.md](docs/USAGE.md#user-commands).

### When it halts

The autopilot drives until one of these conditions is true:

1. **`session_story_limit` reached** (default 3, nano 5) — checkpoints state, prints the handoff report, releases the lock. Re-run `/sprint-autopilot-on` to continue.
2. **Sprint complete** — runs end-of-sprint cleanup, prints the final report. Done.
3. **One of the 5 true blockers** — `creative_user_input_required`, `new_external_dependency`, `security_architectural_decision`, `contradictory_acceptance_criteria`, or 3 consecutive test failures with no forward progress. Halts with a `user_prompt`. Answer it and resume.
4. **Retry budget exhausted on a single phase** — halts with the underlying issue surfaced. Inspect, fix, resume.
5. **You explicitly pause** — `/pause` or any natural-language pause instruction.

Everything else — the autopilot decides, logs the decision in one sentence to `decision-log.yaml`, and moves on.

## Configuration

### By use case

Most projects only ever change a handful of settings. Pick the change you want, edit the listed key:

**I want each story to land on `main` as soon as it's reviewed**
→ `git.merge_strategy: land_as_you_go` (file: `_Sprintpilot/modules/git/config.yaml`)
→ Optional: `git.land_when: ci_pass | ci_and_review | no_wait`

**I want every story reviewed before it lands**
→ Keep the default `git.merge_strategy: stacked`

**I'm working on my own feature branch and want one PR at sprint-end**
→ `git.reuse_user_branch: true`

**I don't want PRs — merge directly to base**
→ `git.push.create_pr: false`

**I want lint failures to halt the sprint until fixed**
→ `git.lint.enabled: true` + `git.lint.blocking: true` (file: `_Sprintpilot/modules/git/config.yaml`)
→ Lint runs `scripts/post-green-gates.js` after `dev_green` verify passes.

**My sprint is a hotfix or 1-2 small changes**
→ `complexity_profile: nano` (file: `_Sprintpilot/modules/autopilot/config.yaml`)

**My sprint is 20+ stories**
→ `complexity_profile: large` — enables parallel story dispatch on Claude Code

**I want the autopilot to run more (or fewer) stories before checkpointing**
→ `autopilot.session_story_limit: <N>` — `0` is unlimited

**I want to inspect worktrees after epic merge instead of auto-cleaning**
→ `git.worktree.cleanup_on_merge: false`

### Reference table

| Setting | File | Default | What it controls |
|---|---|---|---|
| `complexity_profile` | `autopilot/config.yaml` | `medium` | Per-story flow + which optimization layers are enabled |
| `autopilot.session_story_limit` | `autopilot/config.yaml` | `3` (nano: `5`) | Stories per session before checkpoint. `0` = unlimited |
| `autopilot.retrospective_mode` | `autopilot/config.yaml` | `auto` | `auto` / `stop` / `skip` |
| `git.merge_strategy` | `git/config.yaml` | `stacked` | `stacked` / `land_as_you_go` |
| `git.push.create_pr` | `git/config.yaml` | `true` | `false` = direct merge to base |
| `git.reuse_user_branch` | `git/config.yaml` | `false` | Commit every story onto the current user branch |
| `git.land_when` | `git/config.yaml` | `ci_pass` | Land-as-you-go gating: `no_wait` / `ci_pass` / `ci_and_review` |
| `git.land_wait_minutes` | `git/config.yaml` | `30` | Max wait for CI / review before halting |
| `git.branch_prefix` | `git/config.yaml` | `story/` | Prefix for autopilot-created branches |
| `git.lint.enabled` | `git/config.yaml` | `false` | Run post-GREEN lint pipeline |
| `git.lint.blocking` | `git/config.yaml` | `false` | Lint failures reject verify (LLM fix-loops) |
| `git.lint.output_limit` | `git/config.yaml` | `100` | Lines of lint output injected back as context |
| `git.lint.linters.<lang>` | `git/config.yaml` | (auto-detect) | Per-language preference; `[]` disables; `javascript` + `typescript` merge into `js-ts` |
| `git.lock.stale_timeout_minutes` | `git/config.yaml` | `30` | `.autopilot.lock` older than this is auto-taken-over; `0` disables |
| `git.worktree.health_check_on_boot` | `git/config.yaml` | `true` | Halt on orphan worktrees at session start |
| `git.worktree.cleanup_on_merge` | `git/config.yaml` | `true` | Remove `.worktrees/<key>/` after epic merge |
| `ma.enabled` | `ma/config.yaml` | `true` | Enable parallel agent skills |

**Profile-level overrides** — `parallel_stories`, `state_sharding`, `phase_timings`, `cache_shared_reads`, `conditional_boot_work` live in `_Sprintpilot/modules/autopilot/profiles/<profile>.yaml`. Their effective value depends on the active `complexity_profile`.

Full reference: [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Sessions

A long sprint doesn't fit in one LLM context. The autopilot checkpoints every N stories, prints a handoff report, and resumes exactly where it left off in a fresh session.

**Resume divergence detection.** On the next `autopilot start`, the orchestrator fingerprints `_bmad-output/`, `sprint-status.yaml`, and branch HEADs against the fingerprint stamped at the last halt. Two escape paths proceed without manual surgery:

- **External-completion auto-acknowledge** — when the persisted `current_story` is `done` in sprint-status (you merged it manually, hot-fix, UI action), the stale identity is cleared and the next pending story is picked.
- **`--accept-divergence` flag** — catch-all for divergence the auto-path doesn't cover.

**Crash recovery.** On every boot, the autopilot health-checks `.worktrees/`. Orphan worktrees from crashed sessions are detected and surfaced. Stale `.autopilot.lock` files (older than `stale_timeout_minutes`) are auto-taken-over.

**Fresh-context finalize.** When the last story hits `STORY_DONE`, the state machine transitions to `sprint_finalize_pending` instead of running cleanup in the same session. The next `/sprint-autopilot-on` reads the marker, runs deterministic cleanup with a clean context. One short extra session (~60–100 turns) for reliable end-of-sprint hygiene.

Full handoff report format + ledger semantics: [docs/USAGE.md](docs/USAGE.md#handoff-report).

## Skills

**Autopilot:**

| Command | What it does |
|---|---|
| `/sprint-autopilot-on` | Engage autonomous sprint execution |
| `/sprint-autopilot-off` | Disengage and show status |
| `/sprintpilot-update` | Check for updates and install the latest version |

**Sprint planning + visibility** ([reference](docs/sprint-planning.md) · [walkthrough](docs/USAGE.md#sprint-planning--dag-aware-execution-v230)):

| Command | What it does |
|---|---|
| `/sprintpilot-plan-sprint` | Build (or refresh) the authoritative `sprint-plan.yaml` — infers per-epic + cross-epic dependencies from `epics.md` + `architecture.md`, presents the DAG, lets you curate which stories run this sprint, persists atomically. Opt-in; default `autopilot start` still runs sprint-status order. |
| `/sprintpilot-sprint-progress` | One-shot health check — classifies the sprint as `HEALTHY` / `STALLED` / `NEEDS-INPUT` / `EXHAUSTED` / `NO-PLAN` and suggests the next action. |
| `/sprintpilot-dependency-graph` | Render the DAG: `mermaid` (default, inline + `.mmd` file), `graphviz` (`.dot`), `text`, `layers` (JSON), `json`. |

**Multi-agent analysis** ([internals](docs/USAGE.md#multi-agent-skills)):

| Command | What it does |
|---|---|
| `/sprintpilot-codebase-map` | 5-stream brownfield codebase analysis |
| `/sprintpilot-assess` | Tech debt, dependency audit, migration assessment |
| `/sprintpilot-reverse-architect` | Extract architecture document from existing code |
| `/sprintpilot-migrate` | 12-step legacy migration planning |
| `/sprintpilot-research` | Parallel web research fan-out |

## Compatibility

**Tools.** Sprintpilot uses the universal `SKILL.md` format — same skills work everywhere:

| Tool | Directory | Tool | Directory |
|---|---|---|---|
| Claude Code | `.claude/skills/` | Roo Code | `.roo/skills/` |
| Cursor | `.cursor/skills/` | Trae | `.trae/skills/` |
| Windsurf | `.windsurf/skills/` | Kiro | `.kiro/skills/` |
| Gemini CLI | `.agents/skills/` | GitHub Copilot | `.github/copilot/skills/` |
| Cline | `.cline/skills/` | | |

Non-interactive: `--tools <tool1>,<tool2>` (or `all`). Valid values: `claude-code`, `cursor`, `windsurf`, `gemini-cli`, `cline`, `roo`, `trae`, `kiro`, `github-copilot`.

**Git platforms.**

| Platform | CLI | Auto-detect | API fallback |
|---|---|---|---|
| GitHub | `gh` | `github.com` | No |
| GitLab | `glab` | `gitlab.*` | No |
| Bitbucket | `bb` | `bitbucket.org` | Yes (`BITBUCKET_TOKEN`) |
| Gitea | `tea` | Explicit config | Yes (`GITEA_TOKEN` + `base_url`) |

No CLI installed? Falls back to **git_only mode** (direct merge, no PRs).

**Linters** (auto-detected on changed files only). First found per language wins.

| Language | Linters | Language | Linters |
|---|---|---|---|
| Python | ruff, flake8, pylint | Java | checkstyle, pmd |
| JavaScript / TS | eslint, biome | C / C++ | cppcheck, clang-tidy |
| Rust | cargo clippy | C# | dotnet format |
| Go | golangci-lint | Swift | swiftlint |
| Ruby | rubocop | PL/SQL | sqlfluff |
| Kotlin | ktlint, detekt | PHP | phpstan, phpcs |

Multi-language monorepos lint all languages in one pass. Override priority via `git.lint.linters.<lang>: [list]`. See [docs/EXTENDING.md](docs/EXTENDING.md) to add more.

## Troubleshooting

**`resume_divergence` halts on every start.** Sprint-status or the working tree moved between sessions. If the persisted `current_story` is now `done`, the autopilot auto-acknowledges and proceeds — no action needed. For other divergences, pass `--accept-divergence`, or finish the externally-merged story first so sprint-status reflects reality.

**`verify_rejected` on `dev_red`: "no test_files reported".** The verifier auto-detects test files from `git diff` + untracked files by language convention — if it still can't find any, the work didn't produce a test-shaped file. Check the actual changes; re-run `bmad-dev-story` if needed.

**`verify_rejected` on `dev_red`: "test file missing: \<path\>".** The LLM reported a path that doesn't exist. Relative paths resolve against `projectRoot` — verify the file is where the LLM said.

**`verify_rejected` on `story_done`: "git_steps_completed must be true".** The flag is the canonical signal but the verifier also probes `git cat-file -e <commit>` + `git ls-remote --heads origin <branch>`. If both pass, the signal is accepted. If the probe fails, `git push` likely didn't complete — re-run the push step manually.

**Epic won't close out with retrospective.** `remaining_stories_in_epic > 0`. Either mark the deferred stories as `skipped` / `deferred` / `cancelled` / `wont_do` in sprint-status (all are accepted as terminal), or emit `trigger_retrospective` to force-route to RETROSPECTIVE.

**`.autopilot.lock` held but no session is running.** The previous session crashed before releasing. Wait `git.lock.stale_timeout_minutes` (default 30) and the next `autopilot start` will auto-take-over. To skip the wait, `rm .autopilot.lock`.

**LLM keeps inventing pause justifications ("context budget", "natural checkpoint").** The autopilot's `workflow.orchestrator.md` contract forbids LLM-initiated pause. If you're seeing this pattern in your ledger, the LLM isn't reading the contract — `/sprintpilot-update` may help, or check `_Sprintpilot/skills/sprint-autopilot-on/SKILL.md` is current.

More scenarios: [docs/USAGE.md](docs/USAGE.md#troubleshooting).

## How it works

The orchestrator emits one typed Action at a time (`invoke_skill`, `run_script`, `git_op`, `parallel_batch`, `user_prompt`, `halt`) and consumes typed Signals from the LLM (`success`, `failure`, `blocked`, `propose_alternative`, `user_input`, `verify_override`). State writes go through a single chokepoint with critical-key carve-outs for crash recovery; non-critical writes coalesce at story boundaries.

`verify.js` enforces BMad bookkeeping after every `success` signal: acceptance-criteria bullets exist, `[ ]` task boxes are flipped to `[x]`, `commit_sha` + `branch` are reported and verified, review findings are recorded. Auto-recovery paths handle common signal-format omissions (test_files / tests_run / git_steps_completed) by probing the underlying world rather than punishing the LLM for missing echo fields.

Full architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). State-machine diagram, action / signal vocabulary, verify contracts, and the LLM-as-peer protocol.

## Git workflow (detailed)

The 4 modes from [Choose your workflow](#choose-your-workflow) with their full branch graphs.

### Stacked PRs (default)

Each story branches from the previous story's branch and targets it. Reviewers see each story's diff in isolation while the next story is already in progress. When a PR merges on the platform, subsequent PRs auto-retarget.

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

After every `STORY_DONE`, the orchestrator runs a `STORY_LAND` state to merge that story's PR immediately. Each subsequent story branches from the already-merged base, so there's no stack to unwind.

```
main ── story/1-1 ──→ PR #42 ──→ ✓ CI / review ──→ merge ──→
   │                                                         ╲
   ├── story/1-2 ──→ PR #43 ──→ ✓ CI / review ──→ merge ──→  ╲
   │                                                          ╲
   └── story/1-3 ──→ PR #44 ──→ ✓ CI / review ──→ merge ──→  done
```

Knobs: `git.land_when` (`no_wait` / `ci_pass` / `ci_and_review`), `git.land_wait_minutes` (default 30). Rebase recovery is automatic; conflicts halt with a `user_prompt`.

Trade-off: cleaner history, no end-of-sprint merge marathon — but each story blocks on CI before the next starts.

### Direct merge (no PR)

Stories merge straight into the base after push — no PR, no human review gate. Use only for prototypes / tutorials / dev branches.

```
main ── story/1-1 ──→ merge ── story/1-2 ──→ merge ── story/1-3 ──→ merge
```

### Reuse your branch

You create the branch; the autopilot detects it on boot and commits every story directly onto it. No `story/*` branches. One PR opens against `base_branch` at sprint-end.

```
main ─────────────────────────────────────────────────
  │
  └── feature/payments-rewrite (your branch, you created it)
        ├── feat(1): story 1-1 ─→ commit
        ├── feat(1): story 1-2 ─→ commit
        └── …                  ─→ push + PR (→ main, at sprint-end)
```

### Branch naming

- Story granularity (default): `<branch_prefix><story-key>` → `story/1-3-add-auth`
- Epic granularity (nano): `<branch_prefix>epic-<epic-id>` → `story/epic-1`
- Reuse mode: no autopilot branches; your branch is used as-is

### Pre-commit safety

Before every commit, deterministic Node scripts run against staged files:

| Check | What it does |
|---|---|
| Explicit staging | `git add -- file1 file2` — never `-A`/`-u`/`.`. Cross-referenced against the story's `## File List`. |
| Secrets scan | Greps for `API_KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `aws_access`, `private_key`. WARN severity; allowlist via `.secrets-allowlist`. |
| File size | Rejects files over `staging.max_file_size_mb` (default 1). |
| Binary detection | Warns on binary files. |
| Gitignore check | Verifies `.gitignore` covers `.autopilot.lock` and `.claude/.sprintpilot-backups/`. |

Decision matrix and additional knobs: [`modules/git/branching-and-pr-strategy.md`](_Sprintpilot/modules/git/branching-and-pr-strategy.md).

## Multi-Agent Intelligence

Beyond the autopilot, multi-agent skills launch parallel subagents for tasks that benefit from diverse perspectives.

**`/sprintpilot-codebase-map`** — 5 parallel agents scan an existing codebase: stack, architecture, quality, concerns, integrations. Output under `_bmad-output/codebase-analysis/`. Inspired by [GSD's map-codebase](https://github.com/gsd-build/get-shit-done) — see [NOTICES.md](NOTICES.md).

**`/sprintpilot-assess`** — Dependency auditor (CVEs), debt classifier (prioritized), migration analyzer. Output: prioritized findings with severity / confidence / effort.

**`/sprintpilot-reverse-architect`** — Component mapper + data flow tracer + pattern extractor. Output: BMad Method-compatible `architecture.md` that feeds `bmad-create-epics-and-stories`.

**`/sprintpilot-migrate`** — 12-step migration planner with 4 subagent fan-outs. Strategy, compatibility matrix, phased roadmap, per-component cards, data + API migration, risk matrix.

**`/sprintpilot-research`** — Fan out research across multiple topics in parallel; synthesized into a unified report.

Skill internals + output schemas: [docs/USAGE.md](docs/USAGE.md#multi-agent-skills).

## Requirements

- [BMad Method](https://github.com/bmad-code-org/BMAD-METHOD) v6.2.1+ (tested through v6.8.0)
- Node.js 20.12+
- A supported AI code agent (see [Compatibility](#compatibility))
- Git repository with at least one commit
- Platform CLI for PR creation (optional — falls back to git_only mode)
- BMad's own runtime prerequisites if you run a recent BMad: 6.3.0+ skill hooks invoke `_bmad/scripts/resolve_customization.py` (needs Python 3.10+ and [`uv`](https://github.com/astral-sh/uv)). Core skill logic still runs without them, but terminal `on_complete` hooks will fail.

## Documentation

- [Installation Guide](docs/INSTALLATION.md)
- [Usage Guide](docs/USAGE.md) — handoff report, user commands, multi-agent skill internals, troubleshooting
- [Sprint Planning Reference](docs/sprint-planning.md) — focused guide to `/sprintpilot-plan-sprint`: curation, validation, mid-flight commands, companion skills
- [Architecture](docs/ARCHITECTURE.md) — state machine, action / signal vocabulary, verify contracts
- [Configuration Reference](docs/CONFIGURATION.md) — every setting, default, profile override
- [Extending (Platforms & Languages)](docs/EXTENDING.md)
- [Contributing](docs/CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## License

Apache 2.0
