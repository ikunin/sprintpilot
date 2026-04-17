'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('fs-extra');
const pc = require('picocolors');

const {
  ALL_TOOLS,
  getToolDir,
  getSystemPromptFile,
  getSystemPromptMode,
  isKnownTool,
} = require('../core/tool-registry');
const {
  verifyBmadInstalled,
  readOutputFolder,
  readAddonManifestVersion,
} = require('../core/bmad-config');
const { resolveIgnoreFile, addIgnoreEntry } = require('../core/gitignore');
const { copyDirWithSubstitution, backupSkill, pruneBackups } = require('../core/file-ops');
const {
  BEGIN, END, stripBlock, stripLegacyBlock, upsertBlock, writeAtomic, hasBlock, hasLegacyBlock,
} = require('../core/markers');
const { renderString, buildContext, isTextFile } = require('../substitute');
const { fetchLatestVersion, compareVersions } = require('../core/update-check');
const prompts = require('../prompts');

const execFileAsync = promisify(execFile);

const BANNER = String.raw`
 ____             _       _   ____  _ _       _
/ ___| _ __  _ __(_)_ __ | |_|  _ \(_) | ___ | |_
\___ \| '_ \| '__| | '_ \| __| |_) | | |/ _ \| __|
 ___) | |_) | |  | | | | | |_|  __/| | | (_) | |_
|____/| .__/|_|  |_|_| |_|\__|_|   |_|_|\___/ \__|
      |_|
`;

const {
  V1_ADDON_DIR_NAME,
  V1_SKILL_NAMES,
  detectV1Installation,
} = require('../core/v1-detect');

const ADDON_DIR = path.resolve(__dirname, '..', '..', '_Sprintpilot');
const PROJECT_ADDON_DIR_NAME = '_Sprintpilot';
const RUNTIME_RESOURCES = ['Sprintpilot.md', 'manifest.yaml', '.secrets-allowlist', 'lib', 'modules', 'scripts', 'templates'];
const V1_MODULE_NAMES = ['git', 'ma', 'autopilot'];

// Sentinel thrown by evictV1Installation when the user declines migration.
// runInstall catches it and exits cleanly (non-zero) without a stack trace.
class V1MigrationDeclinedError extends Error {
  constructor() {
    super('v1 migration declined');
    this.name = 'V1MigrationDeclinedError';
    this.exitCode = 1;
  }
}

function parseToolsArg(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (trimmed === 'all') return ALL_TOOLS.slice();
  return trimmed.split(',').map((t) => t.trim()).filter(Boolean);
}

async function detectInstalledTools(projectRoot) {
  const detected = [];
  for (const tool of ALL_TOOLS) {
    const dir = getToolDir(tool);
    if (!dir) continue;
    const skillsDir = path.join(projectRoot, dir, 'skills');
    if (await fs.pathExists(skillsDir)) {
      detected.push(tool);
    }
  }
  return detected;
}

