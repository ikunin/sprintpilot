# Implementation decisions — Adaptive Process Scaling

A running log of non-obvious implementation choices made during the v2 rollout. Each entry: PR, category, decision, rationale, impact. Referenced by `docs/implementation-plan.md` cross-cutting section.

## PR 1 — Foundation

### D1.1 — architecture / config
**Decision:** `resolve-profile.js` reads autopilot config via regex, not via `readYaml()`.
**Rationale:** `workflow.md` uses `{{variable}}` placeholders that the YAML parser could technically interpret but the existing install.js path relies on preserving them verbatim. Following the precedent of `readExistingAutopilotConfig` (install.js:621) keeps a single code path for all write-back-preserving autopilot-config reads.
**Impact:** Low. The resolver's other reads (profile YAMLs, module YAMLs) use `js-yaml` normally since those files don't carry workflow placeholders.

### D1.2 — architecture / profile
**Decision:** `legacy` profile does NOT extend `_base.yaml`.
**Rationale:** Forward-compatibility guarantee (I9 in the review). If `legacy` inherited from `_base`, future edits to `_base` would silently drift legacy semantics — precisely what the `legacy` profile exists to prevent.
**Impact:** Low. Small duplication in `legacy.yaml` vs `_base.yaml`. Duplication is the point.

### D1.3 — scope
**Decision:** PR 1 writes `complexity_profile` to config but does not yet consume it from `workflow.md`.
**Rationale:** Plan sequences PR 1 as config-schema plumbing with zero behavior change. Behavior consumers land in PR 4 (nano routing) and later. This keeps PR 1 reviewable and independently shippable.
**Impact:** Low. Users who set a profile in v2.0.0 see no functional difference until v2.1.0. Documented in CHANGELOG.

### D1.4 — test-strategy
**Decision:** Test `check-prereqs.js` by calling its exported functions (`checkNode`, `checkGit`) rather than spawning the CLI.
**Rationale:** Vitest's tempdir fixture pattern doesn't help here (no filesystem to set up) and spawning a subprocess for every assertion is slow. The pure functions are deterministic given the same node/git environment.
**Impact:** Low. We lose the CLI-framing assertion (help text, exit codes) but keep them in one "main()" integration test that spawns once.

### D1.5 — workaround
**Decision:** `postinstall` banner from the implementation plan (C9) deferred to v2.0.1.
**Rationale:** Adding a postinstall script has its own review surface (npm security warnings, silent installs from CI matrices). For PR 1's "foundation ships as v2.0.0" scope, the `complexity_profile` missing-key default is sufficient to preserve existing installs. The banner is a nice-to-have, not a correctness requirement.
**Impact:** Low. Existing users on `^1.x` still upgrade silently and get medium behavior; they just won't see a one-liner saying so.
