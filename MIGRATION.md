# Migration — legacy `bmad-autopilot-addon` → `sprintpilot`

Sprintpilot is the renamed, trademark-compliant successor to `bmad-autopilot-addon`. `sprintpilot@1.0.0` is the first release under the new name; the old `bmad-autopilot-addon` npm package (final version `1.0.21`) is deprecated. Functionality is identical; only names and paths change.

Throughout this document, "legacy" refers to any `bmad-autopilot-addon` install (versions `1.0.x`).

## TL;DR (automated migration)

```bash
# 1. Remove the old global package (permission prompt is normal)
npm uninstall -g bmad-autopilot-addon

# 2. Install Sprintpilot
npm install -g @ikunin/sprintpilot

# 3. Run inside your BMad Method project — auto-migrates legacy artifacts
sprintpilot install
```

The installer auto-detects the legacy `_bmad-addons/` directory, carries over your `modules/git/config.yaml`, `modules/ma/config.yaml`, `modules/autopilot/config.yaml` values (and any customized templates), strips the legacy agent-rules block from `AGENTS.md` / IDE rule files, removes the legacy skill directories from all configured tool skill folders, and installs the new layout at `_Sprintpilot/`.

In CI / non-interactive environments, **`--migrate-v1` is required** alongside `--yes` — `-y` alone will refuse to migrate (it won't silently destroy your legacy footprint):

```bash
sprintpilot install --migrate-v1 --yes --tools claude-code
```

## What changes

### Package

| legacy | sprintpilot |
|--------|-------------|
| `bmad-autopilot-addon` on npm | `sprintpilot` on npm |
| `npx bmad-autopilot-addon` | `npx @ikunin/sprintpilot@latest` |
| bin: `bmad-autopilot-addon` | bin: `sprintpilot` |

### Project directory

| legacy | sprintpilot |
|--------|-------------|
| `<project>/_bmad-addons/` | `<project>/_Sprintpilot/` |
| `_bmad-addons/BMAD.md` | `_Sprintpilot/Sprintpilot.md` |
| `_bmad-addons/modules/git/config.yaml` | `_Sprintpilot/modules/git/config.yaml` |
| `_bmad-addons/modules/ma/config.yaml` | `_Sprintpilot/modules/ma/config.yaml` |
| `_bmad-addons/modules/autopilot/config.yaml` | `_Sprintpilot/modules/autopilot/config.yaml` |

All module config values carry over identically — only the path changes.

### Skill / slash-command names

| legacy | sprintpilot |
|--------|-------------|
| `/bmad-autopilot-on` | `/sprint-autopilot-on` |
| `/bmad-autopilot-off` | `/sprint-autopilot-off` |
| `/bmad-addon-update` | `/sprintpilot-update` |
| `/bmad-ma-code-review` | `/sprintpilot-code-review` |
| `/bmad-ma-codebase-map` | `/sprintpilot-codebase-map` |
| `/bmad-ma-assess` | `/sprintpilot-assess` |
| `/bmad-ma-reverse-architect` | `/sprintpilot-reverse-architect` |
| `/bmad-ma-migrate` | `/sprintpilot-migrate` |
| `/bmad-ma-research` | `/sprintpilot-research` |
| `/bmad-ma-party-mode` | `/sprintpilot-party-mode` |

### Agent-rules marker block

If you have `AGENTS.md`, `GEMINI.md`, `.windsurfrules`, `.clinerules`, or `.github/copilot-instructions.md` with a block bounded by

```
<!-- BEGIN:bmad-workflow-rules -->
...
<!-- END:bmad-workflow-rules -->
```

the installer strips that block and writes a fresh block bounded by `<!-- BEGIN:sprintpilot-rules -->` / `<!-- END:sprintpilot-rules -->`. Your surrounding content is preserved.

## Manual migration (if you prefer not to auto-run)

```bash
# Remove legacy skills from your tool's skill directory
rm -rf .claude/skills/bmad-autopilot-{on,off} .claude/skills/bmad-addon-update .claude/skills/bmad-ma-*

# Move config values
mv _bmad-addons/modules _Sprintpilot/modules

# Remove the old addon dir
rm -rf _bmad-addons

# Let the installer write the new skills + Sprintpilot.md + manifest
sprintpilot install
```

## What migration does not do

- **Custom user-authored `bmad-*` skills outside the legacy skill set** (you added them manually, they're not in the legacy manifest): they remain in your tool skill dir after migration. Rename or remove them manually if desired.
- **User-global `~/.claude/skills/` directory**: never touched — a project-level install must not reach across other projects on the same machine. If you ran the legacy installer with a user-global scope, clean up `~/.claude/skills/bmad-*` yourself.
- **Dedicated prompt files for own-file tools** (`.cursor/rules/bmad.md`, `.roo/rules/bmad.md`, `.kiro/rules/bmad.md`, `.trae/rules/bmad.md`): these are fully owned by the installer and are overwritten by a fresh Sprintpilot install. If you hand-edited them, back them up before running `sprintpilot install`.
- **Symlinks inside `_bmad-addons/modules/`**: the snapshot skips symbolic links — only regular files are captured and re-applied. If you symlinked anything into `_bmad-addons/modules/` by hand, recreate the symlink under `_Sprintpilot/modules/` after migration.
- **Empty directories inside `_bmad-addons/modules/`**: recreated only if the bundled Sprintpilot tree contains them. Hand-placed empty subdirectories are not restored.

## Backups

Legacy agent-rules marker blocks in `AGENTS.md`, `GEMINI.md`, `.windsurfrules`, `.clinerules`, and `.github/copilot-instructions.md` are stripped in place. A backup of the pre-migration file is saved at `<file>.bak-sprintpilot-migration` so nothing is ever silently destroyed. Remove the backup after verifying migration succeeded.

If Sprintpilot fails to re-apply your module-config snapshot after the bundled resources are copied, the snapshot is persisted to `.sprintpilot-v1-snapshot.json` (base64-encoded) at the project root for manual recovery.

Both patterns (`*.bak-sprintpilot-migration` and `.sprintpilot-v1-snapshot*.json`) are added to `.gitignore` during migration so you can't accidentally commit them.

## Rollback

Old npm versions of `bmad-autopilot-addon` remain on the registry (deprecated, not unpublished):

```bash
npm install -g bmad-autopilot-addon@1.0.21
```

The legacy layout is independent of the new layout, so you can always fall back.

## Why the rename?

The legacy name `bmad-autopilot-addon` was inconsistent with BMad Code, LLC's policy on naming third-party projects. Sprintpilot is a distinct mark that describes the product's function while respecting that policy. See [TRADEMARK.md](TRADEMARK.md) for details.
