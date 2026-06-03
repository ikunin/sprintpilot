# Concept — pluggable security scanning (Trivy as reference adapter)

> Status: **proposal / concept**. Not yet implemented. Describes how Sprintpilot could run security scanners inside the autopilot cycle, grounded in the existing gate/verify/config architecture. The design is **scanner-agnostic**: [Trivy](https://trivy.dev) is the recommended default and reference adapter, but the gate runs *any* configured scanner through a common contract.

## Summary

Add an **opt-in, deterministic security-scan gate** to the per-story cycle, modeled on the existing lint gate (`post-green-gates.js` + `git.lint.{enabled,blocking}` + `verify.runPostGreenGates`). The gate itself knows nothing about Trivy: it runs one or more **scanner adapters**, each of which emits a **normalized finding schema**, and the orchestrator gates / triages on the merged, deduplicated stream. Findings can be *record-only* or *verify-blocking*, and (optionally) fed into the `bmad-code-review` triage (`block` / `patch` / `defer`) so they ride the existing PATCH_APPLY → PATCH_RETEST loop. The pure FSM is untouched; the LLM never invokes a scanner ad-hoc.

## Why pluggable (not a single hard-wired scanner)

No single scanner is best at everything, teams standardize on different tools, and licensing/policy varies. Sprintpilot already solves "pluggable backend, auto-detected, preference-ordered" three times — this is the same shape:

| Existing pattern | Mechanism |
|---|---|
| Linters | `git.lint.linters.{language}: [list]` — first-installed wins, empty list disables |
| Test runners | per-framework adapters (vitest / jest / pytest …) detected from the project |
| Git platforms | `git.platform.provider: auto` → github / gitlab / bitbucket / gitea |

Security scanning adopts the identical model: a **per-scan-class registry** of scanner adapters, auto-detected, with Trivy as the default because one static binary covers vuln + IaC + secret + license + SBOM.

## How it fits Sprintpilot's architecture

Sprintpilot separates a **deterministic pure FSM** from an **impure CLI edge** (`docs/ARCHITECTURE.md`). A scanner is deterministic I/O → it lives at the edge as a script, exactly like linting:

- **Today (lint):** after `bmad-dev-story` GREEN passes `verify`, `verify.runPostGreenGates(ctx)` shells out to `scripts/post-green-gates.js`, which runs gates in order and returns `{ failed, summary }`. `git.lint.blocking` decides reject-verify vs record-only.
- **Proposed (security):** `verify.runSecurityScan(ctx)` shells out to `scripts/security-scan.js`, which loads the configured adapters, runs them, merges their normalized findings, and returns `{ failed, summary, findings }`. `git.security.blocking` decides reject-verify vs record-only.

`security-scan.js` is the scanner-agnostic driver; each scanner is a thin adapter behind a fixed contract. This is gate **infrastructure beside lint** — not a new BMad skill (Sprintpilot never invents BMad-level workflows).

## Scanner adapter contract

Each adapter is a small module (e.g. `_Sprintpilot/lib/runtime/scanners/<id>.js`) implementing:

```js
module.exports = {
  id: 'trivy',                       // stable identifier used in config + ledger
  classes: ['vuln','iac','secret','license','sbom'], // what this scanner covers
  detect(ctx) {                      // binary present + version >= floor?
    // probe `<bin> --version`; return { available: bool, version?: string }
  },
  async scan(ctx) {                  // ctx: { class, scope, changedFiles, projectRoot,
                                     //        severityThreshold, ignoreFile, timeoutMs }
    // shell out, parse native output, return the NORMALIZED report (below)
  },
};
```

The driver (`security-scan.js`) is the only orchestrator-aware piece. Adapters never touch state, the ledger, or the FSM — they translate `<tool native output> → normalized findings`. Adding a scanner = adding one adapter file + a registry entry; no changes to verify/state-machine.

## Normalized finding schema (the lingua franca)

Every adapter emits the same shape, so the gate, triage, and ledger are scanner-independent:

```json
{
  "ok": false,
  "summary": "2 HIGH, 1 CRITICAL across 3 packages (trivy, grype)",
  "counts": { "CRITICAL": 1, "HIGH": 2, "MEDIUM": 0, "LOW": 5 },
  "findings": [
    {
      "scanner": "trivy",            // provenance — which adapter reported it
      "class": "vuln",               // vuln | sast | secret | iac | license
      "id": "CVE-2024-XXXX",         // CVE / rule-id / GHSA — the dedup key
      "severity": "CRITICAL",        // normalized: CRITICAL|HIGH|MEDIUM|LOW|INFO
      "target": "package-lock.json",
      "pkg": "left-pad@1.0.0",
      "fixed_version": "1.0.1",
      "title": "…",
      "action": "patch"             // block | patch | defer (Phase 2)
    }
  ]
}
```

`severity` and `action` are normalized so the orchestrator's mapping (below) is uniform regardless of which tool produced the finding. `action` reuses the exact `block`/`patch`/`defer` vocabulary `bmad-code-review` already emits and `verify.js` already validates.

## Candidate scanners by class

Reference adapters the contract is designed to accommodate (ship Trivy first; add others as adapters):

| Class | Scanners |
|---|---|
| Vulnerable deps (SCA) | **Trivy**, Grype, osv-scanner, Snyk |
| SAST / code | Semgrep, Bandit (py), CodeQL |
| Secrets | **Trivy**, gitleaks, trufflehog |
| IaC misconfig | **Trivy** (config), Checkov, tfsec, KICS |
| License | **Trivy**, licensee |
| SBOM | **Trivy** (cyclonedx/spdx), Syft |

## Running multiple scanners + dedup

Two `merge_strategy` modes (mirrors lint's "first-installed wins", extended):

- **`first_available`** (default): per class, use the first *detected* scanner in the preference list. Fast, deterministic, no overlap.
- **`run_all`**: run every detected scanner for a class and **merge**. Findings are deduplicated by `(class, id, target, pkg)`; on collision keep the highest severity and the union of `fixed_version`s, and record all reporting scanners in provenance. Use when you want belt-and-suspenders coverage (e.g. Trivy + Grype for vulns).

## Configuration

New `security` block (proposed in `modules/git/config.yaml` alongside `lint`; promote to `modules/security/config.yaml` if it grows):

```yaml
security:
  enabled: false              # opt-in (Phase 1 default)
  blocking: false             # like lint.blocking — reject verify vs record-only
  severity_threshold: HIGH    # gate only on >= this (CRITICAL|HIGH|MEDIUM|LOW)
  scan_scope: changed         # changed (per-story, fast) | repo (full)
  gate_on: new                # new (delta/baseline) | all — gate only on story-introduced findings
  baseline_file: .security-baseline.json   # accepted pre-existing set (scan_scope: repo)
  merge_strategy: first_available   # first_available | run_all
  feed_to_review: false       # Phase 2: route findings into code-review triage
  # Per-class scanner preference. First detected wins (or all run + merge,
  # per merge_strategy). Empty list disables that class entirely.
  scanners:
    vuln:    [trivy, grype, osv-scanner]
    secret:  [trivy, gitleaks]
    iac:     [trivy, checkov, tfsec]
    sast:    [semgrep]
    license: [trivy]
  ignore_file: .trivyignore   # per-scanner native ignore (user-authored pre-seed)
  timeout_minutes: 5          # enforced as < the governing phase_timeout_minutes
  on_missing_scanner: warn    # warn | skip | halt — NO scanner available for an enabled class
  on_scanner_error: warn      # warn | halt — scanner ran but failed (network/DB/parse/OOM)
  output_limit: 100           # cap finding lines injected into LLM context
  db:
    skip_update: false        # true = use cached DB (faster, possibly stale)
    cache_dir: null           # pre-provisioned DB path for offline/airgapped use
```

These map through `profile-rules.js` to flat `profile.security_*` fields, exactly as `git.lint.*` → `profile.lint_*` today.

### Profile defaults (Adaptive Process Scaling)

| Profile | security default |
|---|---|
| `nano` | off |
| `small` | `enabled`, classes `[secret, iac]`, record-only |
| `medium` | `enabled`, `+vuln` at `HIGH`, record-only |
| `large` | `enabled`, `vuln` at `CRITICAL` **blocking**, `feed_to_review`, pre-merge gate |
| `legacy` | off (preserves pre-feature behavior byte-for-byte) |

## Integration points

Five hooks, ordered by value/risk. The recommended rollout starts with #1.

| # | Hook | What runs | Default disposition |
|---|---|---|---|
| 1 | **Post-GREEN gate** | configured scanners on changed scope after DEV_GREEN, beside lint | Record-only (non-blocking) |
| 2 | **Code-review layer** | normalized findings → `bmad-code-review` `findings[]` triage | HIGH/CRITICAL → `patch`/`block`, low → `defer` |
| 3 | **Pre-merge / `story_land` gate** | scan before `create-pr.js` / `land-this-pr.js` | Blocking on CRITICAL at the boundary to `main` |
| 4 | **Epic boundary / retrospective** | full-repo summary + SBOM into the retro artifact | Informational |
| 5 | **Secret-scan complement** | a secret-class scanner as a deeper layer | Augments, does not replace, the in-tree commit screen |

### On the secret-scanning overlap

`stage-and-commit.js` already screens staged content against `lib/runtime/secrets` + `.secrets-allowlist` with no external dependency. That **stays the always-on commit guard** (scanners may be absent). A secret-class scanner (Trivy/gitleaks) is an *optional deeper layer* — never a replacement — so the baseline guarantee never depends on an external install.

## Severity → action mapping (Phase 2)

Configurable, applied uniformly to the normalized stream regardless of scanner: `CRITICAL` → `block` (or `patch` when a `fixed_version` exists), `HIGH` → `patch`, `MEDIUM`/`LOW` → `defer`. Findings then ride the existing PATCH_APPLY → PATCH_RETEST loop with no new control flow.

## Gating on *new* findings only (baseline / delta)

**The single biggest adoption risk.** A real brownfield repo already has dozens–hundreds of findings at threshold; a naive gate would halt the autopilot on story 1 forever, blaming it for debt it didn't introduce. The gate must separate **findings this story introduced** from **pre-existing** ones. Three mechanisms, combined:

- **Changed-scope scanning** (`scan_scope: changed`, the default) only scans files in the story's diff — a story that doesn't touch a lockfile never surfaces that lockfile's CVEs. Cheap first filter. **Limitation worth stating plainly:** a *newly-disclosed* CVE in an *unchanged* dependency is invisible to the per-story gate. That is deliberate — the inner loop answers "did this story add risk?", not "is the whole repo clean?" The latter is the periodic full-repo CI scan's job.
- **Baseline diff** (`scan_scope: repo` + baseline): for full-repo scanners, snapshot the accepted set at sprint start (`.security-baseline.json`, fingerprinted findings) and gate only on findings absent from the baseline. New → gate; pre-existing → recorded, not gating. The baseline is refreshed by an explicit command, never silently.
- **Introduced-by-diff attribution**: where a scanner reports line/file locations (secrets, IaC, SAST), intersect with the diff hunks so only findings on changed lines gate. Package-level SCA falls back to "present in the diff's dependency delta."

## Triage persistence — deferred findings must not re-block

When a finding is triaged `defer` / accepted-risk, that decision must **stick across scans**, or the next story re-surfaces it and the autopilot loops — the same failure mode the v2.6.5 exclusion ledger was built to prevent for stories. Reuse that pattern:

- A Sprintpilot-owned, **scanner-agnostic suppression ledger** (`_bmad-output/implementation-artifacts/security-suppressions.json`), keyed by a stable **fingerprint** (`class + id + target + pkg`), replace-on-write like `excluded-stories.json`. The gate drops suppressed findings *before* gating; each entry carries rationale + provenance (LLM triage vs user override) + timestamp for audit.
- Distinct from each scanner's **native ignore file** (`.trivyignore`, `.semgrepignore`): those are user-authored pre-seeds the *adapter* honors; the suppression ledger is the *orchestrator's* record of in-flight triage. Both are respected; neither is auto-edited without provenance.
- **`verify_override` path:** a blocking finding is overridable via the existing `verify_override` signal — the override writes a suppression entry with the user's evidence to `decision-log.yaml`, so it's durable and auditable, not a silent bypass.

## Scan outcomes: clean ≠ found ≠ failed

Three distinct outcomes the driver and adapters must disambiguate — conflating them is the classic scanner-integration bug (Trivy exits non-zero both for "vulns found" with `--exit-code` *and* for "DB pull failed"):

| Outcome | Meaning | Gate behavior |
|---|---|---|
| **clean** | ran, no findings ≥ threshold | pass |
| **findings** | ran, findings ≥ threshold | record / block per `blocking` |
| **error** | failed to run (network, DB, parse, OOM, timeout) | `on_scanner_error`: `warn` (record + continue, default) \| `halt` |

Adapters return an explicit `status: 'clean' | 'findings' | 'error'` rather than overloading exit codes. An `error` is **never** silently treated as "clean" (hides risk) nor "findings" (false-blocks). Partial results (one of N scanners errored) record what succeeded and flag the gap.

## Where it hooks under `nano` (quick-dev)

`nano` runs `bmad-quick-dev` one-shot — there is **no DEV_GREEN phase** to hang the post-GREEN gate on. Options: (a) skip security scanning under `nano` (the documented default — nano targets throwaway/tutorial scope), or (b) run the scan at quick-dev's Commit gate when `security.enabled` is set explicitly. The existing nano→full escalation (on a high-severity quick-dev review finding) gains a natural extra trigger: a CRITICAL security finding escalates the session to the full cycle.

## Scope, diff base & monorepo

- **Diff base.** "Changed" is computed against the story branch's base (`git.base_branch`, usually `main`) — the same base the diff/lint/PR machinery uses — not `HEAD~1`, so *all* of the story's commits are in scope. Under land-as-you-go the predecessor is already merged, so base = `main` stays correct.
- **Monorepo.** `scan_scope: changed` naturally limits to touched paths; adapters that need a project root (lockfile-relative SCA) resolve the nearest manifest above each changed file.

## PR surfacing (SARIF + code scanning)

When findings reach a PR (stacked / pre-merge), surface them where reviewers already look: emit **SARIF** (most scanners support it) as a build artifact so platforms with native code-scanning (GitHub Advanced Security, GitLab) ingest it into their alerts UI, and optionally append a concise findings summary to the PR body (`create-pr.js` already templates it) — counts + top findings + "full report in CI artifact", never the raw dump.

## Recommended phased rollout

- **Phase 1 — Post-GREEN record-only gate.** `scripts/security-scan.js` driver + one adapter (`trivy`) + `git.security` config + `verify.runSecurityScan` + a `security_scan` ledger kind + the three scan outcomes + changed-scope (`gate_on: new`). `enabled: false` by default; findings recorded + surfaced, never blocking. Lowest risk; mirrors lint's introduction.
- **Phase 2 — Triage + blocking + suppression + a 2nd adapter.** Normalize into the code-review `findings[]` shape; add `blocking` + the suppression ledger + `verify_override` path; add a second adapter (e.g. `gitleaks` or `grype`) to prove the contract is genuinely scanner-agnostic.
- **Phase 3 — Baseline, pre-merge gate, SBOM, `run_all`.** Add full-repo baseline diffing, the `story_land` pre-merge scan + SARIF/PR surfacing, the epic-boundary SBOM + retro metrics, and multi-scanner dedup.

## Graceful degradation

Scanners are external binaries and are **not** bundled (Sprintpilot bundles only `js-yaml`). Detection mirrors the `dot`/graphviz fallback in `resolve-dag.js`, but per-adapter:

- Each adapter's `detect()` probes its binary once per scan.
- For a class, walk the preference list and use the first available adapter. If *none* is available for an enabled class, apply `on_missing_scanner`: `warn` (default — log an install hint, record `security_scan_skipped`, continue), `skip` (silent), or `halt` (teams that mandate scanning).
- A missing scanner disables *that class*, never the cycle — same philosophy as a missing linter disabling that language's gate.

## Observability

- **Ledger:** new append-only kinds `security_scan` (summary + counts + which scanners ran + versions) and `security_scan_skipped`. `action-ledger.js` tolerates unknown kinds, so emitting them needs no consumer change.
- **`autopilot progress`:** a `Security: 1 CRITICAL, 2 HIGH via trivy,grype (threshold HIGH)` line when a scan ran; silenced otherwise (same convention as the issue-tracker line).

## Trust boundary

Consistent with `verify.js` as the boundary between LLM claims and on-disk artifacts: **scans are run by the driver script, not the LLM.** The LLM may *triage* normalized findings (is this CVE reachable? is the misconfig a false positive?) but cannot decide whether a scan ran or fabricate its result. Determinism stays in the orchestrator; adapters are deterministic translators.

## Performance, concurrency, caching & timeouts

- **Changed scope** keeps per-story scans fast (only the story's diff, derived as lint derives changed files).
- **Phase budget.** A scan runs inside a phase governed by `phase_timeout_minutes` (v2.4.0 wall-clock budgets). `security.timeout_minutes` **must** be smaller than the governing phase budget or a slow scan trips a spurious `phase_timeout_exceeded` halt; the driver enforces `min(security.timeout, phase_budget − margin)`.
- **Caching.** Cache a scan result keyed by `(adapter, adapter_version, db_version, diff_hash)` so retries, mid-skill resumes (`resume_mid_skill`), and PATCH_RETEST don't redundantly re-scan an unchanged diff.
- **Concurrency.** Under `ma.parallel_stories`, multiple worktrees scan at once; shared scanner DB caches need a read lock (reuse `lock.js`) and a bounded parallel-scan count to avoid thrashing the vuln DB.
- **DB refresh.** Per-adapter vuln DBs refresh at session start / epic boundary, not per story (`skip_update` between).
- CI stays the full-repo + container-image net — the local gate is fast diff feedback, the same "local affected vs CI full" split used for tests and lint.

## Offline / airgapped operation

Most vuln scanners pull a DB from a remote registry (Trivy from ghcr.io, Grype from its DB host) — a network-egress and supply-chain consideration in locked-down environments. The design must support a pre-provisioned DB path (`db.cache_dir`), `skip_update` so no scan reaches the network mid-sprint, and a documented offline-DB distribution step. A scanner that requires the network and has none degrades to the `error` outcome → `on_scanner_error` policy, never wedging the cycle.

## Determinism caveat

Unlike lint, security results are **time-dependent**: the same code scans differently as new CVEs are disclosed and DBs update. The inner-loop gate question ("did this story introduce *newly-known* risk?") is inherently a moving target. For reproducible results (audits, re-runs), pin the DB version and record it in the `security_scan` ledger entry; treat newly-disclosed CVEs in untouched code as CI's job, not the per-story gate's.

## Install-time onboarding

The interactive installer should probe for installed scanners and, when any are present, offer to enable security scanning with a sensible default class set — the same UX as the existing profile / git-mode prompts. Absent scanners → leave disabled with a one-line install hint, never a hard requirement (mirrors how a missing `dot` degrades the DAG renderer).

## Retrospective & sprint-health metrics

The epic-boundary retrospective already appends sprint-health metrics. Extend with security deltas: findings **introduced vs fixed** this epic (by severity/class) and the current suppression count — cheap to derive from `security_scan` ledger entries, and it gives the human a per-epic security trend alongside the SBOM.

## Testing the feature (offline)

Adapters must be unit-testable without their binary installed in CI: record a **native-output fixture** per scanner (real `trivy --format json`, `grype -o json`, …) and test the adapter's normalization against it — the fixture-driven approach the suite already uses. The driver, merge/dedup, severity mapping, baseline diff, and suppression logic are pure and tested directly. `detect()` is the only piece needing the real binary — gate it behind an opt-in live test like the LLM e2e suite.

## Risks & open questions

- **Version/contract drift across scanners.** Each adapter pins a minimum tool version and records the detected version in the ledger.
- **Normalization fidelity.** Mapping every tool's native severity + output into one schema is the main implementation risk; the adapter contract isolates it per-tool and a normalization test fixture per adapter guards it.
- **False positives.** Rely on each scanner's own ignore file (user-owned); never auto-edit. LLM-triaged false positives → `defer`, not silently dropped.
- **Container images.** Image scanning needs a built image — out of scope for the per-story inner loop; fits CI or an explicit opt-in target.
- **License / SAST noise.** License "violations" and some SAST rules are policy, not bugs — keep informational unless the user defines an explicit policy.

## Non-goals

- Bundling any scanner binary (all stay external, user-installed).
- Replacing CI-level or container-runtime scanning.
- A new BMad skill — this is gate infrastructure beside lint.
- Auto-remediation beyond the existing PATCH loop (no silent dependency bumps without the normal review/test gate).

## Example flow (Phase 2, `large` profile, `first_available`)

```
… DEV_GREEN passes verify
→ post-green gates: lint OK
→ security-scan.js: vuln→trivy detected; secret→trivy; iac→(none, skipped, warn)
   trivy(changed): CVE-2024-XXXX CRITICAL in left-pad@1.0.0 (fixed 1.0.1)
   ↳ normalized → finding { scanner:"trivy", action:"patch" }, fed into code-review triage
→ CODE_REVIEW: 3 review layers + 1 security finding → triaged
→ PATCH_APPLY: bump left-pad to 1.0.1 as its own commit
→ PATCH_RETEST: tests green, re-scan clean
→ STORY_DONE → STORY_LAND (pre-merge scan clean) → next story
```

## Pointers (existing code this would extend)

- `_Sprintpilot/scripts/post-green-gates.js` — gate-pipeline template to mirror with `security-scan.js`.
- `_Sprintpilot/lib/orchestrator/verify.js` (`runPostGreenGates`) — where `runSecurityScan` sits.
- `_Sprintpilot/lib/orchestrator/profile-rules.js` — `git.lint.*` → `profile.lint_*` mapping to copy; `git.lint.linters` is the per-class registry precedent.
- `_Sprintpilot/scripts/detect-platform.js` — `provider: auto` auto-detection precedent for the adapter registry.
- `_Sprintpilot/modules/git/config.yaml` — `lint:` block to mirror as `security:`.
- `_Sprintpilot/scripts/stage-and-commit.js` + `lib/runtime/secrets` — the in-tree secret screen scanners complement.
- `_Sprintpilot/lib/orchestrator/action-ledger.js` — append-only ledger, tolerant of new kinds.
- `_Sprintpilot/scripts/resolve-dag.js` — missing-binary graceful-degradation pattern.
