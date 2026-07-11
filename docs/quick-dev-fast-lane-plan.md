# Design Plan — Quick-Dev Fast Lane (per-story, under full profiles)

**Status:** IMPLEMENTED 2026-07-10 (default OFF). Shipped as `fast-lane-gate.js` + profile/state wiring + installer prompt; see AGENTS.md "Fast lane" section. Decisions recorded under "Decisions" below.
**Goal:** cut tokens/time on real `small`/`medium`/`large` sprints by routing **low-risk stories** through `bmad-quick-dev` (one-shot) while keeping the full 7-step cycle for substantial stories.

## Why (and why it isn't already covered)

Today quick-dev is **all-or-nothing at the profile level**: `nano` runs every story through quick-dev; the full profiles run every story through the mandatory 7-step cycle. Real projects run medium/large, so the biggest untapped saving is *selectively* fast-laning the trivial stories (config tweaks, copy changes, small pure-function additions) that don't warrant RED→GREEN→review→patch.

## The policy tension (must be respected)

`AGENTS.md` / `CLAUDE.md` are explicit: skipping steps — especially RED-before-implementation — is a workflow violation for the full profiles. `nano` is the *sanctioned* exception because it's a deliberate whole-profile opt-in with an escalation net. **The fast lane must be the same kind of sanctioned, opt-in, default-OFF mechanism**, never an implicit relaxation. This is the core decision that needs your sign-off (see Open Decisions).

## Design

Reuse the machinery that already exists; add one new pre-story gate.

1. **Routing (reuse, per-story).** The fast lane makes the quick path (`NANO_QUICK_DEV` → `bmad-quick-dev`) a **per-story** decision under a full profile instead of a whole-profile setting. **Crucially, a fast-laned story runs `bmad-create-story` FIRST, then routes to quick-dev** — `PREPARE_STORY_BRANCH → CREATE_STORY → NANO_QUICK_DEV` — not straight to quick-dev like nano. This is not cosmetic: the pre-story gate's guardrails (deny-globs, `max_ac`, story-file tags, path inference) can only read the story's Acceptance Criteria / declared paths from the story `.md`, **which does not exist until `bmad-create-story` writes it** (sprint-status carries only statuses, and quick-dev reads AC from there). So the routing decision that actually enforces the safety gates is taken at the `CREATE_STORY → successor` transition, with the real file on disk. nano (whole-profile quick, `fast_lane_active` false) still skips create-story per AGENTS.md; the two are distinguished by the `fast_lane_active` flag on the effective profile. No new skill, no new BMad contract — just conditional `PREPARE_STORY_BRANCH` / `CREATE_STORY` successors keyed on `fast_lane_active`.

2. **Pre-story risk gate (new — the only substantive addition).** A conservative, deterministic classifier that decides `fast | full` from cheap signals in the story file + plan (evaluated once the story file exists, at the `CREATE_STORY → successor` transition; at earlier phases with no file it defaults `full`, which is why fast-lane candidates route through create-story first):
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
- **Misclassification ships unreviewed code** → conservative default-`full`, deny-globs, tests-required gate, and the escalation net (any quick-dev failure OR success-with-failing-tests/high-severity re-runs the full cycle).
- **Policy drift** → default OFF; opt-in per project; documented as a first-class sanctioned mode, not a silent skip.
- **Classifier scope creep** → keep it deterministic + cheap (no LLM call); an optional LLM urgency hint can only *downgrade* to full, never upgrade to fast.
- **Inference under-triggers (known limitation)** → allow-glob *inference* only fires when a story positively declares the files it touches (inline `code-span` paths or a "File List / Modified Files / Source Tree / …" section). BMad story specs don't always list paths pre-implementation, so in practice most fast-laning comes from explicit story tags (`fast_lane: true` / `risk: low`). This is intentional (safe under-triggering beats unsafe over-triggering), but means the token savings scale with how well stories are tagged / list their files.

## Configuring fast/full per story or epic

