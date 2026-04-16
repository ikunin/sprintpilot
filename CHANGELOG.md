# Changelog

## [Unreleased]

### Changed
- Installer rewritten in pure Node.js (was Bash). Eliminates the Windows WSL/Git-Bash PATH detection problem entirely — no bash is spawned at any point during install or uninstall. Matches the architecture used by the upstream `bmad-method` package.
- Installer now respects BMAD's `output_folder` setting from `_bmad/bmm/config.yaml`. Skill files and the agent-rules template use `{output_folder}`, `{planning_artifacts}`, and `{implementation_artifacts}` placeholders; the installer substitutes the configured values when copying files to each tool directory. Default remains `_bmad-output`.
- Runtime helper scripts (lock, detect-platform, health-check, sanitize-branch, sync-status, stage-and-commit, create-pr, lint-changed) rewritten in pure Node.js. Workflow invocations switched from `bash .../scripts/*.sh` to `node .../scripts/*.js`. No bash anywhere in the addon surface — the Windows WSL problem is now impossible to hit at runtime as well.

### Added
- Dependencies: `commander`, `@clack/prompts`, `@clack/core`, `fs-extra`, `js-yaml`, `semver`, `picocolors`. Runtime scripts have **zero runtime dependencies** — they use Node built-ins only (`fs`, `child_process`, `crypto`, `https`).
- Interactive tool picker now uses `@clack/prompts` (arrow-key multiselect) instead of numbered text prompt.
- `_bmad-addons/lib/runtime/` — shared zero-dep helpers consumed by runtime scripts (arg parsing, git wrapper, YAML-lite, secrets scan, etc.).
- Test suite migrated from Bats to Vitest: 9 script suites (`tests/scripts/*.test.ts`) plus new unit tests for helper modules (`tests/unit/*.test.ts`). 187 tests covering runtime scripts + installer helpers (args parsing, YAML shape, markers, secrets glob, bmad-config precedence, gitignore handling, placeholder substitution). Runs in ~13s, no Bats dependency.

### Removed
- `bin/bmad-autopilot-addon.sh`, `_bmad-addons/install.sh`, `_bmad-addons/uninstall.sh` — replaced by Node.js equivalents under `lib/`.
- `_bmad-addons/scripts/*.sh` — all 8 bash runtime scripts replaced by `.js` equivalents at the same paths.
- Bats test suite (`tests/scripts/*.bats`, `tests/scripts/helpers/setup.bash`) — replaced by Vitest equivalents.

