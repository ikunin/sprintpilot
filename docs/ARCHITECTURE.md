# Architecture

## Design Principles

1. **Additive** — never modifies BMAD's own files; survives BMAD updates
2. **Graceful degradation** — every feature fails safely (no git? skip git ops. No CLI? print manual commands)
3. **Skills as prompts** — skills are markdown instructions, not executable code. Scripts handle complex logic.
4. **Session-aware** — all state lives in files, enabling crash recovery across sessions

## Directory Structure

```
_bmad-addons/
├── manifest.yaml              # Version, BMAD compatibility, module flags
├── BMAD.md                    # Comprehensive skill reference (permanent home)
├── install.sh / uninstall.sh   # Lifecycle scripts (multi-tool, system prompts)
├── .secrets-allowlist          # Patterns exempt from secrets scanning
│
├── templates/
│   └── agent-rules.md         # Enforcement block template (with markers)
│
├── modules/
│   ├── git/
│   │   ├── config.yaml         # Git workflow configuration
│   │   ├── platform.yaml       # CLI command templates (GitHub, GitLab)
│   │   └── templates/          # Commit message and PR body templates
│   └── ma/
│       └── config.yaml         # Multi-agent configuration
│
├── scripts/                    # Bash helpers called by workflow.md
│   ├── detect-platform.sh      # Platform auto-detection
│   ├── sanitize-branch.sh      # Story key → valid branch name
│   ├── lock.sh                 # Session lock management
│   ├── stage-and-commit.sh     # Explicit staging with pre-commit checks
│   ├── sync-status.sh          # Worktree → project root status sync
│   ├── lint-changed.sh         # Multi-language linting
│   ├── health-check.sh         # Orphaned worktree detection
│   └── create-pr.sh            # PR/MR creation
│
└── skills/                     # Installed to .claude/skills/ by install.sh
    ├── bmad-autopilot-on/      # Enhanced autopilot (git + MA)
    ├── bmad-autopilot-off/     # Enhanced disengage
    ├── bmad-ma-code-review/    # 3 parallel review agents
    ├── bmad-ma-codebase-map/   # 5 parallel analysis agents
    ├── bmad-ma-assess/         # 3 parallel assessment agents
    ├── bmad-ma-reverse-architect/ # 3 parallel extraction agents
    ├── bmad-ma-migrate/        # 12-step workflow, 4 agents
    ├── bmad-ma-research/       # N parallel research agents
    └── bmad-ma-party-mode/     # 2-3 parallel persona agents
```

## Key Mechanisms

### System Prompt Enforcement

The add-on installs **system prompt files** that make every AI agent session aware of BMAD from the first message. Without this, agents would only learn about BMAD when explicitly told.

**Three-file architecture:**

```
CLAUDE.md          →  @AGENTS.md (include directive)
AGENTS.md          →  enforcement block (self-sufficient, ~40 lines)
                       "NEVER write code without the 7-step sequence"
                       References _bmad-addons/BMAD.md for full catalog
_bmad-addons/
  BMAD.md          ←  comprehensive skill reference (permanent, not copied)
  templates/
    agent-rules.md ←  source template for the enforcement block
```

**Why self-sufficient:** Tools other than Claude Code can't `@include` files. The enforcement block inlines all critical rules (mandatory 7-step sequence, git rules, autopilot commands) so it works even if the agent never reads `BMAD.md`.

**Marker-based updates:** The block is wrapped in `<!-- BEGIN:bmad-workflow-rules -->` / `<!-- END:bmad-workflow-rules -->` HTML comment markers. The installer can replace it without touching user content. The uninstaller removes only the BMAD section.

**Per-tool strategies:**
- **Claude Code**: `CLAUDE.md` → `@AGENTS.md` include → `AGENTS.md` has the rules block
- **Own-file tools** (Cursor, Roo, Kiro, Trae): dedicated `bmad.md` in the tool's rules directory
- **Append tools** (Windsurf, Cline, Gemini CLI, Copilot): rules block appended to shared system prompt file

### EnterWorktree / ExitWorktree

Claude Code's `cd` command does NOT persist across tool calls. The only way to change the working directory for all tools (including the Skill tool) is via `EnterWorktree` and `ExitWorktree`.

```
EnterWorktree(name: "story-key")
  → Creates .claude/worktrees/story-key/
  → New branch from HEAD
  → ALL tools now operate in this directory

ExitWorktree(action: "keep")
  → Returns to original project root
  → Worktree preserved on disk
```

**Fallback**: If `EnterWorktree` fails, the workflow creates a regular branch (`git checkout -b`) and continues without isolation.

### File Ownership: sprint-status.yaml vs git-status.yaml

The addon **never modifies** `sprint-status.yaml` — that file is owned by BMAD. Instead, the addon tracks git metadata in its own `git-status.yaml`:

| File | Owner | Contains |
|------|-------|----------|
| `sprint-status.yaml` | BMAD | Story status, phase, epic structure |
| `git-status.yaml` | Addon | Branch, commit SHA, PR URL, push status, lint result, worktree path |

Both live in `_bmad-output/implementation-artifacts/`. The autopilot reads `sprint-status.yaml` for story selection and writes git fields to `git-status.yaml`.

```
[In worktree] bmad-dev-story updates sprint-status.yaml (BMAD-owned)
                     ↓
[ExitWorktree] returns to project root
                     ↓
[sync-status.sh] writes git fields to git-status.yaml (addon-owned)
                 atomic write (tmp + mv), never touches sprint-status
```

### Lock File

Prevents concurrent autopilot sessions. Uses epoch timestamp + UUID (no PID — unreliable in Claude Code). All time math in Bash, not the LLM.

```
.autopilot.lock contents:
  1711590000        ← epoch seconds
  A1B2C3D4-...     ← session UUID
```

Stale locks (>30 min) are auto-removed on next boot.

### Explicit File Staging

The add-on **never** uses `git add -A`, `git add .`, or `git add -u`. Instead:

1. `git diff --name-only HEAD` + `git ls-files --others --exclude-standard`
2. Cross-reference with story File List (if provided)
3. Pre-commit checks: secrets scan, file size, binary detection, .gitignore verification
4. `git add -- "file1" "file2"` (quoted paths)

### Multi-Agent Pattern

All MA skills follow the same pattern:

1. **Prepare context** — read relevant files, generate diffs
2. **Launch N agents in a single message** — ensures parallel execution
3. **Each agent gets inlined instructions** — not a Skill reference (subagents can't invoke Skills)
4. **Collect results** — parent receives all agent outputs
5. **Triage/synthesize** — deduplicate, classify, merge into final output

## Survivability

| Concern | Protection |
|---------|-----------|
| BMAD update overwrites skills | Add-on skills use `bmad-autopilot-*` and `bmad-ma-*` prefixes, not in BMAD's `skill-manifest.csv` |
| Source files modified | Source lives in `_bmad-addons/`, never touched by BMAD |
| Need to re-install | `bash _bmad-addons/install.sh` restores all skills |
| Rollback | Backups in `.claude/.addon-backups/` (last 3 per skill) |

## Platform Abstraction

```
detect-platform.sh:
  1. Explicit config (provider: github) → use it
  2. CLI detection (gh --version, glab --version) → first found
  3. Remote URL regex (github.com, gitlab.) → pattern match
  4. None → git_only (local branches only, no PRs)
```

Platform commands are templates in `platform.yaml` with `{placeholders}` filled at runtime.
