# Adaptive Process Scaling — Reducing Sprintpilot Development Time

Status: Concept / Design doc
Branch: `claude/optimize-dev-workflow-D0U4w`
Constraint: All optimizations live in Sprintpilot-owned code (`_Sprintpilot/*`, configs, `AGENTS.md`). BMAD skill internals are off-limits.

---

## 1. Problem

A trivial project (tic-tac-toe, 4 epics × 3–4 stories) currently takes ~4h under Sprintpilot autopilot. The bulk of that time is orchestration overhead, not implementation work:

- 7 sequential BMAD skill invocations per story (~84 calls for a tic-tac-toe)
- Worktree create/teardown per story (~12 worktrees)
- One PR per story (~12 PRs)
- Session checkpoint forced every 3 stories (~4 session restarts)
- Per-epic retrospectives (~4 retrospectives)
- Constant state-file / decision-log YAML churn

The per-story BMAD cycle is the right unit of rigor for a production team product. It is not the right unit for a toy, nor is it maximally efficient for larger projects where independent work could run in parallel.

## 2. Constraint: BMAD is off-limits

The autopilot (`_Sprintpilot/skills/sprint-autopilot-on/workflow.md`) is Sprintpilot's. It decides **which** BMAD skills to invoke and **when**. Everything in this document is implemented through:

- Autopilot routing changes
- Sprintpilot module configs (`_Sprintpilot/modules/{autopilot,git,ma}/config.yaml`)
- Git workflow (worktrees, branching, PRs)
- `AGENTS.md` / `CLAUDE.md` policy
- New Sprintpilot-owned helper scripts under `_Sprintpilot/scripts/`

No `bmad-*` skill is modified.

## 3. Core concept: Adaptive Process Scaling

A `complexity_profile` dimension (`nano | small | medium | large | legacy`) governs two things:

1. **Flow selection** — which BMAD flow runs per work unit.
2. **Orchestration envelope** — everything around the flow (worktrees, PRs, parallelism, session management, retrospectives).

Quality gates inside each flow are unchanged. `bmad-code-review` runs wherever the flow includes it. Profiles do not tune quality; they tune ceremony and parallelism.

## 4. Profile definitions

| Profile | Target project | Flow |
|---|---|---|
| `nano` | Toy, tutorial, solo learning. <20 stories, no external integrations | `bmad-quick-dev`, one call per epic |
| `small` | Solo-built MVP, internal tool, prototype | Full 7-step BMAD cycle per story |
| `medium` | Team-built product with real users | Full 7-step cycle per story, parallelism available |
| `large` | Production system, compliance/uptime stakes | Full 7-step cycle per story, stricter safety, parallelism on |
| `legacy` | Rollback to pre–v4 behavior | Full 7-step cycle, all v4 optimizations disabled |

`medium` is the default for `sprintpilot install` unless the user opts otherwise.

## 5. Nano flow

Nano is the only profile that replaces the cycle. Per epic:

1. Autopilot reads the epic's stories + ACs from `sprint-status.yaml` into one brief.
2. Autopilot writes an epic-level stub `_bmad-output/stories/epic-<id>.md` (see §9 R4) so downstream skills have a story file to read.
3. `bmad-quick-dev` implements the brief.
4. Run the project's test suite — `N/N passed`.
5. Stage → commit → PR for the epic, merge (squash).
6. Next epic.

No `bmad-create-story`, no `bmad-check-implementation-readiness`, no `bmad-dev-story`, no `bmad-code-review`. The quick flow's own quality handling is what runs.

### Nano safety net

```yaml
autopilot:
  nano:
    fallback_triggers:
      - tests_fail: true
      - quick_dev_error: true
    on_fallback: escalate_to_small   # next epic runs full cycle
```

If an epic's `bmad-quick-dev` output fails tests or the skill errors, the autopilot escalates the next epic to `small` and logs the escalation. Quality failures become loud, not silent.

## 6. Small / Medium / Large flow

All three run the identical 7-step BMAD cycle per story:

`bmad-create-story` → `bmad-check-implementation-readiness` → `bmad-dev-story` RED → GREEN → `bmad-code-review` → patches → re-invoke `bmad-code-review` (BMAD owns the `done` transition)

Differences are orchestration-only:

| Dimension | small | medium | large |
|---|---|---|---|
| Worktrees | optional (usually off for solo) | on | on |
| Branching / PR granularity | per-story | per-story | per-story |
| Retrospective mode | `auto` | `auto` | `stop` (interactive) |
| Session budget | relaxed | balanced | conservative |
| M1: skip redundant post-patch re-review when findings empty | on | on | **off** (safety) |
| M2: parallel intra-epic stories | off | opt-in, default 2 | on, default 3 |
| M3: coalesce state writes | on | on | on |
| M4: conditional boot work | on | on | **off** (always full reconcile) |
| M5: cached per-iteration reads | on | on | on |
| Cross-epic parallelism | off | off | experimental opt-in |

