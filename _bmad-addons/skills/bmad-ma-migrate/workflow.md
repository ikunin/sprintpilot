# Multi-Agent Migration Planning

## Purpose

Plan a full-lifecycle migration from current stack to a target stack. Produces a phased roadmap, BMAD-compatible epics, and tracking artifacts.

## Prerequisites

- `bmad-ma-codebase-map` outputs in `_bmad-output/codebase-analysis/`
- `bmad-ma-assess` output (`brownfield-assessment.md`) — recommended but not required

## Outputs

| File | Location | Purpose |
|------|----------|---------|
| `migration-plan.md` | `{planning_artifacts}/` | Full plan — human reference |
| `migration-epics.md` | `{planning_artifacts}/` | BMAD-compatible epics for sprint planning |
| `migration-tracking.yaml` | `{implementation_artifacts}/` | Progress tracking |

---

## Step 1 — Validate Prerequisites and Get Target

<action>Verify codebase analysis exists. Read STACK.md, ARCHITECTURE.md, CONCERNS.md.</action>
<action>Read brownfield-assessment.md if available.</action>
<action>Ask user for:
- **Target stack** (required): what to migrate to
- **Constraints** (required): timeline, downtime tolerance, budget
- **Risk tolerance** (required): conservative / moderate / aggressive
If running under autopilot and these aren't derivable from existing artifacts → TRUE BLOCKER.
</action>

---

## Step 2 — Strategy Selection

<action>Based on analysis, recommend a migration strategy:

| Strategy | When | Risk | Duration |
|----------|------|------|----------|
| Strangler Fig | Monolith with clear routing; zero-downtime required | Low | Long |
| Branch by Abstraction | Internal components; need to swap implementations | Low-Med | Medium |
| Big Bang | Small codebase, good test coverage | High | Short |
| Parallel Run | Critical systems requiring verified equivalence | Medium | Long |

Present recommendation with rationale. User confirms or overrides.
</action>

---

## Step 3 — Compatibility Analysis (PARALLEL: 2 agents)

<critical>Launch both agents in a single message.</critical>

### Agent 1: Stack Mapper
```
Agent(
  description: "Stack compatibility mapping",
  prompt: <read ./agents/stack-mapper.md, append STACK.md + ARCHITECTURE.md + target spec>
)
```
Output: old→new component mapping, direct replacements vs rewrites needed.

### Agent 2: Dependency Analyzer
```
Agent(
  description: "Dependency graph and migration order",
  prompt: <read ./agents/dependency-analyzer.md, append brownfield-assessment.md + CONCERNS.md>
)
```
Output: dependency graph, migration order, critical path.

<action>Collect results. Merge into compatibility matrix.</action>

---

## Step 4 — Coexistence Design

<action>Based on strategy (step 2) and compatibility (step 3), design how old + new code run together:
- Proxy/router configuration
- Adapter/anti-corruption layer design
- Feature flag strategy
- Data dual-write approach (if needed)
- Rollback triggers and mechanism
</action>

---

## Step 5 — Phased Roadmap

<action>Create ordered phases, each delivering verifiable value:
```
Phase 0: Foundation — pipeline, coexistence infra, dual-deploy, test infra
Phase 1-N: Component migrations — ordered by dependency graph
Phase N+1: Decommission — remove old code, adapters, coexistence infra
```
Each phase has: scope, deliverable, verification criteria, rollback plan.
</action>

---

## Step 6 — Per-Component Migration Cards

<action>For each component to migrate:
```markdown
### [Component Name]: old → new
- **Strategy**: strangler / rewrite / adapt
- **Effort**: S/M/L/XL
- **Risk**: Low/Medium/High
- **Dependencies**: [components that must migrate first]
- **Data migration**: yes/no — approach: ...
- **Test strategy**: ...
- **Rollback**: ...
- **Phase**: N
```
</action>

---

## Step 7 — Data Migration Plan

<action>If schema changes or data store migration is needed:
- Schema diff (old vs new)
- Transform logic
- Dual-write period design
- Backfill strategy
- Rollback plan for data
- Zero-downtime migration sequence
</action>

---

## Step 8 — API Compatibility

<action>If APIs change:
- Versioning strategy (URL path / header / query param)
- Backward compatibility period
- Deprecation timeline
- Client migration guide
</action>

---

## Step 9 — Test Parity (PARALLEL: 1 agent)

### Agent 3: Test Parity Analyzer
```
Agent(
  description: "Test parity analysis for migration",
  prompt: <read ./agents/test-parity-analyzer.md, append QUALITY.md + target test framework>
)
```
Output: old test → new test mapping, gaps, comparison testing strategy.

---

## Step 10 — Risk Assessment (PARALLEL: 1 agent)

### Agent 4: Risk Assessor
```
Agent(
  description: "Migration risk assessment",
  prompt: <read ./agents/risk-assessor.md, append full plan draft + CONCERNS.md>
)
```
Output: per-phase risk matrix, mitigation strategies, rollback triggers, canary deployment plan.

---

## Step 11 — Generate BMAD Epics

<action>Transform the migration plan into BMAD-compatible epics:
```markdown
# Migration Epics

## Epic 0: Migration Foundation
- Story 0-1: Set up coexistence infrastructure
- Story 0-2: Configure dual deployment pipeline
- Story 0-3: Create migration test harness

## Epic 1: [Phase 1 Name]
- Story 1-1: [Component] migration
- Story 1-2: ...

## Epic N+1: Decommission
- Story N+1-1: Remove old [component]
- Story N+1-2: Remove adapters and feature flags
- Story N+1-3: Final validation and cleanup
```

Each story includes: acceptance criteria, estimated effort, dependencies.
</action>

<action>Write to `{planning_artifacts}/migration-epics.md`</action>

---

## Step 12 — Finalize

<action>Compile everything into `{planning_artifacts}/migration-plan.md`:
- Executive summary
- Strategy and rationale
- Compatibility matrix
- Coexistence design
- Phased roadmap
- Component migration cards
- Data migration plan
- API compatibility plan
- Test parity analysis
- Risk matrix
- Epic summary with links
</action>

<action>Create `{implementation_artifacts}/migration-tracking.yaml`:
```yaml
migration:
  strategy: strangler-fig
  target_stack: ...
  started: null
  phases:
    phase-0:
      name: Foundation
      status: pending
      stories: [0-1, 0-2, 0-3]
    phase-1:
      name: ...
      status: pending
      stories: [...]
```
</action>

<action>Report summary and suggest next steps:
- `bmad-sprint-planning` — plan sprints from migration epics
- `bmad-create-story` — detail individual migration stories
</action>