async function listSkills() {
  const skillsDir = path.join(ADDON_DIR, 'skills');
  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

function timestamp() {
  // Use UTC so two installs on a DST fall-back night (local time repeats)
  // don't collide or invert their lexical ordering.
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

async function verifyCheckIgnore(projectRoot, entry) {
  const gitDir = path.join(projectRoot, '.git');
  if (!(await fs.pathExists(gitDir))) return;
  try {
    await execFileAsync('git', ['-C', projectRoot, 'check-ignore', '-q', entry]);
  } catch {
    console.warn(pc.yellow(`WARNING: ${entry} may not be effectively ignored by git`));
  }
}

async function installSystemPrompt(tool, projectRoot, addonDir, ctx, { dryRun = false } = {}) {
  const templatePath = path.join(addonDir, 'templates', 'agent-rules.md');
  const rawTemplate = await fs.readFile(templatePath, 'utf8');
  const rulesContent = renderString(rawTemplate, ctx);
  const mode = getSystemPromptMode(tool);
  const promptFileRel = getSystemPromptFile(tool);

  if (dryRun) {
    console.log(pc.dim(`  [DRY RUN] Would install system prompt for ${tool} (${mode})`));
    return;
  }

  if (mode === 'claude-code') {
    const agentsFile = path.join(projectRoot, 'AGENTS.md');
    let existed = await fs.pathExists(agentsFile);
    let existing = existed ? await fs.readFile(agentsFile, 'utf8') : '';
    const updated = upsertBlock(existing, rulesContent);
    await writeAtomic(agentsFile, updated);
    if (!existed) {
      console.log(`  System prompt: AGENTS.md (created)`);
    } else if (hasBlock(existing)) {
      console.log(`  System prompt: AGENTS.md (updated BMAD section)`);
    } else {
      console.log(`  System prompt: AGENTS.md (appended BMAD section)`);
    }

    const claudeFile = path.join(projectRoot, 'CLAUDE.md');
    const claudeExists = await fs.pathExists(claudeFile);
    const claudeContent = claudeExists ? await fs.readFile(claudeFile, 'utf8') : '';
    if (claudeContent.includes('@AGENTS.md')) {
      console.log(`  System prompt: CLAUDE.md (already has @AGENTS.md)`);
    } else if (claudeExists) {
      const needsNewline = claudeContent.length && !claudeContent.endsWith('\n');
      await fs.writeFile(claudeFile, `${claudeContent}${needsNewline ? '\n' : ''}@AGENTS.md\n`, 'utf8');
      console.log(`  System prompt: CLAUDE.md (appended @AGENTS.md)`);
    } else {
      await fs.writeFile(claudeFile, '@AGENTS.md\n', 'utf8');
      console.log(`  System prompt: CLAUDE.md (created with @AGENTS.md)`);
    }
    return;
  }

  const promptFile = path.join(projectRoot, promptFileRel);

  if (mode === 'own-file') {
    await fs.ensureDir(path.dirname(promptFile));
    await writeAtomic(promptFile, rulesContent);
    console.log(`  System prompt: ${promptFileRel} (created)`);
    return;
  }

  if (mode === 'append') {
    const exists = await fs.pathExists(promptFile);
    const current = exists ? await fs.readFile(promptFile, 'utf8') : '';
    const updated = upsertBlock(current, rulesContent);
    await writeAtomic(promptFile, updated);
    if (!exists) {
      console.log(`  System prompt: ${promptFileRel} (created)`);
    } else if (hasBlock(current)) {
      console.log(`  System prompt: ${promptFileRel} (updated BMAD section)`);
    } else {
      console.log(`  System prompt: ${promptFileRel} (appended BMAD section)`);
    }
  }
}

// Recursively walk a directory, returning [{relPath, buffer}] for every
// regular file. Symlinks and directories are skipped (we don't expect
// either inside a v1 modules/<mod>/ tree). Read errors bubble up so the
// caller can abort before any destructive operation.
async function collectTreeFiles(root, relPrefix = '') {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const abs = path.join(root, entry.name);
    const rel = relPrefix ? path.join(relPrefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await collectTreeFiles(abs, rel)));
    } else if (entry.isFile()) {
      out.push({ relPath: rel, buffer: await fs.readFile(abs) });
    }
    // symlinks intentionally skipped
  }
  return out;
}

// Snapshot the entire legacy modules/<mod>/ tree into memory BEFORE
// removing _bmad-addons/, so the full set of user-editable files
// (config.yaml AND templates/commit-*.txt, templates/pr-body.md, etc.)
// can be re-applied AFTER the bundled Sprintpilot resources land at
// step 6. Returning only config.yaml would silently destroy user-
// customized templates.
//
// Return shape: { [mod]: [{ relPath, buffer }, ...] }. An empty object
// means no modules to carry. Failures array lets the caller abort before
// anything destructive happens.
async function snapshotV1ModuleConfigs(projectRoot) {
  const snapshot = {};
  const failures = [];
  for (const mod of V1_MODULE_NAMES) {
    const modDir = path.join(projectRoot, V1_ADDON_DIR_NAME, 'modules', mod);
    if (!(await fs.pathExists(modDir))) continue;
    try {
      const files = await collectTreeFiles(modDir);
      if (files.length > 0) snapshot[mod] = files;
    } catch (err) {
      failures.push({ mod, err });
    }
  }
  return { snapshot, failures };
}

async function applyV1ModuleConfigs(projectRoot, snapshot) {
  const applied = [];
  for (const mod of Object.keys(snapshot)) {
    const modDest = path.join(projectRoot, PROJECT_ADDON_DIR_NAME, 'modules', mod);
    for (const { relPath, buffer } of snapshot[mod]) {
      const dest = path.join(modDest, relPath);
      await fs.ensureDir(path.dirname(dest));
      // writeAtomic handles both string and Buffer bodies — a mid-write
      // SIGKILL leaves the previous bundled default in place, never a
      // truncated hybrid.
      await writeAtomic(dest, buffer);
      applied.push(`modules/${mod}/${relPath}`);
    }
  }
  return applied;
}