### Fixed (code review)
- **[CRITICAL]** Lock acquire race: two processes both seeing `FREE` could both write. Now uses `fs.openSync(..., 'wx')` for atomic exclusive create; stale takeover re-runs the exclusive create after unlink.
- Lock integrity: corrupt/directory/unreadable lock files are now treated as `LOCKED` instead of silently evicted as stale. Future-dated `lockTime` (clock skew) is treated as `STALE` to prevent locks that never expire.
- `sync-status.js` / `lib/core/markers.js`: atomic write now falls back to `copyFile + unlink` on `EXDEV` (cross-device rename, e.g. Docker volumes). Tmp file names include 4 random bytes to prevent collision between concurrent writers.
- `yaml-lite.js` `replaceStoryBlock`: no longer inflates blank lines across repeated upserts; emits exactly one separator. `readStoryField` correctly exits a block on any line at or shallower than the story's indent (previous regex allowed spill into siblings).
- `yaml-lite.js` `yamlSafe`: now quotes YAML-reserved string literals (`true`, `false`, `yes`, `no`, `null`, `on`, `off`, etc.) so they round-trip as strings instead of being re-parsed as booleans/null.
- `sanitize-branch.js`: rejects `--max-length` below 8 (prior behavior silently produced branch names exceeding the limit). Strips `/` and collapses `..` sequences to prevent path-traversal-shaped branch names.
- `secrets.js`: secret detection now recognizes concrete real-world key formats (AWS `AKIA*`, GitHub `ghp_*`/`gho_*`/`github_pat_*`, OpenAI-style `sk-*`, Stripe `sk_live_*`/`sk_test_*`, Slack `xox[baprs]-*`, Google `AIza*`, PEM private-key headers) — previously only matched the literal words "API_KEY", "SECRET", etc.
- `stage-and-commit.js`: uses `lstat` to skip symlinks; skips secret scan for files larger than 2 MB (prevents OOM on accidentally-staged multi-MB logs); `.gitignore` check now uses exact line match instead of substring (was fooled by the entry appearing in a comment).
- `lib/core/markers.js` `findBlock`: uses `lastIndexOf(END)` so nested/duplicate BEGIN markers from a prior bad install collapse cleanly on the next upsert.
- `lib/core/bmad-config.js`: deterministic module precedence (sort `readdir` entries); loud warning on malformed YAML instead of silent fallback to default `output_folder`.
- `lib/runtime/http.js`: response body capped at 5 MB (prevents OOM on unbounded / malicious responses); 3xx redirects surfaced explicitly instead of silently succeeding.
- `create-pr.js`: remote URL parsing handles GitLab subgroups and SSH aliases (`ssh://`, `git@host-alias:`). Owner/repo components validated against a safe character set before interpolation into REST paths. Error logs redact `Authorization` / `Bearer` / `token` fields.
- `lib/commands/install.js`: skill install uses `.new` staging + `fs.move` so Ctrl-C between remove+copy can't leave a tool with no skill. Backup timestamps use UTC components (DST-safe).
- `lib/runtime/spawn.js`: registers `proc.on('error', ...)` so spawn-time ENOENT rejects the Promise instead of crashing on `proc.stdin.write`.
- `lint-changed.js`: removed hardcoded `/google_checks.xml` Linux-absolute path; runs `checkstyle` without `-c` when no config file is present.
- `sync-status.js`: `worktree_cleaned` field now only emitted when the flag is explicitly passed (prior default of `false` silently overwrote prior `true` on every update).
- Stale `.sh` filename references updated to `.js` in skill workflow prose and config comments.

### Fixed (code review, round 2)
- `yaml-lite.js` `readStoryField` now strips quotes only when the value is fully paired-quoted, and unescapes `\"` within — prior behavior mangled values containing embedded quotes.
- `yaml-lite.js` `replaceStoryBlock` recognizes any indent greater than the header's indent as block continuation (not hardcoded to 4 spaces) — externally-edited files no longer leave orphaned fields after replace.
- `sync-status.js` EXDEV fallback simplified: on cross-device rename failure, write the content directly to the target (we already hold it in memory). The previous `copyFileSync` path could truncate the target on mid-copy failure.
- `stage-and-commit.js` excludes deleted files from the `git add` loop; they are handled exclusively by the `git rm` pass. Eliminates a spurious "could not add" warning on deletions. `isBinaryFile` is now computed once per file instead of twice.
- `lock.js` stale-takeover retries once if the re-read shows the lock became `FREE` (another process released it between our unlink and our exclusive-create retry). Previously reported `LOCKED` incorrectly.
- `lock.js` `writeLockExclusive` unlinks the partially-created lockfile if `writeSync` fails (ENOSPC, EIO). The previous path left a zero-byte file that future acquirers treated as "corrupt" and could not evict.
- `lock.js` diagnostic IDs (`non-file-lock-path`, `unreadable-lock`, `corrupt-lock`) no longer contain spaces or parentheses, preserving the `STATE:ID:AGE` stdout contract for downstream parsers.
- `markers.js` `findBlock` now requires `BEGIN` and `END` to be on their own line. Plain-text mentions of the marker string inside code blocks or user documentation no longer cause `stripBlock` to delete intervening content.
- `http.js` `postJson` uses a `settled` guard so the Promise resolves or rejects exactly once, eliminating non-deterministic error messages on the size-cap abort path. Also accepts `http://` URLs (for local integration tests) alongside `https://`.
- `create-pr.js` `parseGitRemote` rejects SCP-style inputs that start with `[` (malformed IPv6) or contain a `:` in the path segment (non-standard port form that would otherwise misroute REST calls). Exports `parseGitRemote` and `redactAuth` for direct unit testing.
- `install.js` skill upgrades use a three-phase swap (`copy → rename target→.old → rename .new→target → remove .old`) so the only non-atomic window is a single same-filesystem rename. Any intermediate failure restores the prior skill directory.
- `secrets.js` Google-API-key regex now bounded `[35,99]\b` to reduce false positives on long base64-like blobs that happen to start with `AIza`. `matchesSecret` is exported (and `SECRET_FORMATS`) so external callers can opt into the combined keyword + concrete-format check instead of the legacy keyword-only `SECRET_PATTERN` alias.

