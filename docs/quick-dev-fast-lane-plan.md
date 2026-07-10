# Design Plan — Quick-Dev Fast Lane (per-story, under full profiles)

**Status:** APPROVED 2026-07-10 — build tracked as a follow-up. Decisions recorded under "Open decisions" below.
**Goal:** cut tokens/time on real `small`/`medium`/`large` sprints by routing **low-risk stories** through `bmad-quick-dev` (one-shot) while keeping the full 7-step cycle for substantial stories.

## Why (and why it isn't already covered)

Today quick-dev is **all-or-nothing at the profile level**: `nano` runs every story through quick-dev; the full profiles run every story through the mandatory 7-step cycle. Real projects run medium/large, so the biggest untapped saving is *selectively* fast-laning the trivial stories (config tweaks, copy changes, small pure-function additions) that don't warrant RED→GREEN→review→patch.

## The policy tension (must be respected)

`AGENTS.md` / `CLAUDE.md` are explicit: skipping steps — especially RED-before-implementation — is a workflow violation for the full profiles. `nano` is the *sanctioned* exception because it's a deliberate whole-profile opt-in with an escalation net. **The fast lane must be the same kind of sanctioned, opt-in, default-OFF mechanism**, never an implicit relaxation. This is the core decision that needs your sign-off (see Open Decisions).

## Design

Reuse the machinery that already exists; add one new pre-story gate.

1. **Routing (reuse).** The state machine already has the quick path (`NANO_QUICK_DEV` → `bmad-quick-dev`) selected by `implementation_flow === 'quick'` (`state-machine.js:512`). The fast lane makes that a **per-story** decision under a full profile instead of a whole-profile setting: for a story the gate marks `fast`, route it through `NANO_QUICK_DEV`; otherwise the normal 7-step successors. No new skill, no new BMad contract.

2. **Pre-story risk gate (new — the only substantive addition).** A conservative, deterministic classifier that decides `fast | full` **before** implementation, from cheap signals in the story file + plan:
   - AC count, task/subtask count, story-size hint;
   - path allow/deny globs (e.g. allow `docs/**`, `**/*.md`, config; deny `**/auth/**`, `**/migrations/**`, security-tagged epics);
   - explicit per-story/epic tags (`risk: low` / `fast_lane: true` in the plan);
   - default **`full`** on any uncertainty. Model it on `change-size-classifier.js` (which already scales review depth by size/risk) — but note that classifier runs **post-diff**; the gate needs a **pre-implementation** heuristic, so it's a sibling, not a direct reuse.

3. **Escalation net (reuse).** A fast-laned story that fails tests or yields a high-severity finding **falls back to the full 7-step cycle for that story** (re-run), using the existing `escalateOnFailure` (`profile-rules.js`) + `fallback_on_tests_fail` / `fallback_on_quick_dev_high_severity` pattern nano already relies on. So a misclassified story self-corrects rather than shipping unreviewed.

4. **Tests still required (guardrail).** `verifyNanoQuickDev` already requires `tests_run > 0`, `commit_sha`, and sprint-status `done`. The fast lane inherits that gate — a fast-laned story with no tests fails verification. This preserves "tests exist" even when the RED-first ordering is waived.

5. **Config (new knobs, default off).** Under `autopilot` in the profiles/module config:
   ```yaml
   fast_lane:
     enabled: false          # opt-in; full profiles behave exactly as today when off
     max_ac: 3               # stories with more ACs never fast-lane
     allow_globs: ["docs/**", "**/*.md"]
     deny_globs: ["**/auth/**", "**/migrations/**", "**/*secret*"]
     require_story_tag: false # if true, only fast-lane stories explicitly tagged risk:low
   ```

6. **Auditability (reuse "add kinds freely").** Emit a `fast_lane_decision` ledger entry (`{ story_key, decision, reasons[] }`) per story so every routing choice is inspectable — consistent with `action-ledger.js`'s extensible-kinds design.

## Files touched (when built)
- `_Sprintpilot/lib/orchestrator/state-machine.js` — per-story `fast|full` branch at the `implementation_flow` decision point.
- New `_Sprintpilot/lib/orchestrator/fast-lane-gate.js` — the pre-story classifier (pure; unit-tested).
- `_Sprintpilot/lib/orchestrator/profile-rules.js` — extend escalation to cover fast-lane→full per-story fallback.
- `_Sprintpilot/bin/autopilot.js` (`composeRuntimeState`) — call the gate, decorate the phase, emit the ledger entry.
- `_Sprintpilot/modules/autopilot/profiles/_base.yaml` — `fast_lane` defaults (off).
- `AGENTS.md` — document the sanctioned exception (as nano is documented).

## Risks & mitigations
- **Misclassification ships unreviewed code** → conservative default-`full`, deny-globs, tests-required gate, and the escalation net (failure re-runs full cycle).
- **Policy drift** → default OFF; opt-in per project; documented as a first-class sanctioned mode, not a silent skip.
- **Classifier scope creep** → keep it deterministic + cheap (no LLM call); an optional LLM urgency hint can only *downgrade* to full, never upgrade to fast.

## Verification (when built)
- Unit: `fast-lane-gate.js` truth table (AC count, globs, tags, uncertainty→full); state-machine routes `fast` story to `NANO_QUICK_DEV` and `full` story to the 7-step successors; escalation re-runs full on fast-lane failure.
- E2e (opt-in): a mixed sprint where a `docs/**` story fast-lanes and a security story stays full.

## Decisions (signed off 2026-07-10)
1. **RED waiver — APPROVED.** Gate-approved low-risk stories may run quick-dev one-shot (RED-first waived) provided tests still exist and the escalation net re-runs the full cycle on failure. Fast lane is default-OFF, opt-in.
2. **Selection — inferred + tag override.** The classifier infers `fast|full` from signals (AC count, size, allow/deny globs, default `full` on uncertainty); an explicit per-story/epic tag can force `fast` or force `full`.
3. **Packaging — per-mode config knob + install-time prompt.** `fast_lane.enabled` is configurable per profile/mode; the installer **asks the user during install** whether to enable the fast lane, with a short explanation of the token-savings/risk trade-off (default OFF if declined/non-interactive).
