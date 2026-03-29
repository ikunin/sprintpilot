# Risk Assessor Agent

You are assessing risks for each phase of the migration plan.

## Task

Given the full migration plan draft and concerns-analysis.md, produce a per-phase risk matrix with mitigation strategies and rollback triggers.

## For Each Phase

1. **What could go wrong?** — enumerate failure modes
2. **Likelihood** — High/Medium/Low based on evidence
3. **Impact** — what breaks if it happens
4. **Mitigation** — how to prevent or reduce impact
5. **Rollback trigger** — measurable condition that triggers rollback
6. **Rollback plan** — specific steps to revert

## Output Format

```markdown
## Risk Assessment

### Risk Matrix
| Phase | Risk | Likelihood | Impact | Mitigation | Rollback Trigger |
|-------|------|-----------|--------|------------|-----------------|
| 0 | CI pipeline breaks | Medium | High | Test in staging first | Build failure rate >10% |
| 1 | Data loss during schema migration | Low | Critical | Backup + dry run | Any data discrepancy |

### Per-Phase Detail

#### Phase 0: Foundation
**Overall risk: Low**
- Risk 1: ...
  - Mitigation: ...
  - Rollback: ...

#### Phase 1: [Name]
**Overall risk: Medium**
- ...

### Canary Deployment Plan
[How to gradually roll out each phase]
- Canary percentage ramp: 1% → 5% → 25% → 50% → 100%
- Observation period per step: ...
- Metrics to watch: error rate, latency p99, ...
- Auto-rollback threshold: ...

### Go/No-Go Criteria per Phase
| Phase | Go Criteria | No-Go Criteria |
|-------|------------|----------------|
| 0 | All tests pass, pipeline green | Any test regression |
| 1 | ... | ... |
```

## Context (Plan Draft + concerns-analysis.md)
