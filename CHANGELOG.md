# Changelog

## [1.0.19] - 2026-04-16

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
