# Migration Strategies Reference

## Strangler Fig

**When**: Monolith with clear routing; zero-downtime required
**Risk**: Low
**Duration**: Long
**How**: Route-by-route, new code handles progressively more traffic. Old code remains until fully strangled.
**Requires**: Proxy/router that can split traffic between old and new.

## Branch by Abstraction

**When**: Internal components; need to swap implementations
**Risk**: Low-Medium
**Duration**: Medium
**How**: Create abstraction layer over old code, swap implementation behind it, remove old code.
**Requires**: Clean interface boundaries or willingness to create them.

## Big Bang

**When**: Small codebase, good test coverage, or greenfield rewrite
**Risk**: High
**Duration**: Short
**How**: Rewrite everything, switch over at once.
**Requires**: Comprehensive test suite, low tolerance for extended coexistence.

## Parallel Run

**When**: Critical systems requiring verified equivalence
**Risk**: Medium
**Duration**: Long
**How**: Run old and new simultaneously, compare outputs, switch when confident.
**Requires**: Infrastructure to run both systems, comparison framework.

## Decision Matrix

| Factor | Strangler | Branch-Abstraction | Big Bang | Parallel |
|--------|-----------|-------------------|----------|----------|
| Downtime tolerance | None | Low | High OK | None |
| Codebase size | Large | Any | Small | Any |
| Test coverage | Any | Good | Excellent | Good |
| Team size | Any | Small-Med | Small | Large |
| Timeline | Flexible | Moderate | Tight | Flexible |