### Why large turns safety knobs back on

`large` assumes rollback is expensive. The redundant post-patch review (~1 skill call) and the full boot reconciliation (~10–30s) are cheap insurance against regressions and drifted refs. Not worth cutting when downside is customer-visible.

## 7. Parallelism design

### 7.1 Scope

- **Within-epic story parallelism** — primary mechanism. Independent stories in the same epic run concurrently in separate worktrees. Available on `medium` (opt-in) and `large` (on).
- **Cross-epic parallelism** — experimental only. Demoted from "opt-in on large" after adversarial review (R5). Behind a separate flag with explicit warning.
- **Not parallelized** — planning skills (sequential by BMAD contract). The 3 adversarial layers inside `bmad-code-review` are already parallel internally.

### 7.2 Dependency detection (multi-signal)

The autopilot builds a per-epic DAG using three sources, in priority order:

1. **Explicit declaration.** `depends_on: [1-2, 1-3]` in story file front matter. Highest confidence. User-authored.
2. **Predicted file touches.** Parse the story's `Tasks/Subtasks` section for file paths. Two stories touching the same file become conflict-edges (blocks parallel execution, even if logically independent).
3. **LLM fallback.** Haiku call per epic builds an AC-dependency graph when (1) and (2) yield no signal. Flagged as low-confidence.

User overrides in `_Sprintpilot/modules/ma/dependencies.yaml`:

```yaml
overrides:
  - epic: 2
    force_sequential: [2-3, 2-4]
    force_independent: [2-1, 2-2]
```

### 7.3 Execution model

```
Epic 1 DAG:                Execution:
  1-1 ──┐                   Layer 0: [1-1]               (1 agent)
  1-2 ──┼── 1-4             Layer 1: [1-2, 1-3]          (2 agents)
  1-3 ──┘                   Layer 2: [1-4]               (1 agent)
```

Per layer: spawn N sub-agents (one per story, each in its own worktree), await all, sequential merge in dependency order, then next layer.

### 7.4 Per-story state sharding (R1, R10)

Parallel sub-agents cannot share `autopilot-state.yaml` or `decision-log.yaml` — concurrent writes corrupt YAML. Design:

- Each sub-agent writes to `_bmad-output/implementation-artifacts/.autopilot-state/<story-key>.yaml`
- Each sub-agent appends to `_bmad-output/implementation-artifacts/.decision-log/<story-key>.yaml`
- `M0` phase timings: `_bmad-output/implementation-artifacts/.timings/<story-key>.yaml`
- At layer boundary, the coordinator merges shards into the project-level files atomically

### 7.5 Failure modes

| Failure | Response |
|---|---|
| Test fail in one parallel story | Isolate; continue others; block stories depending on the failed one; report at batch end |
| Merge conflict at layer boundary | Retry once after rebase; on second failure, abort that story and force sequential for rest of epic |
| `max_consecutive_conflicts` reached | Auto-disable parallelism for remainder of session, log to decision-log |
| Worktree disk/permission failure | Fall back to sequential for that story (existing logic at `workflow.md:435`) |
| Rate-limit / 429 from provider | Exponential backoff, reduce effective concurrency for this session |

## 8. Configuration reference

All parameters live in Sprintpilot-owned YAMLs. Defaults shown per profile.

### 8.1 `_Sprintpilot/modules/autopilot/config.yaml`

| Parameter | Purpose | nano | small | medium | large | legacy |
|---|---|---|---|---|---|---|
| `complexity_profile` | Profile selector | nano | small | medium | large | legacy |
| `implementation_flow` | Routing override | `quick` | `full` | `full` | `full` | `full` |
| `session_story_limit` | Story count before checkpoint (0 = disabled) | 0 | 0 | 5 | 3 | 3 |
| `retrospective_mode` | Retrospective handling | `skip` | `auto` | `auto` | `stop` | `auto` |
| `auto_escalate_on_failure` | Nano escalation | true | n/a | n/a | n/a | false |
| `skip_redundant_rereview` (M1) | Skip post-patch re-review when findings empty | n/a | true | true | false | false |
| `coalesce_state_writes` (M3) | Batch state/decision-log/git-status commits | on | on | on | on | off |
| `conditional_boot_work` (M4) | Skip health-check when no worktrees present | on | on | on | off | off |
| `cache_shared_reads` (M5) | Read sprint-status/decision-log once per loop iter | on | on | on | on | off |
| `phase_timings` (M0) | Emit per-phase duration logs | on | on | on | on | off |

