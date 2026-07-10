# Spike: bmad-dev-auto / bmad-loop vs. Sprintpilot (BMAD v6.10)

**Date:** 2026-07-10 · **Method:** static inspection of `bmad-method@6.10.0` (npm pack), no live LLM run.
**Verdict:** **Stay differentiated now; add `bmad-dev-auto` as an opt-in per-story flow in a future release; never run `bmad-loop` concurrently with Sprintpilot.**

## What shipped in 6.10 (confirmed from the package)

- **`bmad-dev-auto`** (`src/bmm-skills/4-implementation/bmad-dev-auto/`) — *one iteration* of an unattended dev loop: `step-01-clarify-and-route → 02-plan → 03-implement → 04-review`, driven by a **spec-frontmatter `status`** field, with an explicit **HALT protocol** (writes terminal `status` to the spec or a `bmad-dev-auto-result-<slug>.md`), **synchronous** subagents only, and an end-of-run commit to keep the worktree clean. It resolves customization via `python3 _bmad/scripts/resolve_customization.py` (uv/python toolchain).
- **`bmad-loop`** — an **external marketplace module** (`github.com/bmad-code-org/bmad-loop`), not bundled in bmad-method; the successor to the deprecated `bmad-automator`. It is the *orchestrator* that polls `bmad-dev-auto`'s spec frontmatter across iterations.
- **Invoked-surface check:** all six skills Sprintpilot composes (`bmad-create-story`, `bmad-check-implementation-readiness`, `bmad-dev-story`, `bmad-code-review`, `bmad-retrospective`, `bmad-quick-dev`) are present and unmoved.

## Layering: Sprintpilot competes with bmad-loop, not bmad-dev-auto

`bmad-dev-auto` is a **single-iteration implementer** designed to be *driven by* an external orchestrator. `bmad-loop` is that orchestrator. **Sprintpilot already occupies the orchestrator layer** — deterministic FSM, per-phase verifiers (trust boundary), action ledger, exclusion ledger, dependency-aware queue, land-as-you-go git workflow, profiles/session limits, and multi-agent parallelism. None of these exist in `bmad-dev-auto`, and `bmad-loop` is a thin per-project hook/policy runner by comparison. So the strategic relationship is:

- **vs `bmad-loop`:** overlapping orchestrators → **coexist, don't compose.** Running both on one repo means two things committing and advancing state → lock/commit contention. **Guidance: never run `bmad-loop` and `sprint-autopilot-on` on the same repo at the same time.** (No artifact-name collision: dev-auto writes `bmad-dev-auto-result-*.md`; Sprintpilot owns its own files — but the git workflows would fight.)
- **vs `bmad-dev-auto`:** a per-story *implementer* → **composable** as another invoked skill, exactly like `nano` routes a story through `bmad-quick-dev`.

## Recommendation

1. **Now — differentiate + document coexistence.** Keep Sprintpilot's FSM as the sole orchestrator. Add the "don't run bmad-loop concurrently" note to docs (done alongside the memlog note in `docs/ARCHITECTURE.md`). No code change.
2. **Later (opt-in feature) — a `dev-auto` implementation flow.** Mirror the existing `nano → quick-dev` pattern (`_base.yaml` `implementation_flow`, `state-machine.js` NANO_QUICK_DEV row, `adapt.js` escalation): a profile whose per-story flow invokes `bmad-dev-auto` instead of the 7-step cycle, while Sprintpilot keeps owning the queue, verify, git-landing, and retrospective cadence. This gives users BMad's unattended single-shot implementer *under* Sprintpilot's orchestration.

   **Gate the feature on three unknowns a live run must resolve:**
   - **Signal mapping** — `bmad-dev-auto`'s terminal spec-frontmatter `status` / `Auto Run Result` must map cleanly onto a Sprintpilot signal a verifier can check (success / blocked / needs-review), analogous to quick-dev's `severity` escalation.
   - **Git contention** — `bmad-dev-auto` commits at end-of-run to keep the worktree clean; Sprintpilot also commits (land-as-you-go). Confirm one defers to the other (likely: let dev-auto commit, have Sprintpilot's stage-and-commit treat an already-clean tree as a no-op) before wiring it.
   - **Toolchain** — `bmad-dev-auto` calls `python3 _bmad/scripts/resolve_customization.py`; confirm the uv/python dependency is acceptable for the profiles that would opt in.

## Feedback into Track A (compat hardening) — all confirmed against 6.10.0

- **config.toml (A1): confirmed necessary.** The 6.10 installer writes `_bmad/config.toml` + `config.user.toml` as the **primary** config; per-module `_bmad/{mod}/config.yaml` is now legacy. A YAML-only `output_folder` read would silently miss it → the A1 fallback is correct and required.
- **code-review heading (A3): unchanged.** `bmad-code-review/steps/step-04-present.md` still writes a **`### Review Findings`** subsection into the story file. Sprintpilot's probe still matches; the broadened variants are a safe hedge.
- **sprint-status action items (A2): plausible-shape bracketing retained.** The retrospective skill records action items and "updates sprint-status," but the exact `sprint-status.yaml` action-item YAML schema is not pinned in the skill text. Sprintpilot's readers are robust to both bracketed shapes (top-level block and story-adjacent); no code change needed.
- **memlog / `_bmad/scripts` (A4): confirmed.** `bmad-dev-auto` reads from `_bmad/scripts/` (python). Sprintpilot never writes there; the guard test locks that in.

## Addendum: `bmad-quick-dev` (nano) × 6.10

`bmad-quick-dev` is **not** new in 6.10 (it dates to 6.2.1) and Sprintpilot **already integrates it** via the `nano` profile (`implementation_flow: quick` → `NANO_QUICK_DEV` → `bmad-quick-dev` one-shot, with the `fallback_on_tests_fail` / `fallback_on_quick_dev_high_severity` escalation net). Nano **is** the token-saving mode; enable it with `complexity_profile: nano`.

What 6.10 changed and how Sprintpilot relates:

- **Self-syncs sprint-status.** 6.10's `sync-sprint-status.md` makes quick-dev write `sprint-status.yaml` itself through `in-progress` → `review` → `done` (idempotent, never-regress, with an epic backlog→in-progress "lift"). Ownership is unchanged — quick-dev *is* BMad, so `sprint-status.yaml` stays BMad-owned and Sprintpilot still only reads/verifies it. This **aligns** with `verifyNanoQuickDev`, which requires the terminal `done`; a lock-in test asserts a run stalled at the new intermediate `review` state fails.
- **Token scope standard (900–1600 tokens/spec)** is applied **internally** by quick-dev. Under nano, quick-dev reads AC directly from `sprint-status.yaml` (no Sprintpilot-authored spec), so there is no Sprintpilot-side lever to inject — deliberately **not** threading a scope hint through the template avoids drift for zero benefit.

**Broader opportunity (separate plan):** exposing quick-dev as a per-story *fast lane* under full profiles (not just whole-profile nano) is the larger token-saving win but relaxes the mandatory-7-step policy for flagged low-risk stories. Designed separately in `docs/quick-dev-fast-lane-plan.md`.