### Added (regression tests, round 2)
- `tests/unit/create-pr-helpers.test.ts` — 14 tests for `parseGitRemote` (SSH aliases, GitLab subgroups, IPv6 rejection, `:` in path rejection) and `redactAuth` (Authorization header, Bearer token, API key fields).
- `tests/unit/http.test.ts` — 6 tests against a local `http.createServer` covering 201 success, 302 redirect passthrough, 5 MB body cap, timeout, and malformed URL.
- `tests/unit/spawn.test.ts` — 5 tests including ENOENT cleanup (binary does not exist).
- `tests/unit/install-timestamp.test.ts` — source-level guard that `install.js` uses only `getUTC*` accessors, preventing DST collisions from sneaking back in.
- `tests/unit/bmad-config.test.ts` — added tests for alphabetical module fallback precedence and the "warn loudly on malformed YAML" path.
- `tests/unit/markers.test.ts` — added a regression test that a plain-text mention of `END` inside user notes does NOT corrupt the document.
- `tests/scripts/stage-and-commit.test.ts` — added symlink-skip and 2 MB scan-skip regression tests.

### Fixed (test harness)
- `tests/e2e/harness/temp-project.ts` no longer references the removed `install.sh`. The harness now invokes `node bin/bmad-autopilot-addon.js install` directly via `execFileSync` (no shell). Previously, when `install.sh` was absent the install block was silently skipped, leaving the temp project with no `.claude/skills/` — autopilot slash commands then went unresolved and every session exited at $0.
- `tests/e2e/greenfield.test.ts` sprint-status assertion relaxed from `/status:\s*done/` to `/epic-\d+:\s*done/` to match the actual `development_status:` yaml shape produced by `bmad-sprint-planning`.

### Notes
- Minimum Node version bumped to 18 (required by `@clack/prompts`).

## [1.0.20] - 2026-04-16

