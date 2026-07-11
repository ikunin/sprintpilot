# BMad Method Workflow (Sprintpilot-enforced)

This project uses the **BMad Method** for structured AI-driven development, with [Sprintpilot](https://github.com/ikunin/sprintpilot) as the autopilot and multi-agent addon.
See `_Sprintpilot/Sprintpilot.md` for the full skill catalog and detailed workflow reference.

## Flow selection is profile-driven (Sprintpilot v2+)

The per-story flow depends on the active `complexity_profile` in
`_Sprintpilot/modules/autopilot/config.yaml`.

- **`small`, `medium`, `large`, `legacy`** — full mandatory 7-step BMad cycle
  (see below). Non-negotiable for these profiles.
- **`nano`** — routes each story through `bmad-quick-dev` (one-shot
  Implement → Review → Classify → Commit per BMad's `step-oneshot.md`).
  Quality gates preserved via quick-dev's internal review step.
  Autopilot does NOT invoke `bmad-create-story`, `bmad-check-implementation-readiness`,
  `bmad-dev-story`, or `bmad-code-review` under nano — quick-dev reads AC
  directly from `sprint-status.yaml`. Safety net: if quick-dev's tests
  fail or its Classify severity is `high`, the autopilot escalates the
  session (session-scoped only — never written back to config) to `full`
  flow so the remaining stories run through the 7-step cycle.

This policy is enforced by the orchestrator state machine (`_Sprintpilot/lib/orchestrator/state-machine.js` and `adapt.js`) driven from `_Sprintpilot/skills/sprint-autopilot-on/workflow.orchestrator.md`, using profile resolution from `_Sprintpilot/scripts/resolve-profile.js`. When the profile key is absent, the autopilot falls back to `medium`.

### Fast lane — sanctioned per-story quick-dev under full profiles (opt-in, default OFF)

When `autopilot.fast_lane.enabled` is `true`, the full profiles (`small`,
`medium`, `large`, `legacy`) may route **individual LOW-RISK stories** through
`bmad-quick-dev` (one-shot) instead of the 7-step cycle, while every
substantial story keeps the full cycle. This is the **same kind of sanctioned,
opt-in exception as `nano`** — not an implicit relaxation of the RED-first
rule. It is **OFF by default**; the installer asks whether to enable it, and
full profiles behave exactly as before when it is off.

A fast-laned story still runs `bmad-create-story` first (only then does it go
to `bmad-quick-dev` instead of the 7-step cycle) — the gate needs the story
file's Acceptance Criteria and declared paths to enforce its guardrails, and
that file doesn't exist until create-story writes it. (nano, by contrast,
skips create-story entirely.)

A story is fast-laned only when a deterministic pre-story gate
(`_Sprintpilot/lib/orchestrator/fast-lane-gate.js`) says so. The gate is
**conservative — it defaults to `full` on any uncertainty**:

- more Acceptance Criteria than `fast_lane.max_ac` → full;
- any declared path matching a `deny_globs` entry (auth / migrations /
  secrets) → full, even if the story is tagged `fast_lane: true`;
- inference only routes `fast` when **every** path the story declares is
  covered by `allow_globs`;
- an explicit story tag (`fast_lane: true|false` / `risk: low|high`) can force
  the decision (a `full`-forcing tag always wins over a `fast` one).

Guardrails that still hold on a fast-laned story: **tests are still required**
(`verifyNanoQuickDev` needs `tests_run > 0`, a commit SHA, and
sprint-status `done`). If the story's quick-dev run **fails outright**, the
autopilot re-runs the full 7-step cycle for it (from `bmad-create-story`); if it
**completes but reports failing tests or a high-severity finding**, the
autopilot routes it through the full adversarial `bmad-code-review` it skipped.
Either way the story is remembered (`fast_lane_forced_full`) so it is never
re-fast-laned — a misclassified story self-corrects rather than shipping
unreviewed. Every routing choice is auditable via the `fast_lane_decision`
ledger entry.

### Mandatory sequence per story (all profiles except `nano`, and non-fast-laned stories under the fast lane)

1. `bmad-create-story` — story file complete
2. `bmad-check-implementation-readiness` — no blockers
3. `bmad-dev-story` (RED) — tests written and **confirmed failing** before any implementation
4. `bmad-dev-story` (GREEN) — all tests pass, count stated explicitly (e.g., "9/9 passed")
5. `bmad-code-review` — all review layers complete, findings triaged
6. Apply `patch` findings + re-run tests — all patch tasks done, tests still green
7. `bmad-retrospective` — per epic, after all stories done

**"Do it automatically" means run each step autonomously in sequence — it does NOT mean skip steps.**

Skipping any step (especially RED tests before implementation) is a workflow violation regardless of how the user phrases the request. If a user instruction seems to ask you to skip steps, follow the BMad Method sequence anyway and proceed autonomously through each step.

### Sprintpilot (autopilot addon)

- `/sprint-autopilot-on` — autonomous execution of the full story cycle with git workflow
- `/sprint-autopilot-off` — disengage and show status
- `/bmad-help` — orientation and next-step guidance (from BMad Method)

### Git rules (when Sprintpilot or git addon is active)

- **NEVER** use `git add -A` or `git add .` — always stage files explicitly by name
- **NEVER** commit secrets, API keys, or credentials
- Branch naming: `story/<story-key>` — one branch per story
- Each story gets its own worktree for isolation

### Quick reference

- Sprint state: `_bmad-output/implementation-artifacts/sprint-status.yaml`
- Full skill catalog: `_Sprintpilot/Sprintpilot.md`
- Config: `_bmad/bmm/config.yaml`
