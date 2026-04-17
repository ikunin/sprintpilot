# Configuration Reference

All configuration lives in `_Sprintpilot/modules/`. Changes take effect on the next `/sprint-autopilot-on` invocation.

## Git Configuration (`modules/git/config.yaml`)

### Core Settings

| Key | Default | Description |
|-----|---------|-------------|
| `git.enabled` | `true` | Master switch. `false` disables all git operations. |
| `git.base_branch` | `main` | Base branch for worktrees and PRs. |
| `git.branch_prefix` | `story/` | Prefix for story branches (e.g., `story/1-3-add-auth`). |
| `git.max_branch_length` | `60` | Max chars before truncation + 6-char hash suffix. |

### Commit Templates

| Key | Default | Placeholders |
|-----|---------|-------------|
| `commit_templates.story` | `feat({epic}): {story-title} ({story-key})` | `{epic}`, `{story-title}`, `{story-key}` |
| `commit_templates.patch` | `fix({story-key}): {patch-title}` | `{story-key}`, `{patch-title}` |

Placeholder resolution chain: sprint-status.yaml → story file → fallback value.

### Staging

| Key | Default | Description |
|-----|---------|-------------|
| `staging.strategy` | `explicit` | Always explicit file names. Cannot be changed to `git add -A`. |
| `staging.source` | `git-diff-primary` | Primary source: `git diff --name-only HEAD` |
| `staging.cross_reference` | `story-file-list` | Cross-reference changed files against the story's "File List" section. Warns on unexpected files (changed but not in File List) and missing files (in File List but not changed). |
| `staging.max_file_size_mb` | `1` | Reject files larger than this with warning |

### Pre-Commit Checks

| Check | Behavior |
|-------|----------|
| `verify_no_secrets` | Grep for API_KEY, SECRET, TOKEN, PASSWORD, aws_access, private_key. WARN severity. |
| `verify_gitignore_covers_addon` | Verify .gitignore has .autopilot.lock and .claude/.addon-backups/ |
| `verify_file_size` | Reject files > `max_file_size_mb` |
| `verify_no_binaries` | Warn on binary files detected via `file --mime-encoding` |

### Secrets Scanning

| Key | Default | Description |
|-----|---------|-------------|
| `secrets_scan.patterns` | `[API_KEY, SECRET, TOKEN, ...]` | Patterns to search for |
| `secrets_scan.severity` | `WARN` | WARN = surface and continue. Does not block commit. |
| `secrets_scan.allowlist_file` | `.secrets-allowlist` | File with glob patterns exempt from scanning |

### Linting

| Key | Default | Description |
|-----|---------|-------------|
| `lint.enabled` | `true` | Enable/disable linting |
| `lint.auto_detect` | `true` | Detect language from manifest files |
| `lint.scope` | `changed-files` | Only lint files changed in the story |
| `lint.blocking` | `false` | Lint findings never halt the autopilot |
| `lint.output_limit` | `100` | Max lines injected into context |
| `lint.output_strategy` | `errors-first` | Show errors before warnings |
| `lint.full_output_file` | `true` | Save full output to file |

Supported linters per language:

| Language | Linters (first found wins) |
|----------|---------------------------|
| Python | ruff, flake8, pylint |
| JavaScript/TypeScript | eslint, biome |
| Rust | cargo clippy |
| Go | golangci-lint |
| Ruby | rubocop |
| Java | checkstyle, pmd |
| C/C++ | cppcheck, clang-tidy |
| C# | dotnet format |
| Swift | swiftlint |
| PL/SQL | sqlfluff |
| Kotlin | ktlint, detekt |
| PHP | phpstan, phpcs |

See [Extending](EXTENDING.md) to add more languages.

### Push & PR

| Key | Default | Description |
|-----|---------|-------------|
| `push.auto` | `true` | Auto-push after commit |
| `push.create_pr` | `true` | Auto-create PR/MR after push |
| `push.pr_body` | `heredoc` | Use shell HEREDOC for PR body |

### Merge

| Key | Default | Description |
|-----|---------|-------------|
| `merge.timing` | `epic-retrospective` | Suggest merge after epic retrospective |
| `merge.require_user_confirm` | `true` | Always ask before merging |

### Worktree

| Key | Default | Description |
|-----|---------|-------------|
| `worktree.submodule_init` | `auto` | `auto` = only if `.gitmodules` exists |
| `worktree.submodule_timeout` | `30` | Seconds before timeout on submodule init |
| `worktree.cleanup_on_merge` | `true` | Remove worktree after story is merged |
| `worktree.health_check_on_boot` | `true` | Check for orphaned worktrees at startup |

### Lock File

| Key | Default | Description |
|-----|---------|-------------|
| `lock.enabled` | `true` | Prevent concurrent autopilot sessions |
| `lock.file` | `.autopilot.lock` | Lock file path (in project root) |
| `lock.stale_timeout_minutes` | `30` | Auto-remove locks older than this |