`session_budget_fraction` from earlier drafts is removed (R8 — no API to measure context utilization). Falls back to `session_story_limit` calibrated per profile.

### 8.2 `_Sprintpilot/modules/ma/config.yaml` (multi-agent / parallelism)

| Parameter | nano | small | medium | large |
|---|---|---|---|---|
| `parallel_stories` | false | false | **opt-in** (default false) | true |
| `max_parallel_stories` | — | — | 2 | 3 |
| `parallel_epics` | false | false | false | **experimental** (default false) |
| `max_parallel_epics` | — | — | — | 2 |
| `dependency_source` | — | — | `explicit,files,llm` | `explicit,files,llm` |
| `dependency_llm_model` | — | — | `haiku-4.5` | `haiku-4.5` |
| `max_consecutive_conflicts` | — | — | 2 | 3 |
| `conflict_resolution` | — | — | `rebase_retry` | `rebase_retry` |
| `state_sharding` | on whenever `parallel_*` is true — otherwise off |

### 8.3 `_Sprintpilot/modules/git/config.yaml`

| Parameter | nano | small | medium | large | legacy |
|---|---|---|---|---|---|
| `granularity` | `epic` | `story` | `story` | `story` | `story` |
| `worktree.enabled` | false | optional | true | true | true |
| `squash_on_merge` | true | false | false | false | false |
| `push.auto` | true | true | true | true | true |
| `push.create_pr` | true | true | true | true | true |

## 9. Installer UX

### 9.1 Interactive (`sprintpilot install`)

Five prompts cover all meaningful decisions. Everything else uses profile defaults, editable later in the YAMLs.

```
1) Profile
   What profile matches your project?
     1) nano    — toy/tutorial, solo, <20 stories
     2) small   — MVP or internal tool, solo / 1-2 devs
     3) medium  — team product with real users (default)
     4) large   — production system, compliance/uptime stakes
   [3]:

2) Parallelism                                   (hidden for nano/small)
   Enable parallel story execution within epics?
     1) No — sequential (safest)
     2) Yes — max 2 concurrent
     3) Yes — max 3 concurrent (recommended for medium+)
     4) Yes — max 4 concurrent (aggressive)
   [2 for medium, 3 for large]:

   ⚠  Parallel=N triples LLM concurrency and cost.
      Ensure your API tier can handle ~9 concurrent sessions at N=3.

3) Retrospectives
   How should epic retrospectives be handled?
     1) skip — no artifact
     2) auto — deterministic artifact, autopilot continues
     3) stop — pause for interactive /bmad-retrospective
   [auto for small/medium; stop for large]:

4) Git platform
   Platform: github / gitlab / git_only
   Base branch: main

5) Session checkpointing
   How frequently should autopilot checkpoint?
     1) Never (0) — checkpoint only on explicit request
     2) Every 5 stories (medium default)
     3) Every 3 stories (large default)
   [per profile default]:
```

### 9.2 Non-interactive (CI / automation) — R6

```
sprintpilot install \
  --profile medium \
  --parallel 2 \
  --retrospective-mode auto \
  --git-platform github \
  --base-branch main \
  --session-story-limit 5 \
  --yes
```

Fail closed on missing flags. No silent defaults in non-interactive mode.

### 9.3 Advanced

`sprintpilot install --advanced` additionally prompts for:

- `dependency_source` priority
- `max_consecutive_conflicts`
- `skip_redundant_rereview` (M1) explicit toggle
- `worktree.enabled` override

## 10. Estimated time reduction

Structure is reliable; exact percentages are not, until M0 measurement lands. Reproduced here for planning only.

| Project size (current baseline) | nano | small | medium sequential | medium parallel=2 | medium parallel=3 | large sequential | large parallel=3 |
|---|---|---|---|---|---|---|---|
| Toy, 12–16 stories (~4h) | ~30–45 min | ~2h | ~2.5h | ~2h | — | — | — |
| MVP, 20–40 stories (~12h) | n/a | ~7h | ~9h | ~6h | ~5h | — | — |
| App, 40–80 stories (~30h) | n/a | n/a | ~22h | ~14h | ~10h | ~24h | ~12h |
| Large, 80+ stories (~70h) | n/a | n/a | n/a | n/a | n/a | ~55h | ~25h |

Parallelism scales with **DAG width**, not story count. A fully serial DAG gets zero benefit from `parallel=N`. Expected average benefit: 40–60% of linear N-speedup on typical apps.

## 11. Adversarial review findings

All findings from the concept review, folded into the design above. Retained here as a change log so reviewers can audit the reasoning.

