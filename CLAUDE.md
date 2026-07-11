# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Two modes of operation in this repo

Sprintpilot is an autopilot / multi-agent addon for the BMad Method. There are two distinct contexts in which Claude Code is invoked here:

- **Using Sprintpilot to drive a sprint** (running stories through the BMad 7-step cycle). The runtime contract is in `@AGENTS.md` below — mandatory step sequence, profile-driven flow selection, in-sprint git rules.
- **Developing on Sprintpilot itself** — editing the orchestrator, scripts, skills, tests, docs. **The 7-step BMad cycle does NOT apply in this mode**: we are editing Node code, not running a BMad sprint. The guidance in *this* file is for that case.

If the task touches `_Sprintpilot/`, `bin/`, `lib/`, `tests/`, `docs/`, `CHANGELOG.md`, or the release flow — it's dev mode.

## Test, lint, release

Tests live under `tests/` and have their own `package.json` + `node_modules`. Run from `tests/`:

```bash
# fast suite (unit + scripts) — what to run during dev
cd tests && npm test
# or equivalently
cd tests && npx vitest run unit/ scripts/

# single file
cd tests && npx vitest run unit/orchestrator/excluded-stories.test.ts

# single test by name pattern
cd tests && npx vitest run path/to/file.test.ts -t "matching name"

# LLM-driven e2e (slow, costs tokens, opt-in)
cd tests && npm run test:e2e:nano        # nano profile
cd tests && npm run test:e2e:live:full   # full e2e matrix
```

Lint is Biome (`biome.json`). There is **no `npm run lint` script** — call biome directly:

```bash
npx biome check --write <changed-files>   # auto-fix on touched files
npx biome check <files>                   # read-only check
```

Biome's scope is `bin/**`, `lib/**`, `_Sprintpilot/scripts/**`, `_Sprintpilot/lib/runtime/**`, `tests/**/*.ts`. The big orchestrator surface under `_Sprintpilot/lib/orchestrator/` is intentionally **not** in biome's scope — those files are CommonJS hand-formatted; lint changes there manually rather than waiting on biome to gate them.

Releases go through `.claude/skills/release/workflow.md` (invoke `/release`). The workflow bumps `package.json` + `_Sprintpilot/manifest.yaml`, prepends a `CHANGELOG.md` entry, commits `chore: release vX.Y.Z`, pushes `main`, and runs `gh release create vX.Y.Z --title "vX.Y.Z" --generate-notes`. npm publish then happens automatically via a GitHub Action on the release event. The README title uses a dynamic npm badge — no version string to update there.

## Architecture: pure FSM + impure CLI edge

The orchestrator separates **decision logic** (deterministic, pure, fully tested) from **I/O** (impure CLI). Decide which layer a change belongs in *before* editing.

### Pure layer — `_Sprintpilot/lib/orchestrator/`

- `state-machine.js` — phase enum and transition table (`CREATE_STORY → CHECK_READINESS → DEV_RED → DEV_GREEN → CODE_REVIEW → PATCH_APPLY → PATCH_RETEST → STORY_DONE → STORY_LAND? → EPIC_BOUNDARY_CHECK → RETROSPECTIVE?`, plus `NANO_QUICK_DEV` for nano). Action emitters: `invoke_skill` / `git_op` / `run_script` / `user_prompt` / `halt`.
- `adapt.js` — `interpretSignal` / `advanceState`: `(state, signal) → (newState, sideEffects)`. State mutation is pure; side-effects are descriptors the CLI dispatches.
- `verify.js` — per-phase verifiers, the trust boundary between the LLM's claim and on-disk artifacts.
- `state-store.js` — the **single chokepoint** for `autopilot-state.yaml` writes. `coalesce_state_writes` splits CRITICAL_KEYS (write-through) from non-critical (buffered, flushed at story boundary). Atomic write via tmp + rename. **Deep-merges; cannot delete a nested key** — that constraint is why `excluded-stories.json` is its own file rather than a field on `autopilot-state.yaml`.
- `action-ledger.js` — append-only JSONL audit at `_bmad-output/implementation-artifacts/ledger.jsonl`. Unknown kinds are tolerated by consumers; add new kinds freely.
- `excluded-stories.js` — Sprintpilot-owned authoritative exclusion ledger. Resolver consults it; `apply_user_commands` populates from `skip_story` / `remove_from_sprint`; `reconcileFromSprintStatus` folds sprint-status terminal-non-done values in. Designed to survive BMad-side clobbers.
- `fast-lane-gate.js` — pure, deterministic pre-story classifier for the opt-in quick-dev fast lane (default OFF). `(story signals + fast_lane config + forced-full ledger) → fast|full`, conservative (defaults `full`). The CLI (`deriveEffectiveProfile` in `autopilot.js`) reads the story file + `fast_lane_*` profile fields and flips `implementation_flow` to `quick` per-story when the gate says `fast`; a fast-laned quick-dev failure escalates via `escalateOnFailure` (`escalated_from: 'fast_lane'`) and records the story in `state.fast_lane_forced_full` so it re-runs the full cycle and never re-fast-lanes.
- `fast-lane-overrides.js` — Sprintpilot-owned, durable per-story/epic `fast|full` marks (`fast-lane-overrides.json`), clobber-resistant like `excluded-stories.js`. The highest-authority routing signal: `deriveEffectiveProfile` consults it before the gate (a `fast` mark beats deny-globs/size/tags and applies even when the lane is off; `fast_lane_forced_full` still wins to prevent loops). Set via the `set_fast_lane` UserCommand, the `autopilot fast-lane` CLI, or `/sprintpilot-plan-sprint`.
- `user-commands.js` / `user-command-applier.js` — validates and applies `UserCommand`s. The applier is pure: `(state, profile, commands) → { newState, newProfile, sideEffects }`. The CLI runs the side-effects.
- `sprint-plan.js` + `_Sprintpilot/scripts/sprint-plan.js` — dependency-aware plan and the mirror parser. `TERMINAL_STATUSES` is duplicated across `autopilot.js` and `sprint-plan.js`; tests assert the mirror.