// Emergency fallback when applyV1ModuleConfigs throws: the in-memory
// snapshot is stringified to a recovery file so the user can re-apply
// manually after fixing whatever blocked the write. Without this the
// snapshot would be lost and the v1 directory is already gone by now.
//
// If the recovery file already exists (prior failed migration that the
// user hasn't yet cleaned up), we write to a timestamped variant instead
// of overwriting the earlier snapshot — that earlier snapshot might be
// the user's only record of the previous v1 state. The write itself is
// atomic so a crash mid-write doesn't leave a truncated JSON.
async function persistSnapshotForRecovery(projectRoot, snapshot) {
  const plainRecoveryFile = path.join(projectRoot, '.sprintpilot-v1-snapshot.json');
  let recoveryFile = plainRecoveryFile;
  if (await fs.pathExists(plainRecoveryFile)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    recoveryFile = path.join(projectRoot, `.sprintpilot-v1-snapshot-${stamp}.json`);
  }
  const serialized = {};
  for (const mod of Object.keys(snapshot)) {
    serialized[mod] = snapshot[mod].map((f) => ({
      relPath: f.relPath,
      // base64 so arbitrary bytes round-trip through JSON without encoding loss
      contentBase64: f.buffer.toString('base64'),
    }));
  }
  const body = JSON.stringify({
    note: 'v1 module-config snapshot — restore manually under _Sprintpilot/modules/ and delete this file. Each file.contentBase64 is base64-encoded.',
    capturedAt: new Date().toISOString(),
    modules: serialized,
  }, null, 2);
  await writeAtomic(recoveryFile, body);
  return recoveryFile;
}