| ID | Finding | Resolution in this design |
|---|---|---|
| R1 | State/decision-log race under parallel execution | Per-story state shards merged at layer boundary (§7.4) |
| R2 | LLM cost + rate-limit blast radius at parallel=3 | Installer warning (§9.1); rate-limit failure mode (§7.5) |
| R3 | Worktree setup cost (submodule init ~30s × N) | Documented tradeoff; layers <5 min work should not parallelize |
| R4 | Nano artifact incompatibility with downstream skills | Autopilot writes minimal epic-scope stub at `_bmad-output/stories/epic-<id>.md` (§5) |
| R5 | Cross-epic parallelism too risky for large default | Demoted to `experimental`, off by default (§7.1, §8.2) |
| R6 | Installer must support non-interactive / CI | CLI flags spec in §9.2 |
| R7 | M1 depends on BMAD contract we haven't verified | Rollout plan §13 step 4 gates M1 behind reading `step-04-present.md:92` |
| R8 | `session_budget_fraction` has no measurement API | Replaced with per-profile `session_story_limit` (§8.1) |
| R9 | No rollback path | `legacy` profile pins pre–v4 defaults (§4, §8.1) |
| R10 | M0 phase timings race under parallel execution | Per-story timing shards (§7.4) |

## 12. Open questions

These cannot be answered from the repo alone. Each is a prerequisite for a specific rollout step.

1. **Does `bmad-quick-dev` handle epic-sized briefs?** Designed for single-intent tasks. The nano concept assumes it scales. Must be validated on a real project before making nano a default.
2. **Does `bmad-quick-dev` write a story file?** Determines whether the epic stub in §5 is necessary or duplicate.
3. **What does the second `bmad-code-review` call actually do?** If it only transitions `sprint-status.yaml`, M1 is safe. If it also re-runs tests or regenerates artifacts, M1 is unsafe. Read `step-04-present.md:92` to settle.
4. **Do BMAD story files carry a `depends_on:` field in practice?** Determines how often the LLM fallback dependency detector is the only signal available.
5. **What is the realistic DAG width of a typical epic?** Parallelism ROI depends on this. M0 instrumentation should measure it.

## 13. Rollout plan

Each step is validated before the next. No step ships without measurement from the previous.

1. **M0 — phase-timing instrumentation.** ~20 lines in `workflow.md`; per-story shards per §7.4. Baseline run on current settings. Publish hotspot breakdown.
2. **Nano routing.** Implement `implementation_flow: quick` + epic stub + fallback escalation. Run tic-tac-toe sprint; compare wall-clock and final test count against M0 baseline. Decides open questions #1 and #2.
3. **Nano orchestration cuts.** PR-per-epic, no worktrees, `retrospective_mode: skip`, squash-merge. Measure incremental saving over step 2.
4. **M1 — skip redundant post-patch re-review.** Gated on answering open question #3 via `step-04-present.md:92`. Ship with a feature flag; default off for one sprint; enable for small/medium after observation.
5. **M3 / M4 / M5 — orchestration overhead cuts.** Coalesce writes, conditional boot, cached reads. Small per-step savings that compound.
6. **M2 — parallel intra-epic stories.** Build behind `parallel_stories: false` default. Opt-in for one medium project, measure conflict rate, then decide default for medium.
7. **Cross-epic parallelism.** Experimental only. Only after M2 is proven on several projects.

## 14. Rollback path (R9)

Any user can revert to pre–v4 behavior at any time:

```yaml
# _Sprintpilot/modules/autopilot/config.yaml
autopilot:
  complexity_profile: legacy
```

The `legacy` profile pins every knob to its pre–v4 value, including:

- `session_story_limit: 3`
- No M0/M1/M3/M4/M5
- No parallelism
- Per-story branches and PRs
- Full boot reconciliation and health-check every session

This means even if a later v4 change regresses someone's workflow, they have a single one-line escape hatch. The installer should document this in its final success message.

## 15. Summary

- **Quality is invariant.** `bmad-code-review` runs wherever the chosen flow includes it; profiles do not turn it off.
- **Speed comes from orchestration.** Worktree overhead, session checkpoints, redundant calls, state-file churn, sequential execution of independent work — all are orchestration, not quality.
- **Nano uses the quick flow; everything else uses the full cycle.** This is the cleanest carve-out and the only place ceremony is reduced at the skill level.
- **Parallelism is the main medium+ lever.** DAG-aware intra-epic story execution with per-story state shards.
- **Every optimization has a fallback.** Nano → small on failure. M1 gated on BMAD contract read. `legacy` profile as universal rollback.
- **Measurement gates every deployment.** M0 first. Percentages in §10 are estimates for planning, not promises.

The expected outcome for the originating complaint — a tic-tac-toe that took 4h — is **~30–45 minutes on the nano profile**, with no change to BMAD and no loss of the quality handling inside the quick flow.
