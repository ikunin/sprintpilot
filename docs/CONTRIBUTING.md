# Contributing

## Project Structure

The add-on consists of four layers:

1. **Skills** (`skills/`) — Markdown prompts that instruct the AI agent. User-facing interface.
2. **Scripts** (`scripts/`) — Node.js helpers for complex operations. Invoked by skills via `node <script>.js`.
3. **Config** (`modules/`) — YAML configuration read by skills at runtime.
4. **System Prompts** (`Sprintpilot.md` + `templates/agent-rules.md`) — Enforce BMad Method workflows from session start.

## Adding a New Skill

1. Create a directory under `_Sprintpilot/skills/sprintpilot-{name}/`
2. Add `SKILL.md` with frontmatter (name, description) and a pointer to `workflow.md`
3. Add `workflow.md` with the full workflow instructions
4. If the skill uses subagents, add agent prompts to `agents/`
5. Add the skill name to `manifest.yaml` under `installed_skills`
6. If the skill is part of the mandatory workflow, add it to `_Sprintpilot/Sprintpilot.md`
7. If it introduces new constraints, add rules to `templates/agent-rules.md`
8. Run `bin/sprintpilot.js install` to deploy

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
- Plain Node.js — **zero runtime dependencies** beyond Node built-ins (`fs`, `child_process`, `crypto`, `https`, …) and `git`. Shared zero-dep helpers live in `_Sprintpilot/lib/runtime/` (arg parsing, YAML-lite, git wrapper, secrets scan, etc.)
- Support `--help` for usage information
- Use clear exit codes (0 = success, 1 = expected failure, 2 = error)
- Write warnings to stderr, primary output to stdout
- Handle edge cases gracefully (missing files, empty input)
- Use `#!/usr/bin/env node` shebang for CLI entry points

## Runtime Compatibility

Scripts run on **Node.js 18+** (matches `package.json` `engines.node`). This covers:
- macOS (system Node or via `nvm`)
- Linux (distro package, `nvm`, etc.)
- Windows (native `node.exe` — no Bash dependency, so the historical WSL/Git-Bash PATH issues don't apply at runtime)

## Multi-Tool Compatibility

Skills must work across all 9 supported tools. Guidelines:
- Don't assume `.claude/` directory structure — other tools use `.cursor/`, `.windsurf/`, etc.
- Don't invoke the `Skill` tool from subagent prompts (subagents can't use it)
- System prompt changes in `templates/agent-rules.md` must keep the `<!-- BEGIN/END:sprintpilot-rules -->` markers for idempotent install/uninstall
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
node _Sprintpilot/scripts/detect-platform.js
node _Sprintpilot/scripts/sanitize-branch.js "test-story-key"
node _Sprintpilot/scripts/lock.js check
```

### Install/Uninstall

```bash
npx @ikunin/sprintpilot@latest install --dry-run   # preview
npx @ikunin/sprintpilot@latest                     # install
npx @ikunin/sprintpilot@latest uninstall           # uninstall
```

### Skills

Skills are tested by invoking them in your coding agent of choice:
```
/sprintpilot-{name}
```

## Design Decisions

### Why separate scripts instead of inline steps in workflow.md?

Skills are markdown prompts interpreted by an LLM. Complex multi-step logic embedded in markdown is fragile — the LLM may misinterpret, skip steps, or introduce errors. Scripts are:
- Testable independently (Vitest unit + integration coverage)
- Deterministic (Node execution, not LLM interpretation)
- Maintainable (edit one script, not a 500-line workflow)

### Why inlined agent prompts instead of Skill references?

Subagents (launched via the Agent tool) cannot invoke the Skill tool. Agent prompts must be self-contained — they can't delegate to other Skills.

### Worktree isolation via git worktree

Story isolation uses standard `git worktree add` commands, making it compatible with all supported coding agents. The workflow `cd`s into the worktree directory and back to the project root when done.

### Why explicit staging instead of git add -A?

Many coding agents (including Claude Code) flag `git add -A` as potentially dangerous. Explicit staging also prevents accidentally committing secrets, large files, or build artifacts.

## Developer setup (one-time)

Enable the pre-push hook so Biome + the fast test suite run before every push:

```bash
git config core.hooksPath .githooks
cd tests && npm install
```

The hook (at `.githooks/pre-push`) runs `biome ci .` then `npm run test:fast`. CI runs the test suite independently on push/PR, so the hook is just a locally-caught safety net.

Auto-fix Biome findings:

```bash
./tests/node_modules/.bin/biome check --write .
```

## Commit Convention

```
feat({scope}): description     # new feature
fix({scope}): description      # bug fix
docs: description              # documentation
refactor({scope}): description # code change without feature/fix
chore({scope}): description    # non-user-facing maintenance
```

Use `!` for breaking changes (`refactor!: …`, `feat!: …`).
