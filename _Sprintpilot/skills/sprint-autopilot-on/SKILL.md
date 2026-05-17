---
name: sprint-autopilot-on
description: 'Engage autonomous story execution for BMad Method with git workflow integration. Implements stories end-to-end with automatic branching (git worktrees), commits, linting, and PR creation. Uses standard git worktree commands for story isolation — works with any coding agent. Falls back to stock BMad behavior when git is disabled. Use when user says "/sprint-autopilot-on" or "start autopilot".'
---

## STOP — read this entire file before doing anything

Sprintpilot is driven by a deterministic Node.js state machine at
`_Sprintpilot/bin/autopilot.js`. The LLM owns in-skill execution,
diagnosis, triage, and small-judgment decisions — not the flow.

Follow **`./workflow.orchestrator.md`** verbatim. Flow control lives in
`_Sprintpilot/bin/autopilot.js` (a Node CLI you call via `autopilot next`
/ `autopilot record`). The orchestrator emits actions; you execute them.

### Never improvise

- Never decide which BMad skill runs next yourself — the state machine
  emits an `invoke_skill` action telling you.
- Never skip the `autopilot next` → `autopilot record` cycle. Even when
  a step feels "obvious," route through the CLI so the ledger, verify,
  and bookkeeping enforcement run.
- Do not search for `workflow.md` or reconstruct it from memory; do not
  read cached BMad legacy patterns and apply them ahead of the
  orchestrator's state machine.
- **Never pause on your own initiative.** `user_input { kind: 'pause' }`
  is a HUMAN command. The autopilot's purpose is to drive without
  stopping until `session_story_limit`, a TRUE BLOCKER, retry-budget
  exhaustion, or `sprint_is_complete`. Heuristics like "PR opened,
  time for review" / "natural breakpoint" / "let CI catch up" /
  "context budget" / "clean checkpoint" / "merge cadence" / any
  meta-reasoning about session length, story count, or your own
  resource usage are NOT valid reasons to pause. Phrases like
  "User-initiated checkpoint to control session length / context" in
  a `details` string are LLM self-narration even when the wrapper
  claims user intent — see `workflow.orchestrator.md` § "Pause is
  human-only."

### Don't over-defend signals

The verifier handles structural recovery for several common omission
patterns — so you don't need to over-echo fields that the runner /
git already prove:

- `dev_red`: if you omit `test_files`, the verifier auto-detects test
  files from `git diff` + untracked files (per-language regex). If you
  provide them but with repo-relative paths, the verifier resolves
  them against `projectRoot`.
- `dev_green` / `patch_retest` / `nano_quick_dev`: if you omit
  `tests_run`, the verifier accepts the runner's count.
- `story_done`: if you omit `git_steps_completed: true`, the verifier
  probes `git cat-file -e <commit_sha>` + `git ls-remote --heads
  origin <branch>` and accepts the signal when both succeed.
- `code_review`: findings recorded as a `### Review Findings` section
  in the story file (the `bmad-code-review` convention) are accepted
  alongside the legacy `_bmad-output/reviews/<key>.md` location.

Provide the canonical fields when you have them — they're the audit
trail. The recovery paths are for when the work is correct but the
signal echo is incomplete.

`workflow.orchestrator.md` is the **sole authority** for the rest of the
session.

---

## Natural-language entry: starting at a specific story or epic

The user may invoke this skill with extra arguments specifying which
story / epic to run, e.g.:

- `/sprint-autopilot-on epic 4`
- `/sprint-autopilot-on stories 3.1, 3.2, 4.5`
- `/sprint-autopilot-on 4-8-realm-wide-matcher`
- `/sprint-autopilot-on voice identity matcher`
- `/sprint-autopilot-on starting from 4.5`

Translate the natural-language directive into an explicit queue of
canonical story keys, then call `autopilot start --stories <csv>` (or
`--epic <id>`). The orchestrator validates the keys before running.

**Resolution procedure** — do this BEFORE the first `autopilot next`:

1. **Read sprint-status.yaml** at `_bmad-output/implementation-artifacts/sprint-status.yaml`.
   If it's missing, tell the user to run BMad sprint-planning first and
   stop — don't invoke `autopilot start`.

2. **Parse the user's directive.** Match against these forms:

   | User says | Resolve to |
   |---|---|
   | "epic 4", "epic-4", "all of epic 4" | `autopilot start --epic 4` |
   | "stories 3.1, 3.2, 4.5", "3.1 3.2 4.5" | Match each `<epic>.<story>` to canonical keys (`3-1-*`, `3-2-*`, `4-5-*`) in sprint-status order; `autopilot start --stories <csv>` |
   | "4-8-realm-wide-matcher" (already canonical) | `autopilot start --stories 4-8-realm-wide-matcher` |
   | "voice identity", "matcher" (name fragment) | Search story slugs in sprint-status for fuzzy matches |
   | "starting from 4.5" (everything from here) | Resolve `4.5` to canonical key, then queue it + every subsequent non-done story in sprint-status order: `autopilot start --stories <key1>,<key2>,...` |
   | (no extra args) | Plain `autopilot start` — orchestrator picks the next pending story |

3. **Ambiguity handling.** If a name fragment or number matches more
   than one story, **do not pick arbitrarily**. List the candidates and
   ask the user to disambiguate. Example:

   > "voice identity" matches 3 stories:
   > - 3-2-speaker-enrollment
   > - 4-2b-voice-identity-matcher
   > - 4-8-realm-wide-matcher-and-session-lock
   > Which one(s) do you mean?

   Do not invoke `autopilot start` with a guess.

4. **Validation.** Every resolved key must exist in sprint-status.yaml
   and not be `done`. The orchestrator double-checks this and errors
   out otherwise — but verifying ahead of time gives the user clearer
   feedback. If a key resolves to a `done` entry, mention that and ask
   whether they meant something else.

5. **Mid-sprint overwrite.** If `autopilot state` shows a sprint already
   in progress (`current_story` is set or `story_queue` is non-empty)
   AND the user is asking to start something different, the orchestrator
   will refuse without `--force`. Confirm with the user before adding
   `--force` — it discards the current story identity.

6. **Continuation behavior.** Once the explicit queue exhausts, the
   orchestrator falls back to its normal next-pending-story resolver
   (so a user who says "epic 4" gets epic 4 done, then continues with
   whatever comes next in sprint-status — including epic 5+). Tell the
   user this if they ask.

7. **Then proceed normally.** After `autopilot start ...` returns
   successfully, follow `workflow.orchestrator.md` from `autopilot next`
   onward.

### Examples

| Input | Resolved invocation |
|---|---|
| `/sprint-autopilot-on` | `autopilot start --project-root <root>` |
| `/sprint-autopilot-on epic 4` | `autopilot start --epic 4 --project-root <root>` |
| `/sprint-autopilot-on stories 3.1, 3.2` (after matching `3-1-game-engine`, `3-2-input-parser`) | `autopilot start --stories 3-1-game-engine,3-2-input-parser --project-root <root>` |
| `/sprint-autopilot-on 4-8-realm-wide-matcher-and-session-lock` | `autopilot start --stories 4-8-realm-wide-matcher-and-session-lock --project-root <root>` |
| `/sprint-autopilot-on starting from 4.5` (resolved + all-subsequent) | `autopilot start --stories 4-5-realm-config,4-8-realm-wide-matcher --project-root <root>` |

Failure cases that should stop you (do NOT invoke autopilot):

- `sprint-status.yaml` missing → ask the user to run sprint-planning.
- Ambiguous match → list candidates, ask which.
- Every resolved key is `done` → tell the user there's nothing to run.