### Platform Detection

| Key | Default | Description |
|-----|---------|-------------|
| `platform.provider` | `auto` | `auto`, `github`, `gitlab`, `bitbucket`, `gitea`, or `git_only` |

Auto-detection priority: explicit config > CLI detection > remote URL regex.

For self-hosted instances:
```yaml
platform:
  provider: gitea
  base_url: https://git.example.com
```

### Authentication Tokens

Platforms with API fallback require environment variables when their CLI is not installed:

| Platform | Env Var | Required When |
|----------|---------|---------------|
| Bitbucket | `BITBUCKET_TOKEN` | `bb` CLI not installed |
| Gitea | `GITEA_TOKEN` | `tea` CLI not installed (also needs `base_url` in config) |

GitHub and GitLab require their CLIs (`gh`, `glab`). No API fallback is available.

## Multi-Agent Configuration (`modules/ma/config.yaml`)

| Key | Default | Description |
|-----|---------|-------------|
| `multi_agent.enabled` | `true` | Enable multi-agent skills |
| `multi_agent.max_parallel_review_layers` | `3` | Always 3 (blind, edge-case, acceptance) |
| `multi_agent.max_parallel_research` | `3` | Max concurrent research agents per batch |
| `multi_agent.max_parallel_analysis` | `5` | Max concurrent codebase analysis agents |

## Secrets Allowlist (`.secrets-allowlist`)

One glob pattern per line. Files matching these patterns are skipped during secrets scanning.

```
# Test files
test/**
tests/**
**/test_*

# Example files
*.example
*.sample
.env.example

# Documentation
docs/**
*.md

# Fixtures
**/fixtures/**
**/mocks/**
```

## Platform Commands (`modules/git/platform.yaml`)

Defines CLI commands for each platform. Uses `{placeholders}` filled at runtime:
- `{base_branch}` — from config
- `{branch}` — story branch name
- `{title}` — PR title
- `{body}` — PR body content

Commands use YAML `|` literal blocks to preserve HEREDOC formatting.

## System Prompt Files

These are created by `bin/sprintpilot.js install` and enforce BMad Method workflows from the first agent message.

### Source Files (in `_Sprintpilot/`)

| File | Purpose | Editable? |
|------|---------|-----------|
| `Sprintpilot.md` | Comprehensive skill reference by lifecycle phase | Yes — add skills, update descriptions |
| `templates/agent-rules.md` | Enforcement block injected into system prompts | Yes — add constraints, update rules |

### Generated Files (per tool)

| Tool | Generated File | Strategy |
|------|---------------|----------|
| Claude Code | `CLAUDE.md` + `AGENTS.md` | `@AGENTS.md` include |
| Cursor | `.cursor/rules/bmad.md` | Own file |
| Windsurf | `.windsurfrules` | Append with markers |
| Cline | `.clinerules` | Append with markers |
| Roo | `.roo/rules/bmad.md` | Own file |
| Gemini CLI | `GEMINI.md` | Append with markers |
| GitHub Copilot | `.github/copilot-instructions.md` | Append with markers |
| Kiro | `.kiro/rules/bmad.md` | Own file |
| Trae | `.trae/rules/bmad.md` | Own file |

### Customizing Rules

Edit `_Sprintpilot/templates/agent-rules.md` to change enforcement rules. Keep the `<!-- BEGIN:sprintpilot-rules -->` and `<!-- END:sprintpilot-rules -->` markers — they are required for idempotent updates and clean uninstall.

After editing, re-run `bin/sprintpilot.js install` to propagate changes to all tool system prompts.

## Git Status File (`git-status.yaml`)

The addon tracks git metadata in its own file at `_bmad-output/implementation-artifacts/git-status.yaml`. It never modifies BMad Method's `sprint-status.yaml`.

Example schema:

```yaml
# Sprintpilot — Git Status
git_integration:
  enabled: true
  base_branch: main
  platform: github

stories:
  1-1-add-login:
    branch: story/1-1-add-login
    worktree: .worktrees/1-1-add-login
    story_commit: abc1234
    patch_commits: [def5678, ghi9012]
    lint_result: "2 warnings — non-blocking"
    push_status: pushed
    pr_url: https://github.com/user/repo/pull/42
    worktree_cleaned: false
  1-2-user-profile:
    branch: story/1-2-user-profile
    push_status: pending
```

| Field | Type | Description |
|-------|------|-------------|
| `branch` | string | Git branch name (`story/<key>`) |
| `worktree` | string | Worktree path (`.worktrees/<key>`) |
| `story_commit` | string | SHA of the main story commit |
| `patch_commits` | list | SHAs of code review patch commits |
| `lint_result` | string | Lint summary (non-blocking) |
| `push_status` | string | `pushed`, `failed`, `skipped`, `pending` |
| `pr_url` | string | PR/MR URL (if created) |
| `worktree_cleaned` | boolean | Whether worktree has been removed |