Three ways to set the routing for a specific story or epic (full examples + precedence table in [CONFIGURATION.md → Quick-Dev Fast Lane](CONFIGURATION.md#quick-dev-fast-lane)):

1. **Explicit mark** (highest authority, durable) — `autopilot fast-lane <story-key | epic-<id>> <fast|full|auto>`, the plain-language `set_fast_lane` chat command, or `/sprintpilot-plan-sprint` Step 11c. Persists in the Sprintpilot-owned, clobber-resistant `fast-lane-overrides.json` (module: `fast-lane-overrides.js`; mirrors `excluded-stories.js`), which **survives a plan re-derivation** unlike tags placed in `sprint-plan.yaml`. A `fast` mark beats the gate's deny-globs / `max_ac` / tags and applies even when the lane is globally off; a story mark beats its epic mark; only `fast_lane_forced_full` (a story the escalation net bounced after it actually failed) still overrides a `fast` mark, preventing a fast→fail→fast loop.
2. **Story-file tag** — `fast_lane: true|false` / `risk: low|high` in the story `.md`. Subject to the gate's deny-globs + `max_ac` (a `fast` tag can't wave in a large or auth-touching story — unlike a mark).
3. **Epic/plan tag** — a `fast_lane` / `risk` field on the epic (cascades) or story entry in `sprint-plan.yaml`. Same gate guardrails; may be regenerated by a re-plan.

Precedence: `fast_lane_forced_full` → **explicit mark** → (gate) full-tag → deny-glob → `max_ac` → fast-tag (story-file beats epic) → `require_story_tag` → inference → default `full`.

## Implementation notes (as built)
- Routing is per-story via `deriveEffectiveProfile` (`autopilot.js`) flipping `implementation_flow → quick` + `fast_lane_active` for a `fast` story (flip gated to story-start phases so it can't happen mid-full-cycle). The state machine routes a `fast_lane_active` story `PREPARE_STORY_BRANCH → CREATE_STORY → NANO_QUICK_DEV` (create-story first — see Design §1), whereas nano goes straight to `NANO_QUICK_DEV`. `FULL_FLOW_SUCCESSORS[CREATE_STORY]` lists `NANO_QUICK_DEV` as the fast-lane edge.
- The escalation net covers **both** failure shapes, but re-enters at different phases because they leave the story in different states:
  - **Hard failure** (`status: failure`, `adapt.handleFailure`): quick-dev failed, the story is **not** `done`, so re-run the full 7-step cycle from `CREATE_STORY` over the committed-but-deficient code.
  - **Success-but-flagged** (`status: success` with failing tests / high severity, `adapt.handleSuccess` via `escalateOnFailure`): quick-dev completed and marked the story `done` (verifyNanoQuickDev requires it), so re-enter at `CODE_REVIEW` — the adversarial review the fast lane skipped. Routing to `CREATE_STORY` here would be a no-op: `composeRuntimeState` rejects+skips a `done` story at `CREATE_STORY` (that phase isn't in its done-rejection skip-set), whereas `CODE_REVIEW` **is**, so the story survives re-resolution and actually gets reviewed.
  - Both record the story in `fast_lane_forced_full` so the gate keeps it full on re-derivation.
- **Not-done-with-failing-tests halts (doesn't escalate).** The success-but-flagged escalation only fires after `verifyNanoQuickDev` passes, which requires the story marked `done`. A quick-dev signal that claims success with `tests_failed > 0` but has NOT marked the story `done` fails verify → retries → exhausts `verify_reject_budget` → a generic `user_prompt` halt for a human. That's safe (it never ships), but the tailored fast-lane escalation messaging doesn't fire for that specific shape — the story stops for human review instead.
- **Decision lock at `NANO_QUICK_DEV`.** `deriveEffectiveProfile` does NOT re-read the story file once the story is at `NANO_QUICK_DEV`: quick-dev appends a "File List" of the code it wrote (paths outside `allow_globs`), and re-classifying would flip the gate to `full` and clear `fast_lane_active` at the exact moment the escalation guards need it. A full profile can only reach `NANO_QUICK_DEV` via the fast lane, so the decision is locked to quick there (forced-full still wins).
- The bounce re-enters at `CREATE_STORY` even though quick-dev already committed code. To keep `DEV_RED` coherent (it would otherwise read as greenfield "tests-first" against existing code), the escalation sets `state.escalation_note` — surfaced as `profile_specific_notes` in **every** phase's skill template — reframing the re-run as a *rigor pass over known-deficient committed code*: DEV_RED tests encode the ACs + the observed failure and are expected to fail against the current implementation, then DEV_GREEN fixes. The note is story-scoped and cleared at the next new-story boundary.
- A fast-laned `nano_quick_dev` phase is wall-clock budgeted under full profiles (`PHASE_TIMEOUT_DEFAULTS_BY_PROFILE`: small 20 / medium 30 / large 60 min).

## Verification (built)
- Unit: `fast-lane-gate.js` truth table (AC count, globs, tags, uncertainty→full); `escalateOnFailure` fast-lane origin; `adapt` routing (success-flagged AND hard-failure both re-run full + record forced-full; clean success advances to STORY_DONE without marking the sprint complete); `flatToProfile` fast_lane config threading; installer `applyFastLaneEnabled` + patch/read round-trip.
- Integration: `deriveEffectiveProfile` against a tmp project — a `docs/**` story routes quick, a security story stays full, forced-full is sticky, and the `fast_lane_decision` ledger entry is emitted (deduped per story).

## Decisions (signed off 2026-07-10)
1. **RED waiver — APPROVED.** Gate-approved low-risk stories may run quick-dev one-shot (RED-first waived) provided tests still exist and the escalation net re-runs the full cycle on failure. Fast lane is default-OFF, opt-in.
2. **Selection — inferred + tag override.** The classifier infers `fast|full` from signals (AC count, size, allow/deny globs, default `full` on uncertainty); an explicit per-story/epic tag can force `fast` or force `full`.
3. **Packaging — per-mode config knob + install-time prompt.** `fast_lane.enabled` is configurable per profile/mode; the installer **asks the user during install** whether to enable the fast lane, with a short explanation of the token-savings/risk trade-off (default OFF if declined/non-interactive).
