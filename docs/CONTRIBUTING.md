# Contributing

## Project Structure

The add-on consists of four layers:

1. **Skills** (`skills/`) — Markdown prompts that instruct the AI agent. User-facing interface.
2. **Scripts** (`scripts/`) — Bash helpers for complex operations. Called by skills via the Bash tool.
3. **Config** (`modules/`) — YAML configuration read by skills at runtime.
4. **System Prompts** (`BMAD.md` + `templates/agent-rules.md`) — Enforce BMAD workflows from session start.

## Adding a New Skill

1. Create a directory under `_bmad-addons/skills/bmad-ma-{name}/`
2. Add `SKILL.md` with frontmatter (name, description) and a pointer to `workflow.md`
3. Add `workflow.md` with the full workflow instructions
4. If the skill uses subagents, add agent prompts to `agents/`
5. Add the skill name to `manifest.yaml` under `installed_skills`
6. If the skill is part of the mandatory workflow, add it to `_bmad-addons/BMAD.md`
7. If it introduces new constraints, add rules to `templates/agent-rules.md`
8. Run `install.sh` to deploy

### SKILL.md Template

```markdown
---
name: bmad-ma-{name}
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

## Exit Code Convention

All scripts should follow this convention:
- `0` — success
- `1` — expected failure (e.g., nothing to commit, lock held, no linter found)
- `2` — error (e.g., missing required argument, infrastructure failure)

## Testing

### Scripts

Each script supports `--help` and can be tested standalone:

```bash
bash _bmad-addons/scripts/detect-platform.sh
bash _bmad-addons/scripts/sanitize-branch.sh "test-story-key"
bash _bmad-addons/scripts/lock.sh check
```

### Install/Uninstall

```bash
bash _bmad-addons/install.sh --dry-run    # preview
bash _bmad-addons/install.sh              # install
bash _bmad-addons/uninstall.sh            # uninstall
```

### Skills

Skills are tested by invoking them in Claude Code:
```
/bmad-ma-{name}
```

## Design Decisions

### Why scripts instead of inline Bash in workflow.md?

Skills are markdown prompts interpreted by an LLM. Complex multi-step Bash embedded in markdown is fragile — the LLM may misinterpret, skip steps, or introduce errors. Scripts are:
- Testable independently
- Deterministic (Bash, not LLM interpretation)
- Maintainable (edit script, not a 500-line workflow)

### Why inlined agent prompts instead of Skill references?

Subagents (launched via the Agent tool) cannot invoke the Skill tool. Agent prompts must be self-contained — they can't delegate to other Skills.

### Why EnterWorktree instead of cd?

`cd` in a Bash tool call does NOT persist to subsequent tool calls. `EnterWorktree` is the only mechanism that changes the working directory for ALL tools in a session, including the Skill tool.

### Why explicit staging instead of git add -A?

Claude Code's safety system flags `git add -A` as potentially dangerous. Explicit staging also prevents accidentally committing secrets, large files, or build artifacts.

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