### Impure layer — `_Sprintpilot/bin/autopilot.js`

The CLI edge. A single ~5000-line file. Public entry points:

- `cmdStart` — boot, acquire lock, resume. Runs the `land_as_you_go` predecessor guard + auto-recovery.
- `cmdNext` — emit the next-action JSON. Runs `composeRuntimeState` → `adapt.nextAction`.
- `cmdRecord` — accept a signal, run `adapt.interpretSignal` + `advanceState`, persist, dispatch side-effects via `applySideEffects`.

**`composeRuntimeState`** is the most consequential function: it reads sprint-status, validates persisted `current_story` (via `persistedStoryRejectionReason`), drops poisoned `story_queue` entries, falls back to `resolveNextStoryKey(projectRoot, { preferEpic })` when needed, recomputes `remaining_stories_in_epic`, applies catch-all guards, and decorates phase-bound fields. **Read this before changing any resolver behavior.**

**`applySideEffects`** dispatches the descriptors emitted by `adapt` (`plan_add_stories` / `plan_remove_stories` / `record_flaky_tests` / …). The `apply_user_commands` case is also where the exclusion-ledger record/remove happens.

### Skill orchestration

Each BMad skill Sprintpilot invokes lives in a phase row of `state-machine.js`'s action map: `bmad-create-story`, `bmad-check-implementation-readiness`, `bmad-dev-story` (red / green / patch / rereview variants), `bmad-code-review`, `bmad-retrospective`, `bmad-quick-dev`. The LLM-facing orchestrator contract is `_Sprintpilot/skills/sprint-autopilot-on/workflow.orchestrator.md`. **Sprintpilot never invents BMad-level workflows** — it composes upstream skills verbatim.

`bmad_compatibility` floor is `>=6.2.1`, tested through BMad Method v6.8.0. When changing anything that touches an upstream contract, check `docs/` and the recent CHANGELOG entries for the rationale — many decisions are about staying composable across a moving target.

## File ownership

Knowing who writes what is critical to avoid stepping on BMad's domain:

| File | Owner | Notes |
|---|---|---|
| `sprint-status.yaml` | BMad | Sprintpilot only READS. A BMad re-plan can reset values — that's why the exclusion ledger exists. |
| `<story-key>.md` story files | BMad (`bmad-create-story`) | Sprintpilot reads AC and tasks/subtasks for verifiers. |
| `autopilot-state.yaml` | Sprintpilot | Volatile per-session state; deep-merged, never wholesale-replaced. |
| `ledger.jsonl` | Sprintpilot | Append-only audit. |
| `excluded-stories.json` | Sprintpilot | Durable exclusion ledger; replace-on-write semantics. |
| `fast-lane-overrides.json` | Sprintpilot | Durable per-story/epic fast\|full marks; replace-on-write; clobber-resistant (survives re-plan). |
| `sprint-plan.yaml` | Sprintpilot | Dependency-aware plan; validated against the DAG. |
| `decision-log.yaml` | Sprintpilot | Per-phase decisions audit. |
| `flaky-quarantine.yaml` | Sprintpilot | Flaky test flip counts + quarantine. |

`_bmad/` and `_bmad-output/` are both **gitignored** — only Sprintpilot's source tree is tracked here.

## Test conventions

- `tests/unit/` — pure-logic tests against the orchestrator lib + scripts.
- `tests/scripts/` — CLI-level integration (subcommands, harness).
- `tests/e2e/` — LLM-driven end-to-end (opt-in via `RUN_LLM_E2E=1`).
- Each test creates its own tmpdir via `mkdtempSync` and cleans up in `afterEach`.
- Importing CJS modules from TS tests uses the `// @ts-expect-error — CommonJS module` pattern — copy from an existing test.
- Story-key fixtures use neutral abstractions (`1-1-a`, `<story-key>`, `epic-N`). Do not introduce names tied to any specific downstream consumer in fixtures, comments, or CHANGELOG entries.

## Git rules in dev mode

`@AGENTS.md` defines the in-sprint git rules; the strict ones still apply when developing on this repo:

- Never `git add -A` / `git add .` — stage explicitly by name.
- Don't force-push `main`; don't skip hooks.
- Conventional Commits (`feat:` / `fix:` / `docs:` / `chore:`). Release commits are `chore: release vX.Y.Z` (enforced by the release skill).

---

@AGENTS.md
