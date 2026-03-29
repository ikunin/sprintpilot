# Changelog

## [2.0.3] - 2026-03-29

### Changed
- **GSD attribution** — credited [GSD map-codebase](https://github.com/gsd-build/get-shit-done) as inspiration for `bmad-ma-codebase-map` in SKILL.md, workflow.md, README
- **Renamed output files** — distinct from GSD: `stack-analysis.md`, `architecture-analysis.md`, `quality-analysis.md`, `concerns-analysis.md`, `integrations-analysis.md`
- **Enriched agent prompts** — all 5 codebase-map agents expanded from ~50 to ~120 lines each with:
  - Specific bash/grep exploration commands
  - Forbidden files list (security)
  - Quality bar ("patterns matter more than lists", "be prescriptive")
  - Downstream consumers table
  - Richer output templates with evidence requirements
- Updated all downstream skills (assess, reverse-architect, migrate) to use new file names

## [2.0.2] - 2026-03-28

### Added

#### Bitbucket & Gitea Platform Support
- `platform.yaml`: Bitbucket (`bb` CLI + REST API fallback with `BITBUCKET_TOKEN`)
- `platform.yaml`: Gitea (`tea` CLI + REST API fallback with `GITEA_TOKEN` + `base_url`)
- `detect-platform.sh`: auto-detects Bitbucket (remote URL) and Gitea (tea CLI)
- `create-pr.sh`: full PR creation for both platforms with CLI and API fallback

#### 8 New Languages for Linting
- Java (checkstyle, pmd)
- C (cppcheck, clang-tidy)
- C++ (cppcheck, clang-tidy)
- C# (dotnet format)
- Swift (swiftlint)
- PL/SQL (sqlfluff — Oracle, PostgreSQL, MySQL, T-SQL dialects)
- Kotlin (ktlint, detekt)
- PHP (phpstan, phpcs)

#### Documentation
- `docs/EXTENDING.md`: guide for adding new platforms and languages

## [2.0.1] - 2026-03-28

### Changed
- **Git status separated from sprint-status.yaml** — addon now writes git metadata
  (branch, commit, PR URL, push status, lint result) to its own `git-status.yaml`
  instead of injecting fields into BMAD's `sprint-status.yaml`
- `sync-status.sh` rewritten: simple YAML write instead of complex awk injection
- `sprint-status.yaml` is now READ ONLY for the addon
- Updated all workflow files and documentation

## [2.0.0] - 2026-03-28

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

#### Documentation
- README.md with quick start and skill overview
- Installation guide, usage guide, architecture docs
- Configuration reference, contributing guide

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
- All scripts now work on macOS, Linux, and Git Bash/WSL

### Changed
- Manifest bumped to v2.0.0
- Multi-agent module enabled (`ma.enabled: true`)
- 9 supported tools (added Gemini CLI)

## [1.0.1] - 2026-03-28

### Fixed (Adversarial Review)
- `stage-and-commit.sh`: Added binary file detection
- `stage-and-commit.sh`: Added `--file-list` for story File List cross-reference
- `stage-and-commit.sh`: Added `.gitignore` coverage verification
- `lint-changed.sh`: Multi-language support for monorepo projects
- `sync-status.sh`: Added `--worktree-status-file` parameter
- `health-check.sh`: Added `git fetch` before commit comparison
- `create-pr.sh`: Added remote existence pre-check
- `workflow.md`: Added `EnterWorktree` failure fallback (regular branch)
- Populated migration templates and resources (were empty directories)
- Removed empty `steps/` directory

## [1.0.0] - 2026-03-28

### Added

#### Git Workflow Integration
- Enhanced `bmad-autopilot-on` with git operations between skill invocations
- Enhanced `bmad-autopilot-off` with git status report and lock release
- Worktree isolation via `EnterWorktree`/`ExitWorktree`
- Sprint-status.yaml sync from worktree to project root

#### Helper Scripts (8)
- `detect-platform.sh` — GitHub/GitLab/git_only auto-detection
- `sanitize-branch.sh` — Story key to valid branch name
- `lock.sh` — Session lock (epoch + UUID, 30m stale timeout)
- `stage-and-commit.sh` — Explicit staging with pre-commit checks
- `sync-status.sh` — Atomic status merge
- `lint-changed.sh` — Language-aware linting of changed files
- `health-check.sh` — Orphaned worktree classification
- `create-pr.sh` — PR/MR creation with graceful fallback

#### Configuration
- Git workflow config (`modules/git/config.yaml`)
- Platform commands (`modules/git/platform.yaml`)
- Commit and PR templates
- Secrets allowlist
- Multi-agent config placeholder (disabled)

#### Infrastructure
- `install.sh` with `--dry-run`, `--force`, backup with retention
- `uninstall.sh` with dirty-check worktree cleanup
- `manifest.yaml` with BMAD compatibility tracking