// Pick a backup path that does NOT already exist. The plain name is
// `<file>.bak-sprintpilot-migration`; if it exists (a second migration
// run), use a timestamp-qualified variant instead. The pristine
// pre-migration backup from the FIRST run must never be overwritten.
async function pickBackupPath(file) {
  const plain = `${file}.bak-sprintpilot-migration`;
  if (!(await fs.pathExists(plain))) return plain;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${file}.bak-sprintpilot-migration-${stamp}`;
}

// Strip the <!-- BEGIN:bmad-workflow-rules --> ... END block from user rule
// files. If the file ends up empty after stripping, we DO NOT delete it:
// we save a backup at <file>.bak-sprintpilot-migration[-<timestamp>] and
// write the stripped content (empty or not) in place, so nothing is ever
// silently destroyed. Backup write uses writeAtomic so a SIGKILL mid-write
// leaves either the prior backup or no backup, never a truncated one.
async function stripLegacyMarkers(projectRoot) {
  const touched = [];
  const candidates = [
    path.join(projectRoot, 'AGENTS.md'),
    path.join(projectRoot, 'GEMINI.md'),
    path.join(projectRoot, '.windsurfrules'),
    path.join(projectRoot, '.clinerules'),
    path.join(projectRoot, '.github', 'copilot-instructions.md'),
  ];
  for (const file of candidates) {
    if (!(await fs.pathExists(file))) continue;
    const content = await fs.readFile(file, 'utf8');
    if (!hasLegacyBlock(content)) continue;
    const stripped = stripLegacyBlock(content);
    const backup = await pickBackupPath(file);
    // Write the backup FIRST and atomically — only proceed to overwrite
    // the source if the backup landed successfully.
    await writeAtomic(backup, content);
    if (!stripped.trim()) {
      await writeAtomic(file, '');
      touched.push(`emptied ${path.relative(projectRoot, file)} (was legacy-only) — backup at ${path.relative(projectRoot, backup)}`);
    } else {
      await writeAtomic(file, stripped.endsWith('\n') ? stripped : `${stripped}\n`);
      touched.push(`stripped legacy block from ${path.relative(projectRoot, file)} — backup at ${path.relative(projectRoot, backup)}`);
    }
  }
  // Dedicated-file tools (cursor, roo, kiro, trae): the whole file is ours;
  // the legacy template was written as a raw block, so a fresh install will
  // overwrite it. No legacy-marker strip needed there.
  return touched;
}

// Evict v1 skill dirs from tool skill dirs INSIDE projectRoot only. We
// deliberately do NOT touch user-global ~/.claude/skills/ — a project-level
// install must not reach across projects on the same machine.
async function evictV1SkillsFromToolDirs(projectRoot) {
  const removed = [];
  const toolSkillDirs = [];
  for (const tool of ALL_TOOLS) {
    const toolDir = getToolDir(tool);
    if (!toolDir) continue;
    toolSkillDirs.push(path.join(projectRoot, toolDir, 'skills'));
  }

  for (const dir of toolSkillDirs) {
    if (!(await fs.pathExists(dir))) continue;
    for (const v1Name of V1_SKILL_NAMES) {
      const target = path.join(dir, v1Name);
      if (await fs.pathExists(target)) {
        await fs.remove(target);
        removed.push(path.relative(projectRoot, target));
      }
    }
  }
  return removed;
}

// Best-effort detection of a lingering global install of the v1 npm
// package. When `npm ls -g --json` exits non-zero (e.g. ELSPROBLEMS from
// unrelated peerDep warnings), it still writes valid JSON to stdout, so
// we inspect err.stdout before giving up.
async function detectOldGlobalNpmPackage() {
  const parseOutput = (out) => {
    try {
      const data = JSON.parse(out);
      const deps = (data && data.dependencies) || {};
      return Object.prototype.hasOwnProperty.call(deps, 'bmad-autopilot-addon');
    } catch {
      return null;
    }
  };

  try {
    const { stdout } = await execFileAsync('npm', ['ls', '-g', '--depth=0', '--json'], { timeout: 10_000 });
    const result = parseOutput(stdout);
    return result === null ? false : result;
  } catch (err) {
    if (err && typeof err.stdout === 'string' && err.stdout.length) {
      const result = parseOutput(err.stdout);
      if (result !== null) return result;
    }
    return false;
  }
}

// Coordinate the legacy-package → Sprintpilot transition. Returns a
// "config snapshot" which the caller must apply AFTER the bundled
// Sprintpilot resources have been copied (otherwise step 6 of runInstall
// would overwrite the user's values with pristine bundled defaults). If
// no legacy install is present, returns { migrated: false,
// moduleConfigSnapshot: {} }.
async function evictV1Installation(projectRoot, { dryRun, migrateV1, yes }) {
  const v1 = await detectV1Installation(projectRoot);
  if (!v1) return { migrated: false, moduleConfigSnapshot: {} };

  console.log(pc.yellow('=== Legacy bmad-autopilot-addon (v1) detected ==='));
  console.log('  Location: ' + v1.v1Dir);
  switch (v1.detectedVia) {
    case 'manifest':
      break;
    case 'skills-no-manifest':
      console.log(pc.yellow('  (v1 manifest missing — detected via v1-named skill directories)'));
      break;
    case 'skills-unreadable-manifest':
      console.log(pc.yellow('  (v1 manifest unreadable — detected via v1-named skill directories)'));
      break;
    case 'skills-other-addon':
      console.log(pc.yellow(`  (manifest names addon "${v1.manifestAddonName}" — NOT bmad-ma-git — but v1-named skill directories are present)`));
      break;
    default:
      // Fail-closed: an unknown detection reason means we don't fully
      // understand what we're about to migrate. Require explicit opt-in.
      console.error(pc.red(`ERROR: unknown v1 detection reason "${v1.detectedVia}". Refusing to auto-migrate.`));
      console.error(pc.red('  Pass --migrate-v1 explicitly if you want to proceed anyway.'));
      if (!migrateV1) throw new V1MigrationDeclinedError();
      break;
  }
  console.log('');

  // Ambiguous case: manifest cleanly names something ELSE, yet we see v1
  // skill dirs. Refuse to auto-migrate under -y; require interactive
  // confirmation or an explicit --migrate-v1.
  if (v1.detectedVia === 'skills-other-addon' && !migrateV1) {
    console.error(pc.red('ERROR: ambiguous v1 signature.'));
    console.error(pc.red(`  The manifest at ${path.relative(projectRoot, v1.v1Manifest)} names "${v1.manifestAddonName}", not "bmad-ma-git",`));
    console.error(pc.red('  but v1-named skill directories are present. This might be a custom install.'));
    console.error(pc.red('  If you want Sprintpilot to migrate it anyway, pass --migrate-v1 explicitly:'));
    console.error('      sprintpilot install --migrate-v1' + (yes ? ' --yes' : ''));
    throw new V1MigrationDeclinedError();
  }

  // Non-TTY detection: if stdin is not a TTY and neither --yes nor
  // --migrate-v1 was passed, we'd prompt into the void and the user never
  // sees the question. Fail early with the same guidance as the -y path.
  // Defensive: some sandboxed runtimes expose a non-readable stdin or
  // throw on property access, so treat any unexpected state as "not TTY".
  let isTTY = false;
  try {
    isTTY = process.stdin && process.stdin.isTTY === true && !process.stdin.destroyed;
  } catch { /* treat as non-TTY */ }
  if (!migrateV1 && !yes && !isTTY) {
    console.error(pc.red('ERROR: v1 install detected but stdin is not a TTY — cannot prompt for confirmation.'));
    console.error(pc.red('Re-run with --migrate-v1 --yes to migrate non-interactively:'));
    console.error('    sprintpilot install --migrate-v1 --yes');
    throw new V1MigrationDeclinedError();
  }

  if (yes && !migrateV1) {
    // -y/--yes alone should not silently perform destructive migration.
    // Require --migrate-v1 explicitly. This protects CI workflows that
    // pass -y for *install* confirmation from unintentionally rewriting
    // the repo's v1 footprint.
    console.error(pc.red('ERROR: v1 install detected but --migrate-v1 was not passed.'));
    console.error(pc.red('Sprintpilot will NOT silently migrate v1 under -y. Re-run with:'));
    console.error('    sprintpilot install --migrate-v1 --yes');
    console.error('Or interactively (omit -y) and answer the migration prompt.');
    throw new V1MigrationDeclinedError();
  }

  if (!migrateV1 && !yes) {
    const proceed = await prompts.confirm({
      message: 'Migrate this project from bmad-autopilot-addon to Sprintpilot? (preserves module configs, removes legacy artifacts, backs up rule files)',
      initialValue: false,
    });
    if (!proceed) {
      console.log(pc.dim('Migration declined — install aborted. Re-run and confirm to migrate.'));
      throw new V1MigrationDeclinedError();
    }
  }

  if (dryRun) {
    console.log(pc.dim('[DRY RUN] Would snapshot legacy module configs, strip legacy markers (with backups), evict legacy skills from project tool dirs, remove _bmad-addons/, then re-apply snapshot after Sprintpilot install.'));
    return { migrated: true, moduleConfigSnapshot: {} };
  }

  // 0. Add gitignore entries BEFORE creating any backup or recovery
  //    files. stripLegacyMarkers writes *.bak-sprintpilot-migration
  //    regardless of whether modules/ has anything to snapshot, and
  //    persistSnapshotForRecovery can fire if step 6a fails — both must
  //    be git-ignored. Previously the ignore entry was added only when a
  //    module snapshot existed, which missed the legacy-markers-only
  //    migration case.
  try {
    const ignore = await resolveIgnoreFile(projectRoot);
    await addIgnoreEntry(ignore.path, '*.bak-sprintpilot-migration', { dryRun: false });
    await addIgnoreEntry(ignore.path, '.sprintpilot-v1-snapshot*.json', { dryRun: false });
  } catch { /* non-blocking: the migration must not fail if .gitignore is unwritable */ }

  // 1. Snapshot the full v1 modules/ tree into memory BEFORE any
  //    destructive operation. Templates (commit-story.txt, pr-body.md,
  //    …) and config.yaml are all captured so user customizations
  //    survive. If any read fails, abort before removing the original.
  const { snapshot, failures } = await snapshotV1ModuleConfigs(projectRoot);
  if (failures.length) {
    console.error(pc.red('ERROR: failed to read v1 module files — aborting migration to avoid data loss:'));
    for (const { mod, err } of failures) {
      console.error(`  modules/${mod}/ — ${err.message || err}`);
    }
    throw new Error('v1 config snapshot failed');
  }
  for (const mod of Object.keys(snapshot)) {
    console.log(`  Captured v1 modules/${mod}/ (${snapshot[mod].length} file${snapshot[mod].length === 1 ? '' : 's'})`);
  }

  // 2. Strip legacy marker blocks from user rule files (with backups).
  const stripped = await stripLegacyMarkers(projectRoot);
  for (const s of stripped) console.log(`  ${s}`);

  // 3. Remove v1-named skill dirs from project-level tool skill dirs.
  const evicted = await evictV1SkillsFromToolDirs(projectRoot);
  for (const e of evicted) console.log(`  Removed legacy skill: ${e}`);

  // 4. Remove _bmad-addons/. Best-effort: if the rm fails (permission,
  //    Windows lock), warn and continue — snapshot is already in memory
  //    so Sprintpilot install can still proceed.
  try {
    await fs.remove(v1.v1Dir);
    console.log('  Removed ' + V1_ADDON_DIR_NAME + '/');
  } catch (err) {
    console.warn(pc.yellow(`  WARNING: failed to remove ${V1_ADDON_DIR_NAME}/ — ${err.message || err}`));
    console.warn(pc.yellow('  Remove it manually after install: rm -rf ' + V1_ADDON_DIR_NAME));
  }

  // 5. Advisory: lingering global npm install of v1 package.
  const hasOldGlobal = await detectOldGlobalNpmPackage();
  if (hasOldGlobal) {
    console.log('');
    console.log(pc.yellow('Legacy npm package detected: bmad-autopilot-addon is installed globally.'));
    console.log(pc.yellow('Run this to remove it:'));
    console.log('    npm uninstall -g bmad-autopilot-addon');
  }

  console.log('');
  console.log(pc.green('Legacy artifacts evicted. Continuing with Sprintpilot install...'));
  console.log('');
  return { migrated: true, moduleConfigSnapshot: snapshot };
}

async function runInteractiveToolPicker(detected) {
  const options = ALL_TOOLS.map((tool) => ({
    value: tool,
    label: `${tool} → ${getToolDir(tool)}/skills/`,
    hint: detected.includes(tool) ? 'detected' : undefined,
  }));

  const initial = detected.length > 0 ? detected : undefined;

  const selected = await prompts.multiselect({
    message: 'Select target tools for add-on installation',
    options,
    initialValues: initial,
    required: true,
  });

  return selected;
}

async function runInstall(options = {}) {
  const projectRoot = process.env.BMAD_PROJECT_ROOT || process.cwd();
  const dryRun = !!options.dryRun;
  const force = !!options.force;
  const yes = !!options.yes;
  const migrateV1 = !!options.migrateV1;

  const addonVersion = await readAddonManifestVersion(path.join(ADDON_DIR, 'manifest.yaml'));

  // Non-blocking update check
  let latestVersionPromise = fetchLatestVersion().catch(() => null);

  process.stdout.write(pc.cyan(BANNER));
  if (addonVersion) console.log(pc.cyan(`  v${addonVersion}`));
  console.log('');

  // 1. Verify BMad Method installed
  const bmadManifest = await verifyBmadInstalled(projectRoot);
  if (!bmadManifest) {
    console.error(pc.red(`ERROR: BMad Method not found at ${projectRoot}`));
    console.error('Install BMad Method first: npx bmad-method install');
    process.exit(1);
  }
  const bmadVersion = bmadManifest.version || 'unknown';
  console.log(`BMad Method version: ${bmadVersion}`);
  console.log('');

  // 1a. Evict v1 (bmad-autopilot-addon) artifacts if present. We capture
  //     the v1 module-config snapshot here and re-apply it AFTER step 6,
  //     because step 6 overwrites _Sprintpilot/modules/ with the pristine
  //     bundled configs.
  let v1ConfigSnapshot = {};
  try {
    const v1Result = await evictV1Installation(projectRoot, { dryRun, migrateV1, yes });
    v1ConfigSnapshot = v1Result.moduleConfigSnapshot || {};
  } catch (err) {
    if (err instanceof V1MigrationDeclinedError) {
      process.exit(err.exitCode);
    }
    throw err;
  }

  // 2. Resolve output_folder
  const outputFolder = await readOutputFolder(projectRoot);
  const ctx = buildContext({ outputFolder });
  if (outputFolder !== '_bmad-output') {
    console.log(pc.dim(`Using output_folder: ${outputFolder}`));
    console.log('');
  }

  // 3. Detect + select tools
  const detected = await detectInstalledTools(projectRoot);

  let parsedTools = parseToolsArg(options.tools);
  let selectedTools;

  if (parsedTools) {
    selectedTools = parsedTools;
  } else if (yes) {
    if (detected.length === 0) {
      console.error(pc.red('ERROR: No tools detected. Specify with --tools'));
      process.exit(1);
    }
    selectedTools = detected;
    console.log(`Auto-detected tools: ${selectedTools.join(',')}`);
  } else {
    selectedTools = await runInteractiveToolPicker(detected);
  }

  // Validate
  const unknown = selectedTools.filter((t) => !isKnownTool(t));
  for (const t of unknown) console.warn(pc.yellow(`WARNING: unknown tool '${t}', skipping`));
  selectedTools = selectedTools.filter((t) => isKnownTool(t));

  if (selectedTools.length === 0) {
    console.error(pc.red('ERROR: No tools selected.'));
    process.exit(1);
  }

  console.log('');
  console.log(`Installing for: ${selectedTools.join(' ')}`);
  console.log('');

  // 4. .gitignore maintenance
  let ignore = await resolveIgnoreFile(projectRoot);
  const lockResult = await addIgnoreEntry(ignore.path, '.autopilot.lock', { dryRun });
  if (lockResult.added) {
    const name = path.basename(ignore.path);
    if (dryRun) {
      console.log(pc.dim(`[DRY RUN] Would ${lockResult.created ? 'create' : 'add'} '.autopilot.lock' in ${name}`));
    } else if (lockResult.created) {
      console.log(`Created ${name} with '.autopilot.lock'`);
    } else {
      console.log(`Added '.autopilot.lock' to ${name}`);
    }
  }

  // 5. Install skills per tool
  let totalInstalled = 0;
  const allSkills = await listSkills();
  const skillCount = allSkills.length;
  const ts = timestamp();

  for (const tool of selectedTools) {
    const toolDir = getToolDir(tool);
    const skillsDir = path.join(projectRoot, toolDir, 'skills');
    const backupDir = path.join(projectRoot, toolDir, '.addon-backups');

    const backupIgnoreEntry = `${toolDir}/.addon-backups/`;
    const backupIgnoreResult = await addIgnoreEntry(ignore.path, backupIgnoreEntry, { dryRun });
    if (backupIgnoreResult.added) {
      const name = path.basename(ignore.path);
      if (dryRun) {
        console.log(pc.dim(`[DRY RUN] Would add '${backupIgnoreEntry}' to ${name}`));
      } else {
        console.log(`Added '${backupIgnoreEntry}' to ${name}`);
      }
    }

    console.log(`--- ${tool} → ${toolDir}/skills/ ---`);

    if (!(await fs.pathExists(skillsDir))) {
      if (dryRun) {
        console.log(pc.dim(`  [DRY RUN] Would create ${skillsDir}`));
      } else {
        await fs.ensureDir(skillsDir);
        console.log(`  Created: ${skillsDir}`);
      }
    }

    let toolInstalled = 0;
    for (const skillName of allSkills) {
      const src = path.join(ADDON_DIR, 'skills', skillName);
      const target = path.join(skillsDir, skillName);
      const targetExists = await fs.pathExists(target);

      if (targetExists && !force) {
        if (dryRun) {
          console.log(pc.dim(`  [DRY RUN] Would backup ${skillName}`));
        } else {
          await backupSkill(target, backupDir, ts);
        }
      }

      if (dryRun) {
        console.log(pc.dim(`  [DRY RUN] Would install ${skillName}`));
      } else {
        // Three-phase swap so an interrupt between any two steps leaves the
        // user with *some* working skill directory at `target`:
        //   1. Copy new content to `target.new` (target is still the old one).
        //   2. If `target` exists, rename it to `target.old`.
        //   3. Rename `target.new` to `target`.
        //   4. Remove `target.old`.
        // Stage 3 is the only non-atomic window, and it's a single rename
        // (on the same filesystem), which the kernel implements atomically.
        const stagingTarget = `${target}.new`;
        const oldTarget = `${target}.old`;
        await fs.remove(stagingTarget);
        await fs.remove(oldTarget); // clean any leftover from a crashed install
        try {
          await copyDirWithSubstitution(src, stagingTarget, ctx);
          const targetExistsNow = await fs.pathExists(target);
          if (targetExistsNow) {
            await fs.rename(target, oldTarget);
          }
          try {
            await fs.rename(stagingTarget, target);
          } catch (e) {
            // Swap failed — put the old target back so the tool still has
            // a skill present, then re-raise.
            if (targetExistsNow) {
              try { await fs.rename(oldTarget, target); } catch { /* best effort */ }
            }
            throw e;
          }
          if (targetExistsNow) {
            await fs.remove(oldTarget);
          }
        } catch (e) {
          try { await fs.remove(stagingTarget); } catch { /* best effort */ }
          throw e;
        }
        toolInstalled++;
      }
    }

    if (!dryRun) {
      for (const skillName of allSkills) {
        await pruneBackups(backupDir, skillName, 3);
      }
      console.log(`  Installed ${toolInstalled} skills`);
      totalInstalled += toolInstalled;
    }

    await installSystemPrompt(tool, projectRoot, ADDON_DIR, ctx, { dryRun });
    console.log('');
  }

  // 6. Copy runtime resources into project's _Sprintpilot/
  const targetAddonDir = path.join(projectRoot, '_Sprintpilot');
  if (dryRun) {
    console.log(pc.dim(`[DRY RUN] Would copy runtime resources to ${targetAddonDir}`));
  } else {
    await fs.ensureDir(targetAddonDir);
    for (const item of RUNTIME_RESOURCES) {
      const src = path.join(ADDON_DIR, item);
      if (!(await fs.pathExists(src))) continue;
      const dest = path.join(targetAddonDir, item);
      const stat = await fs.stat(src);
      if (stat.isDirectory()) {
        await fs.remove(dest);
        await copyDirWithSubstitution(src, dest, ctx);
      } else if (isTextFile(src)) {
        const raw = await fs.readFile(src, 'utf8');
        await fs.writeFile(dest, renderString(raw, ctx), 'utf8');
      } else {
        await fs.copy(src, dest, { overwrite: true });
      }
    }
    console.log('Runtime resources installed to _Sprintpilot/');

    // 6a. Re-apply v1 module-config snapshot (if any) — MUST happen after
    //     step 6 because step 6 wrote pristine bundled configs that would
    //     otherwise clobber the user's values. On failure, persist the
    //     snapshot to disk so the user can recover manually.
    if (Object.keys(v1ConfigSnapshot).length > 0) {
      try {
        const reapplied = await applyV1ModuleConfigs(projectRoot, v1ConfigSnapshot);
        for (const r of reapplied) console.log(`  Preserved v1 ${r}`);
      } catch (err) {
        console.error(pc.red('ERROR: failed to re-apply legacy module snapshot after Sprintpilot install.'));
        console.error(pc.red(`  ${err.message || err}`));
        try {
          const recoveryFile = await persistSnapshotForRecovery(projectRoot, v1ConfigSnapshot);
          console.error(pc.yellow(`  Snapshot persisted to ${path.relative(projectRoot, recoveryFile)} — restore manually.`));
        } catch (persistErr) {
          console.error(pc.red(`  Additionally failed to persist snapshot: ${persistErr.message || persistErr}`));
        }
        throw err;
      }
    }
    // Gitignore entries for *.bak-sprintpilot-migration and
    // .sprintpilot-v1-snapshot*.json were added up-front in
    // evictV1Installation (step 0) so they're in place even if the
    // module-snapshot branch never runs.
  }

  // 7. Verify git check-ignore
  if (!dryRun) {
    await verifyCheckIgnore(projectRoot, '.autopilot.lock');
  }

  // 8. Report
  console.log('');
  if (dryRun) {
    console.log(pc.green('Dry run complete. No changes made.'));
    return;
  }

  console.log(pc.green(`=== Sprintpilot v${addonVersion || 'unknown'} installed ===`));
  console.log('');
  console.log(`Tools configured: ${selectedTools.join(' ')}`);
  console.log(`Total skills installed: ${totalInstalled} (${skillCount} skills x ${selectedTools.length} tools)`);
  console.log('');
  console.log('Skills:');
  for (const skill of allSkills) console.log(`  - ${skill}`);
  console.log('');
  console.log('Locations:');
  for (const tool of selectedTools) console.log(`  ${tool} → ${getToolDir(tool)}/skills/`);
  console.log('');
  console.log('Getting started:');
  console.log('  /sprint-autopilot-on   Engage autonomous story execution');
  console.log('  /sprint-autopilot-off  Disengage and show status');
  console.log('  /bmad-help             Orientation and next-step guidance (from BMad Method)');
  console.log('');
  console.log('Configuration (edit these files to customize behavior):');
  console.log('');
  console.log('  _Sprintpilot/modules/git/config.yaml');
  console.log('    git.base_branch       main        Branch PRs target');
  console.log('    git.branch_prefix     story/      Story branch naming');
  console.log('    git.lint.enabled      true        Lint changed files');
  console.log('    git.lint.blocking     false       true = lint errors halt autopilot');
  console.log('    git.push.auto         true        Auto-push after commit');
  console.log('    git.push.create_pr    true        Create PR (false = direct merge)');
  console.log('    git.platform.provider auto        auto|github|gitlab|bitbucket|gitea');
  console.log('');
  console.log('  _Sprintpilot/modules/ma/config.yaml');
  console.log('    multi_agent.enabled               true   Enable parallel agents');
  console.log('    multi_agent.max_parallel_analysis  5      Codebase analysis agents');
  console.log('');
  console.log('  _Sprintpilot/modules/autopilot/config.yaml');
  console.log('    autopilot.session_story_limit    3      Stories to fully implement per run (0 = unlimited)');
  console.log('');
  console.log('Multi-agent skills — run parallel subagents for faster analysis:');
  console.log('  /sprintpilot-code-review       Parallel 3-layer adversarial review');
  console.log('  /sprintpilot-codebase-map      5-stream brownfield codebase analysis');
  console.log('  /sprintpilot-assess            Tech debt and dependency audit');
  console.log('  /sprintpilot-reverse-architect Extract architecture from existing code');
  console.log('  /sprintpilot-migrate           Legacy migration planning');
  console.log('  /sprintpilot-research          Parallel web research');
  console.log('  /sprintpilot-party-mode        Multi-persona agent discussions');

  const latestVersion = await latestVersionPromise;
  if (latestVersion && addonVersion && compareVersions(addonVersion, latestVersion) === 'behind') {
    const msg = [
      pc.yellow(`┌─────────────────────────────────────────────────────────┐`),
      pc.yellow(`│  Update available: ${addonVersion} → ${latestVersion}`),
      pc.yellow(`│  Run: npx sprintpilot@latest`),
      pc.yellow(`└─────────────────────────────────────────────────────────┘`),
      '',
    ].join('\n');
    console.log(msg);
  }
  console.log('Apache 2.0 License — Igor Kunin — https://github.com/ikunin/sprintpilot');
}

module.exports = { runInstall };
