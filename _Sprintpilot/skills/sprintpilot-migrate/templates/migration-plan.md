# Migration Plan: {project_name}

## Executive Summary

{executive_summary}

## Migration Strategy

**Strategy**: {strategy} (strangler-fig | branch-by-abstraction | big-bang | parallel-run)
**Target Stack**: {target_stack}
**Timeline**: {timeline}
**Risk Tolerance**: {risk_tolerance}

## Current State

{current_state_summary — from codebase analysis}

## Target State

{target_state_description}

## Compatibility Matrix

| Component | Current | Target | Migration Type | Effort |
|-----------|---------|--------|---------------|--------|
| {component} | {current} | {target} | direct/rewrite/abstract | S/M/L/XL |

## Coexistence Design

{how old + new code run together}

## Phased Roadmap

### Phase 0: Foundation
- Scope: {scope}
- Deliverable: {deliverable}
- Verification: {how to verify}
- Rollback: {rollback plan}

### Phase 1: {name}
...

### Phase N+1: Decommission
...

## Data Migration Plan

{schema changes, transforms, dual-write, backfill, rollback}

## API Compatibility

{versioning, backward compat, deprecation timeline}

## Test Parity

{old → new test mapping, comparison testing strategy}

## Risk Matrix

| Phase | Risk | Likelihood | Impact | Mitigation | Rollback Trigger |
|-------|------|-----------|--------|------------|-----------------|
| ... | ... | ... | ... | ... | ... |

## Epic Summary

See `migration-epics.md` for BMAD-compatible epic breakdown.
