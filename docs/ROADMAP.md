# Sprintpilot Roadmap

Forward-looking plan for Sprintpilot releases. Themed bundles, not
one-feature-per-release. Each entry has a rough effort estimate, the
symptom it kills, and any dependencies on prior bundles.

This doc is a living artifact — re-shuffled as priorities shift or
real usage reveals new pain points. Last updated: v2.4.0.

## Currently shipped

- **v2.4.0** *(latest)* — trust & predictability bundle. Per-phase
  wall-clock budgets (catches silent DEV_GREEN hangs); self-explaining
  halts (every user_prompt carries last 3 actions, failed verifier
  check, elapsed time, similar-halt pointer); background full-suite
  runner (`testing.full_suite_on_story_land: background` now wired
  end-to-end; closes the v2.3.18 silent caveat for teams without CI);
  flaky-test quarantine (auto-records flips, quarantines after N=3
  across stories, audited in decision-log, `autopilot quarantine`
  CLI).
- **v2.3.18** — tiered, change-aware test scope per phase.
  Affected-only inner loop (Vitest `--changed`, Jest
  `--findRelatedTests`, pytest `--testmon`, generic shell-out
  adapter); CI gates the full suite via `gh pr checks` on `STORY_LAND`.
- **v2.3.17** — Windows-CI green (path-separator + `node -e`
  embedding fixes).
- **v2.3.16** — reconciliation probe respects `git.enabled: false`
  and `reuse_user_branch: true`.
- **v2.3.15** — STORY_LAND opens its own PR under
  `merge_strategy: land_as_you_go`.
- **v2.3.14** — reconciliation guards against unpushed work.
- **v2.3.13** — boot-time auto-reconcile with BMAD's sprint-status.

## v2.4.1 — Speed-beyond-tests bundle

Once v2.3.18 made the inner test loop fast, the next bottlenecks
become reviewers and retry loops.

| Component | Effort | Kills |
|---|---|---|
| Change-size-scaled review depth — route via `bmad-impact-classifier`: trivial → 1 reviewer, normal → 3, structural → 3 + extended Edge Case Hunter | ~1-2 days | 40-60% review-time on small stories; reviewer overkill on typos |
| Diagnostic mode on consecutive failures — between failure 2 and 3, orchestrator emits a `diagnostic` action that re-runs with verbose flags and feeds traces into the next attempt | ~2 days | "LLM is fixing the wrong thing" loops that escalate to user_prompt unnecessarily |

**Total: ~3-4 days.** Patch bump.

## v2.5.0 — Memory bundle

Kills the "LLM relearns the project every session" problem.

| Component | Effort | Kills |
|---|---|---|
| Project conventions file — persistent `_bmad-output/conventions.md`, auto-appended at each retro, auto-injected into every dev-story template | ~2 days | Generic patterns sneaking in despite project idioms |
| Pre-flight story briefing — new `story_briefing` template slot: recent commits to AC-relevant files, related decision-log entries, lessons-from-similar-stories from retros | ~3 days | Re-discovery of the same gotchas every story |

**Total: ~5 days.** Minor bump because this is a semantically
meaningful behavior change.

## v2.5.1 — Observability bundle

Once memory is in place, the remaining frustration is "what's it
doing right now?" Pure visibility, no behavior change.

| Component | Effort | Kills |
|---|---|---|
| Better `autopilot status` — current phase + time-in-phase + last 3 ledger events + queue head + retry counts | ~1 day | `tail -f ledger.jsonl` becoming the de-facto status command |
| Sprint-health metrics in retros — LOC delta, test count delta, coverage delta, avg phase time, retry rate, halt count | ~1-2 days | Sprint drift only discovered when something breaks |
| Live timeline TUI — `autopilot watch` tails the ledger and renders updating phases, decisions, halts, test results | ~3-5 days | "Is it still healthy?" glances during long sessions |

**Total: ~5-8 days.** Patch bump.

## v2.6.0 — Bigger bets

Worth doing but bigger design surface. Each gets a concept pass
before commit. Won't ship as a bundle — each lands when ready.

### v2.6.0 — Resume mid-skill
Persist intermediate state per-skill: which AC are already
implemented, which patches landed, which tests passed. A crash or
interrupt during `DEV_GREEN` at 80% picks up at 80%, not 0%.
**~3-5 days, lots of edge cases.** Wait for a concept pass before
committing.

### v2.6.x — Smart story preflight
Augment `bmad-check-implementation-readiness` to detect: files
this story will touch that have open PRs, modules with high
pending-TODO density, recently-failed-tests in the same module.
**~3 days.** Depends on v2.5.0's briefing infrastructure.

## v3.0.0 — Bootstrap for greenfield repos

The right "v3" headline because it changes who can pick up
Sprintpilot. Today: install → discover you need `sprint-status.yaml`
→ read BMad docs → return. Bootstrap walks an empty repo through
brief → PRD → epics → stories → first sprint queued in one
interactive session.

**~5-7 days, lots of UX work.** Requires a separate concept pass.

## Sequencing

```
trust  ─→ v2.4.0
speed  ─────────→ v2.4.1
memory ─────────────────→ v2.5.0
obs    ─────────────────────────→ v2.5.1
bets   ─────────────────────────────────→ v2.6.0 → v2.6.x
v3     ──────────────────────────────────────────────────→ v3.0.0
```

Trust before speed because the trust wins pay back on every sprint
regardless of project size, and they de-risk the bigger bets by
surfacing failure modes more clearly. Speed before memory because
speed wins are small and self-contained; memory needs more design.

## Explicitly NOT on the roadmap

Honest cuts. May reconsider if real usage demands them.

- **Multi-LLM coordination** (different models per reviewer).
  Interesting but adds config complexity most users don't want.
- **Native build-system caching detection** (nx / turbo / bazel).
  Covered today by `testing.commands.affected` user override; doing
  it natively across all stacks is a project unto itself.
- **Architectural drift detection.** Vague; hard to define
  "concerning." Park until v3.x when there's a clearer use case.
- **Inline-test mode for nano.** Pre-existing convention work,
  doesn't move the needle for most users.

## Process notes

- Themed bundles, not one-feature-per-release. Trade fewer releases
  for more coherent user-visible improvements.
- CI must stay green across macOS / Linux / Windows on every release.
- Every behavior change ships with a CHANGELOG entry explaining the
  "why" not just the "what".
- Concept pass before code on anything tagged "bigger bet"
  (v2.6.0+). No surprise PRs for those.
