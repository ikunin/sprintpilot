# Migration Epics

## Epic 0: Migration Foundation
Build pipeline, coexistence infrastructure, dual-deploy, test infrastructure.

- Story 0-1: Set up coexistence infrastructure
  - AC: Old and new code can run side-by-side
  - Effort: M
- Story 0-2: Configure dual deployment pipeline
  - AC: CI/CD deploys both old and new versions
  - Effort: M
- Story 0-3: Create migration test harness
  - AC: Comparison tests can verify old vs new equivalence
  - Effort: M

## Epic {N}: {Phase Name}
{phase_description}

- Story {N}-1: {component} migration
  - AC: {acceptance_criteria}
  - Effort: {S/M/L/XL}
  - Dependencies: {story-ids}

## Epic {N+1}: Decommission
Remove old code, adapters, coexistence infrastructure, final validation.

- Story {N+1}-1: Remove old {component}
  - AC: Old code paths are deleted, no references remain
  - Effort: S
- Story {N+1}-2: Remove adapters and feature flags
  - AC: Coexistence layer fully removed
  - Effort: S
- Story {N+1}-3: Final validation and cleanup
  - AC: All tests pass, no dead code, documentation updated
  - Effort: S