### Fixed
- Windows: shell wrapper used `exec bash` which resolved to WSL's bash instead of Git Bash, causing `execvpe(/bin/bash) failed` errors. Now uses `$BASH` to stay in the same Git Bash instance the Node.js launcher resolved.
- Windows: Git Bash resolver now finds Git installed via Scoop, Chocolatey, or custom paths by deriving the bash location from `git.exe` in PATH (fallback when standard install directories don't match).

## [1.0.18] - 2026-04-14

### Added
- `/bmad-addon-update` skill — check for updates and install the latest version from within your coding agent
- `check-update` CLI command — check if a newer version is available on npm (`npx bmad-autopilot-addon check-update`)
- Post-install update notice — installer shows a banner when a newer version exists on npm

### Fixed
- `--version` and `check-update` now read from the project's installed manifest, not the npx-cached package

## [1.0.17] - 2026-04-14

### Fixed
- Autopilot state file lost `stories_remaining` and `next_skill` across sessions — all state writes now persist the complete field set
- Autopilot terminated prematurely when `next_skill` was empty despite undone stories — added recovery that re-reads `sprint-status.yaml` and determines the correct next step
- Step 2 recovery now sets `current_story` alongside `next_skill` to prevent mismatched story/skill pairing
- Step 5 recovery heuristic uses `current_bmad_step` instead of test-file presence to correctly distinguish RED/GREEN phase from code-review phase

### Changed
- State file checkpoint (step 9) now uses explicit schema instead of ambiguous "full current state"
- `stories_remaining` list is actively maintained — entries removed as stories complete

## [1.0.16] - 2026-04-14

### Added
- `/ship` and `/publish` project commands (moved from published skills to `.claude/commands/`)

### Fixed
- Install now copies runtime resources (`_bmad-addons/`) to the target project
- Autopilot git recovery for pushed-but-unmerged story branches
- 5 bugs found in adversarial review of git recovery logic
- Partial `sync-status.sh` calls in boot reconciliation and checkpoint sweep
- Pre-existing test: added `.gitignore` to prevent stderr in SHA check

### Changed
- Added tests for `--merge-status` flag in `sync-status.sh`

## [1.0.13] - 2026-04-08

### Fixed
- Windows: launcher now explicitly prefers Git Bash over WSL's bash, which cannot resolve `C:/...` paths and broke `npx bmad-autopilot-addon` when both were installed.

## [1.0.12] - 2026-04-08

### Fixed
- Windows: `npx bmad-autopilot-addon` failed because Git Bash interpreted backslashes in the launcher script path as escapes. Path is now normalized to forward slashes.

## [1.0.11] - 2026-04-04

### Fixed
- npm website showing stale README (re-publish with updated metadata)

## [1.0.10] - 2026-04-03

### Added
- Automated npm publishing via GitHub Actions trusted publishers (OIDC, no tokens needed)
- Provenance attestation on published packages
- Shields.io badges in README (npm version, downloads, license, BMAD compat, Node.js, tools, stars)
- Add-on skills table and configuration section in README
- `/ship` and `/release` project skills for streamlined workflows

### Changed
- Removed BMAD standard TEA skills table from README (belongs in BMAD docs, not add-on)

### Fixed
- GitHub Actions publish workflow: Node 24 for npm 11.5.1+ OIDC support, removed `registry-url` that conflicted with trusted publishing

## [1.0.7] - 2026-04-03

### Fixed
- Bin script symlink resolution for npx compatibility
- npm 11 bin path validation (removed `./` prefix)
- Node.js wrapper for bin entry to pass npm publish validation
- Synced manifest.yaml version with package.json

### Added
- **npx installation** — `npx bmad-autopilot-addon` replaces manual `bash _bmad-addons/install.sh`
- Post-install output with usage guide, configuration reference, and skill descriptions
- License and author info in post-install output
- Package keywords (orchestrator, gemini)

### Changed
- Updated all documentation to reference `npx bmad-autopilot-addon` installation method

## [1.0.0] - 2026-03-29

### Added

#### Multi-Agent Skills (7 new skills, 19 subagent prompts)

- **bmad-ma-code-review** — Parallel 3-layer code review
  - Blind Hunter (adversarial, diff-only)
  - Edge Case Hunter (boundary conditions, full project access)
  - Acceptance Auditor (AC verification)
  - Triage with deduplication and contradiction handling

- **bmad-ma-codebase-map** — 5-stream parallel codebase analysis
  - Stack Analyzer, Architecture Mapper, Quality Assessor
  - Concerns Hunter, Integration Mapper
  - Outputs to `_bmad-output/codebase-analysis/`

- **bmad-ma-assess** — Tech debt and migration assessment
  - Dependency Auditor (CVEs, outdated packages)
  - Debt Classifier (prioritized with effort estimates)
  - Migration Analyzer (upgrade paths and roadmap)
  - Produces `brownfield-assessment.md`

- **bmad-ma-reverse-architect** — Bottom-up architecture extraction
  - Component Mapper, Data Flow Tracer, Pattern Extractor
  - Produces BMAD-compatible `architecture.md`

- **bmad-ma-migrate** — 12-step migration planning
  - 4 subagent fan-outs (Stack Mapper, Dependency Analyzer, Test Parity, Risk Assessor)
  - Templates: migration plan, epics, component cards
  - Resources: strategy reference, coexistence patterns
  - Produces `migration-plan.md`, `migration-epics.md`, `migration-tracking.yaml`

- **bmad-ma-research** — Parallel research fan-out with WebSearch/WebFetch

- **bmad-ma-party-mode** — Real parallel multi-persona discussions

#### Git Workflow Integration
- Enhanced `bmad-autopilot-on` with git operations between skill invocations
- Enhanced `bmad-autopilot-off` with git status report and lock release
- Worktree isolation via `EnterWorktree`/`ExitWorktree`
- Sprint-status.yaml sync from worktree to project root
- Git status separated from sprint-status.yaml — addon writes git metadata
  (branch, commit, PR URL, push status, lint result) to its own `git-status.yaml`

#### Helper Scripts (8)
- `detect-platform.sh` — GitHub/GitLab/Bitbucket/Gitea auto-detection
- `sanitize-branch.sh` — Story key to valid branch name
- `lock.sh` — Session lock (epoch + UUID, 30m stale timeout)
- `stage-and-commit.sh` — Explicit staging with pre-commit checks, binary file detection, `--file-list` cross-reference, `.gitignore` coverage verification
- `sync-status.sh` — Simple YAML write to `git-status.yaml`
- `lint-changed.sh` — Language-aware linting of changed files, multi-language monorepo support
- `health-check.sh` — Orphaned worktree classification with `git fetch` before commit comparison
- `create-pr.sh` — PR/MR creation with remote existence pre-check and graceful fallback

#### Platform Support
- GitHub (`gh` CLI)
- GitLab (`glab` CLI)
- Bitbucket (`bb` CLI + REST API fallback with `BITBUCKET_TOKEN`)
- Gitea (`tea` CLI + REST API fallback with `GITEA_TOKEN` + `base_url`)

#### Linting — 16 Languages
- JavaScript/TypeScript (eslint, biome)
- Python (ruff, flake8, pylint)
- Go (golangci-lint, go vet)
- Rust (clippy)
- Ruby (rubocop)
- Java (checkstyle, pmd)
- C/C++ (cppcheck, clang-tidy)
- C# (dotnet format)
- Swift (swiftlint)
- PL/SQL (sqlfluff — Oracle, PostgreSQL, MySQL, T-SQL dialects)
- Kotlin (ktlint, detekt)
- PHP (phpstan, phpcs)

#### Configuration
- Git workflow config (`modules/git/config.yaml`)
- Platform commands (`modules/git/platform.yaml`)
- Commit and PR templates
- Secrets allowlist

#### System Prompt Enforcement
- `BMAD.md` in `_bmad-addons/`: comprehensive skill reference by lifecycle phase
- `templates/agent-rules.md`: self-sufficient enforcement block with `<!-- BEGIN/END -->` markers
- Installer creates per-tool system prompt files:
  - Claude Code: `CLAUDE.md` + `AGENTS.md` (via `@include`)
  - Cursor/Roo/Kiro/Trae: dedicated `bmad.md` in rules directory
  - Windsurf/Cline/Gemini CLI/Copilot: marker-based append to shared rules file
- Marker-based idempotent updates (re-run install safely, user content preserved)
- Uninstaller surgically removes BMAD blocks only

#### Windows Compatibility
- `sanitize-branch.sh`: `sha256sum` before `shasum` fallback
- `stage-and-commit.sh`: `wc -c` fallback for `stat`, guard `file` command
- All scripts work on macOS, Linux, and Git Bash/WSL

#### Infrastructure
- `install.sh` with `--dry-run`, `--force`, backup with retention
- `uninstall.sh` with dirty-check worktree cleanup
- `manifest.yaml` with BMAD compatibility tracking
- 9 supported tools (Claude Code, Cursor, Windsurf, Cline, Roo, Trae, Kiro, GitHub Copilot, Gemini CLI)

#### Documentation
- README.md with quick start and skill overview
- Installation guide, usage guide, architecture docs
- Configuration reference, contributing guide
- Guide for adding new platforms and language linters
- GSD attribution for `bmad-ma-codebase-map` inspiration
