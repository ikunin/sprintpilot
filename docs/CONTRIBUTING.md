# Contributing

## Project Structure

The add-on consists of four layers:

1. **Skills** (`skills/`) — Markdown prompts that instruct the AI agent. User-facing interface.
2. **Scripts** (`scripts/`) — Bash helpers for complex operations. Called by skills via the Bash tool.
3. **Config** (`modules/`) — YAML configuration read by skills at runtime.
4. **System Prompts** (`BMAD.md` + `templates/agent-rules.md`) — Enforce BMAD workflows from session start.

## Adding a New Skill

1. Create a directory under `_Sprintpilot/skills/sprintpilot-{name}/`
2. Add `SKILL.md` with frontmatter (name, description) and a pointer to `workflow.md`
3. Add `workflow.md` with the full workflow instructions
4. If the skill uses subagents, add agent prompts to `agents/`
5. Add the skill name to `manifest.yaml` under `installed_skills`
6. If the skill is part of the mandatory workflow, add it to `_Sprintpilot/BMAD.md`
7. If it introduces new constraints, add rules to `templates/agent-rules.md`
8. Run `install.sh` to deploy

### SKILL.md Template

```markdown
---
name: sprintpilot-{name}
description: 'One-line description of what the skill does and when to use it.'
---

Follow the instructions in ./workflow.md.
```

### Subagent Prompt Guidelines

- Each agent prompt is a self-contained markdown file in `agents/`
- Must include: role description, method, output format
- Cap structured output at ~2000 tokens
- Agent prompts cannot reference Skills (subagents can't invoke the Skill tool)
- Agents have access to: Read, Write, Edit, Bash, Grep, Glob, WebSearch, WebFetch

## Adding a Script

Scripts should be:
- Self-contained (no dependencies beyond standard Unix tools + git)
- Support `--help` for usage information
- Use clear exit codes (0 = success, 1 = expected failure, 2 = error)
- Write warnings to stderr, primary output to stdout
- Handle edge cases gracefully (missing files, empty input)

## Shell Compatibility

All scripts require **Bash 3.2+** (stock macOS). They also work on:
- Linux (Bash 4+/5+)
- Windows Git Bash
- WSL (Windows Subsystem for Linux)

No associative arrays (Bash 4+ only). No `set -u` (some variables are intentionally unset). Use `#!/bin/bash` shebang. The repo has `.gitattributes` enforcing LF line endings for scripts.

## Multi-Tool Compatibility

Skills must work across all 9 supported tools. Guidelines:
- Don't assume `.claude/` directory structure — other tools use `.cursor/`, `.windsurf/`, etc.
- Don't invoke the `Skill` tool from subagent prompts (subagents can't use it)
- System prompt changes in `templates/agent-rules.md` must keep the `<!-- BEGIN/END:bmad-workflow-rules -->` markers for idempotent install/uninstall
- Don't rename existing config keys (breaks user customizations) — add new keys instead

## Exit Code Convention

All scripts should follow this convention:
- `0` — success
- `1` — expected failure (e.g., nothing to commit, lock held, no linter found)
- `2` — error (e.g., missing required argument, infrastructure failure)

## Testing

### Scripts

Each script supports `--help` and can be tested standalone:

```bash
bash _Sprintpilot/scripts/detect-platform.sh
bash _Sprintpilot/scripts/sanitize-branch.sh "test-story-key"
bash _Sprintpilot/scripts/lock.sh check
```

### Install/Uninstall

```bash
npx sprintpilot install --dry-run   # preview
npx sprintpilot                     # install
npx sprintpilot uninstall           # uninstall
```

### Skills

Skills are tested by invoking them in your coding agent of choice:
```
/sprintpilot-{name}
```

## Design Decisions

### Why scripts instead of inline Bash in workflow.md?

Skills are markdown prompts interpreted by an LLM. Complex multi-step Bash embedded in markdown is fragile — the LLM may misinterpret, skip steps, or introduce errors. Scripts are:
- Testable independently
- Deterministic (Bash, not LLM interpretation)
- Maintainable (edit script, not a 500-line workflow)

### Why inlined agent prompts instead of Skill references?

Subagents (launched via the Agent tool) cannot invoke the Skill tool. Agent prompts must be self-contained — they can't delegate to other Skills.

### Worktree isolation via git worktree

Story isolation uses standard `git worktree add` commands, making it compatible with all supported coding agents. The workflow `cd`s into the worktree directory and back to the project root when done.

### Why explicit staging instead of git add -A?

Many coding agents (including Claude Code) flag `git add -A` as potentially dangerous. Explicit staging also prevents accidentally committing secrets, large files, or build artifacts.

## Commit Convention

```
feat({scope}): description     # new feature
fix({scope}): description      # bug fix
docs: description               # documentation
refactor({scope}): description  # code change without feature/fix
```

Include co-authorship:
```
Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```
