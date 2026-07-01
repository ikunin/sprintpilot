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
  extractBmadVersion,
} = require('../core/bmad-config');
const { resolveIgnoreFile, addIgnoreEntry } = require('../core/gitignore');
const { copyDirWithSubstitution, backupSkill, pruneBackups } = require('../core/file-ops');
const {
  stripLegacyBlock,
  upsertBlock,
  writeAtomic,
  hasBlock,
  hasLegacyBlock,
} = require('../core/markers');
const { renderString, buildContext, isTextFile } = require('../substitute');
const { fetchLatestVersion, compareVersions } = require('../core/update-check');
const { mergeYamlConfig, mergeTemplateFile } = require('../core/config-merger');
const { scanForLeftoverSnapshots } = require('../core/v2-upgrade-recovery');
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

// Render the banner with the version appended to the 2nd-to-last banner
// line (the `|____/...` row). The very last row is just the `|_|`
// descender under the "p", so placing the version on the row above keeps
// it visually aligned with the main body of the logo.
function renderBanner(version) {
  if (!version) return BANNER;
  const lines = BANNER.split('\n');
  // Indexing: [0] leading empty, [1-6] banner rows, [7] trailing empty.
  // The 2nd-to-last banner row is index 5.
  const targetIdx = 5;
  if (lines[targetIdx] !== undefined) {
    lines[targetIdx] = `${lines[targetIdx]}   v${version}`;
  }
  return lines.join('\n');
}

const { V1_ADDON_DIR_NAME, V1_SKILL_NAMES, detectV1Installation } = require('../core/v1-detect');

const ADDON_DIR = path.resolve(__dirname, '..', '..', '_Sprintpilot');
const PROJECT_ADDON_DIR_NAME = '_Sprintpilot';
const DEFAULT_SESSION_STORY_LIMIT = 3;
const DEFAULT_RETROSPECTIVE_MODE = 'auto';
const RETROSPECTIVE_MODES = ['auto', 'stop', 'skip'];
const COMPLEXITY_PROFILES = ['nano', 'small', 'medium', 'large', 'legacy'];
const DEFAULT_COMPLEXITY_PROFILE = 'medium';
const RUNTIME_RESOURCES = [
  'Sprintpilot.md',
  'manifest.yaml',
  '.secrets-allowlist',
  'bin',
  'lib',
  'modules',
  'scripts',
  'templates',
];

// Files under _Sprintpilot/ that users edit. Step 6 nukes these along
// with everything else when copying the bundled tree; we snapshot them
// BEFORE step 6 and restore them AFTER, using a per-file strategy:
//
//   strategy: 'yaml'     — line-aware merge (config-merger.mergeYamlConfig).
//                          User scalars patched into the freshly-copied
//                          bundled file. Bundled comments + new keys
//                          preserved. Orphan user keys land in a footer
//                          `# Preserved from prior install` block.
//
//   strategy: 'template' — skip-if-exists. If the user file differs from
//                          bundled, keep the user version verbatim and
//                          write bundled next door as <file>.bundled.
const USER_OWNED_FILES = [
  { path: 'modules/git/config.yaml', strategy: 'yaml' },
  { path: 'modules/ma/config.yaml', strategy: 'yaml' },
  { path: 'modules/autopilot/config.yaml', strategy: 'yaml' },
  { path: 'modules/git/templates/pr-body.md', strategy: 'template' },
  { path: 'modules/git/templates/commit-story.txt', strategy: 'template' },
  { path: 'modules/git/templates/commit-patch.txt', strategy: 'template' },
  { path: '.secrets-allowlist', strategy: 'template' },
];

// Explicit dot-path renames the installer maps when reading old user
// configs. Empty for the 2.1.x baseline; add entries when a future
// release renames a key so user customizations land at the new path.
const KEY_RENAMES = Object.freeze({
  // 'old.dotted.path': 'new.dotted.path'
});

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
  return trimmed
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

async function detectInstalledTools(projectRoot) {
  const detected = [];
  for (const tool of ALL_TOOLS) {
    const dir = getToolDir(tool);
    if (!dir) continue;
    const skillsDir = path.join(projectRoot, dir, 'skills');
    if (await fs.pathExists(skillsDir)) {
      detected.push(tool);
      continue;
    }
    // Migration aid: gemini-cli moved from .gemini/skills/ to .agents/skills/.
    // A user upgrading from a pre-rename install has no .agents/skills/ yet,
    // so detect their prior gemini-cli install by Sprintpilot-namespace dirs
    // under the legacy .gemini/skills/ path.
    if (tool === 'gemini-cli' && (await hasLegacyGeminiSprintpilotSkills(projectRoot))) {
      detected.push(tool);
    }
  }
  return detected;
}

const LEGACY_GEMINI_SKILLS_DIR = '.gemini';

async function hasLegacyGeminiSprintpilotSkills(projectRoot) {
  const legacyDir = path.join(projectRoot, LEGACY_GEMINI_SKILLS_DIR, 'skills');
  if (!(await fs.pathExists(legacyDir))) return false;
  let entries;
  try {
    entries = await fs.readdir(legacyDir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some(
    (e) => e.isDirectory() && SPRINTPILOT_SKILL_PREFIXES.some((p) => e.name.startsWith(p)),
  );
}

// v2.6.x — gemini-cli skill dir moved from .gemini/skills/ to .agents/skills/
// to align with the AGENTS spec that other Gemini-family tooling now reads.
// Sweep the legacy location for Sprintpilot-namespace skill dirs only (prefix
// SPRINTPILOT_SKILL_PREFIXES). Anything outside that prefix — including the
// user's own custom skills under .gemini/skills/ — is left strictly alone.
// Evicted dirs are backed up to the NEW tool dir's .sprintpilot-backups/ so
// the user can recover if needed. Idempotent.
async function evictLegacyGeminiSprintpilotSkills(
  projectRoot,
  backupDir,
  ts,
  { dryRun = false } = {},
) {
  const legacyDir = path.join(projectRoot, LEGACY_GEMINI_SKILLS_DIR, 'skills');
  if (!(await fs.pathExists(legacyDir))) return [];
  const evicted = [];
  let entries;
  try {
    entries = await fs.readdir(legacyDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (!SPRINTPILOT_SKILL_PREFIXES.some((p) => name.startsWith(p))) continue;
    if (dryRun) {
      evicted.push(name);
      continue;
    }
    const target = path.join(legacyDir, name);
    try {
      await backupSkill(target, backupDir, ts);
      await fs.remove(target);
      evicted.push(name);
    } catch {
      // Best-effort: skip on failure rather than aborting the install.
    }
  }
  return evicted;
}

async function listSkills() {
  const skillsDir = path.join(ADDON_DIR, 'skills');
  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
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
    const existed = await fs.pathExists(agentsFile);
    const existing = existed ? await fs.readFile(agentsFile, 'utf8') : '';
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
      await fs.writeFile(
        claudeFile,
        `${claudeContent}${needsNewline ? '\n' : ''}@AGENTS.md\n`,
        'utf8',
      );
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

// Snapshot user-owned files BEFORE the destructive step-6 copy. For each
// path in USER_OWNED_FILES that exists under targetAddonDir today, capture
// its current content along with the strategy. Returns an array; entries
// for files that don't exist yet (fresh installs) are simply absent.
async function snapshotUserOwnedFiles(targetAddonDir) {
  const out = [];
  for (const entry of USER_OWNED_FILES) {
    const abs = path.join(targetAddonDir, entry.path);
    if (!(await fs.pathExists(abs))) continue;
    try {
      const buffer = await fs.readFile(abs);
      out.push({ path: entry.path, strategy: entry.strategy, buffer });
    } catch {
      // Unreadable user file — skip; the bundled default will land.
    }
  }
  return out;
}

// Apply the user-owned snapshot back over the freshly-copied bundled files,
// using the per-file strategy. Writes are atomic via writeAtomic. Returns
// an array of `{ path, strategy, preserved, orphans, sidecar }` describing
// what happened for each file — the caller pretty-prints this to the user.
async function applyUserOwnedFiles(targetAddonDir, snapshot, keyRenames = {}) {
  const results = [];
  for (const entry of snapshot) {
    const abs = path.join(targetAddonDir, entry.path);
    const userText = entry.buffer.toString('utf8');
    let bundledText = '';
    try {
      bundledText = await fs.readFile(abs, 'utf8');
    } catch {
      // Bundled file no longer ships at this path — treat user file as
      // an orphan: keep it as-is, no sidecar (nothing to compare against).
      await writeAtomic(abs, entry.buffer);
      results.push({
        path: entry.path,
        strategy: entry.strategy,
        preserved: [],
        orphans: [],
        sidecar: false,
        note: 'bundled file no longer ships; user copy preserved',
      });
      continue;
    }

    if (entry.strategy === 'yaml') {
      const r = mergeYamlConfig(bundledText, userText, keyRenames);
      if (r.fallback) {
        // Merge couldn't parse — fall back to template strategy so the
        // user doesn't lose their file. Sidecar the bundled version.
        const t = mergeTemplateFile(bundledText, userText);
        await writeAtomic(abs, t.text);
        if (t.sidecar !== null) {
          await writeAtomic(`${abs}.bundled`, t.sidecar);
        }
        results.push({
          path: entry.path,
          strategy: 'template-fallback',
          preserved: [],
          orphans: [],
          sidecar: t.sidecar !== null,
          note: 'YAML merge fell back to skip-if-exists',
        });
        continue;
      }
      await writeAtomic(abs, r.text);
      results.push({
        path: entry.path,
        strategy: 'yaml',
        preserved: r.preserved,
        orphans: r.orphans,
        sidecar: false,
      });
    } else {
      // template strategy
      const t = mergeTemplateFile(bundledText, userText);
      await writeAtomic(abs, t.text);
      if (t.sidecar !== null) {
        await writeAtomic(`${abs}.bundled`, t.sidecar);
      }
      results.push({
        path: entry.path,
        strategy: 'template',
        preserved: t.kept === 'user' ? ['(verbatim)'] : [],
        orphans: [],
        sidecar: t.sidecar !== null,
      });
    }
  }
  return results;
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
  const body = JSON.stringify(
    {
      note: 'v1 module-config snapshot — restore manually under _Sprintpilot/modules/ and delete this file. Each file.contentBase64 is base64-encoded.',
      capturedAt: new Date().toISOString(),
      modules: serialized,
    },
    null,
    2,
  );
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
      touched.push(
        `emptied ${path.relative(projectRoot, file)} (was legacy-only) — backup at ${path.relative(projectRoot, backup)}`,
      );
    } else {
      await writeAtomic(file, stripped.endsWith('\n') ? stripped : `${stripped}\n`);
      touched.push(
        `stripped legacy block from ${path.relative(projectRoot, file)} — backup at ${path.relative(projectRoot, backup)}`,
      );
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
async function evictV1SkillsFromToolDirs(projectRoot, { dryRun = false } = {}) {
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
        if (!dryRun) await fs.remove(target);
        removed.push(path.relative(projectRoot, target));
      }
    }
  }
  return removed;
}

// Skills owned by Sprintpilot all live under one of these prefixes. Used
// by the orphan-prune sweep to scope which skill dirs the installer is
// allowed to touch. Anything outside these prefixes (BMad's own skills,
// user-authored skills, other addons) is left strictly alone.
const SPRINTPILOT_SKILL_PREFIXES = ['sprint-autopilot-', 'sprintpilot-'];

// v2.3.2 — orphan prune. After the per-tool deploy loop has installed the
// current set of skills, walk the tool's skills/ dir and remove any
// Sprintpilot-namespace skill dirs that fell out of the manifest between
// releases. Without this, skills removed in a later release (e.g.
// sprintpilot-code-review and sprintpilot-party-mode dropped in v2.3.1)
// linger in users' tool dirs forever, polluting the slash-command picker
// and pointing at stale internal code.
//
// Returns the list of orphan names (relative). Backs up before removing,
// using the same .sprintpilot-backups/ convention as the install loop.
async function pruneOrphanSkillsFromToolDir(
  skillsDir,
  currentSkills,
  backupDir,
  ts,
  { dryRun = false } = {},
) {
  if (!(await fs.pathExists(skillsDir))) return [];
  const orphans = [];
  const currentSet = new Set(currentSkills);
  let entries;
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (!SPRINTPILOT_SKILL_PREFIXES.some((p) => name.startsWith(p))) continue;
    if (currentSet.has(name)) continue;
    if (dryRun) {
      orphans.push(name);
      continue;
    }
    const target = path.join(skillsDir, name);
    try {
      await backupSkill(target, backupDir, ts);
      await fs.remove(target);
      orphans.push(name);
    } catch {
      // Best-effort: skip on failure rather than aborting the install.
    }
  }
  return orphans;
}

// Best-effort detection of a lingering global install of the v1 npm
// package. When `npm ls -g --json` exits non-zero (e.g. ELSPROBLEMS from
// unrelated peerDep warnings), it still writes valid JSON to stdout, so
// we inspect err.stdout before giving up.
async function detectOldGlobalNpmPackage() {
  const parseOutput = (out) => {
    try {
      const data = JSON.parse(out);
      const deps = data?.dependencies || {};
      return Object.hasOwn(deps, 'bmad-autopilot-addon');
    } catch {
      return null;
    }
  };

  try {
    const { stdout } = await execFileAsync('npm', ['ls', '-g', '--depth=0', '--json'], {
      timeout: 10_000,
    });
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
      console.log(
        pc.yellow('  (v1 manifest unreadable — detected via v1-named skill directories)'),
      );
      break;
    case 'skills-other-addon':
      console.log(
        pc.yellow(
          `  (manifest names addon "${v1.manifestAddonName}" — NOT bmad-ma-git — but v1-named skill directories are present)`,
        ),
      );
      break;
    default:
      // Fail-closed: an unknown detection reason means we don't fully
      // understand what we're about to migrate. Require explicit opt-in.
      console.error(
        pc.red(`ERROR: unknown v1 detection reason "${v1.detectedVia}". Refusing to auto-migrate.`),
      );
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
    console.error(
      pc.red(
        `  The manifest at ${path.relative(projectRoot, v1.v1Manifest)} names "${v1.manifestAddonName}", not "bmad-ma-git",`,
      ),
    );
    console.error(
      pc.red('  but v1-named skill directories are present. This might be a custom install.'),
    );
    console.error(
      pc.red('  If you want Sprintpilot to migrate it anyway, pass --migrate-v1 explicitly:'),
    );
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
  } catch {
    /* treat as non-TTY */
  }
  if (!migrateV1 && !yes && !isTTY) {
    console.error(
      pc.red('ERROR: v1 install detected but stdin is not a TTY — cannot prompt for confirmation.'),
    );
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
      message:
        'Migrate this project from bmad-autopilot-addon to Sprintpilot? (preserves module configs, removes legacy artifacts, backs up rule files)',
      initialValue: false,
    });
    if (!proceed) {
      console.log(pc.dim('Migration declined — install aborted. Re-run and confirm to migrate.'));
      throw new V1MigrationDeclinedError();
    }
  }

  if (dryRun) {
    console.log(
      pc.dim(
        '[DRY RUN] Would snapshot legacy module configs, strip legacy markers (with backups), evict legacy skills from project tool dirs, remove _bmad-addons/, then re-apply snapshot after Sprintpilot install.',
      ),
    );
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
  } catch {
    /* non-blocking: the migration must not fail if .gitignore is unwritable */
  }

  // 1. Snapshot the full v1 modules/ tree into memory BEFORE any
  //    destructive operation. Templates (commit-story.txt, pr-body.md,
  //    …) and config.yaml are all captured so user customizations
  //    survive. If any read fails, abort before removing the original.
  const { snapshot, failures } = await snapshotV1ModuleConfigs(projectRoot);
  if (failures.length) {
    console.error(
      pc.red('ERROR: failed to read v1 module files — aborting migration to avoid data loss:'),
    );
    for (const { mod, err } of failures) {
      console.error(`  modules/${mod}/ — ${err.message || err}`);
    }
    throw new Error('v1 config snapshot failed');
  }
  for (const mod of Object.keys(snapshot)) {
    console.log(
      `  Captured v1 modules/${mod}/ (${snapshot[mod].length} file${snapshot[mod].length === 1 ? '' : 's'})`,
    );
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
    console.warn(
      pc.yellow(`  WARNING: failed to remove ${V1_ADDON_DIR_NAME}/ — ${err.message || err}`),
    );
    console.warn(pc.yellow('  Remove it manually after install: rm -rf ' + V1_ADDON_DIR_NAME));
  }

  // 5. Advisory: lingering global npm install of v1 package.
  const hasOldGlobal = await detectOldGlobalNpmPackage();
  if (hasOldGlobal) {
    console.log('');
    console.log(
      pc.yellow('Legacy npm package detected: bmad-autopilot-addon is installed globally.'),
    );
    console.log(pc.yellow('Run this to remove it:'));
    console.log('    npm uninstall -g bmad-autopilot-addon');
  }

  console.log('');
  console.log(pc.green('Legacy artifacts evicted. Continuing with Sprintpilot install...'));
  console.log('');
  return { migrated: true, moduleConfigSnapshot: snapshot };
}

// Parse the user's existing autopilot config (if any) so interactive prompts
// can default to the current values AND so a v1 migration's patcher run
// preserves user-edited values rather than overwriting them with bundled
// defaults.
//
// Checks both locations, in order of precedence:
//   1. `_Sprintpilot/modules/autopilot/config.yaml`  — normal upgrade
//   2. `_bmad-addons/modules/autopilot/config.yaml`  — v1 legacy (bmad-
//      autopilot-addon), picked up BEFORE evictV1Installation moves it
//
// Regex-based so we don't add a YAML parser dep for two scalar fields.
// Unrecognized / unreadable files fall back to bundled defaults.
async function readExistingAutopilotConfig(projectRoot, v1Snapshot) {
  const out = {
    sessionStoryLimit: null,
    retrospectiveMode: null,
    // v2.3.0 additions. null means "not set in user config" → use the bundled
    // default. autoInferDependencies is read only to surface a deprecation
    // notice on upgrade — we never write it back.
    autoPlanOnStart: null,
    autoInferDependencies: null,
  };
  let raw = null;

  // Precedence order:
  //   1. `_Sprintpilot/modules/autopilot/config.yaml`  — normal upgrade
  //   2. `_bmad-addons/modules/autopilot/config.yaml`  — v1 legacy still
  //      on disk (install was invoked before evictV1Installation ran)
  //   3. v1 in-memory snapshot                         — v1 legacy already
  //      evicted; evictV1Installation captured the buffer before removing
  //      the directory, so we extract the autopilot/config.yaml bytes
  //      from there. Without this the patcher would overwrite the user's
  //      v1-preserved values with bundled defaults.
  const candidates = [
    path.join(projectRoot, PROJECT_ADDON_DIR_NAME, 'modules', 'autopilot', 'config.yaml'),
    path.join(projectRoot, V1_ADDON_DIR_NAME, 'modules', 'autopilot', 'config.yaml'),
  ];
  for (const file of candidates) {
    if (!(await fs.pathExists(file))) continue;
    try {
      raw = await fs.readFile(file, 'utf8');
      break;
    } catch {
      /* try next candidate */
    }
  }

  if (raw == null && v1Snapshot && Array.isArray(v1Snapshot.autopilot)) {
    const entry = v1Snapshot.autopilot.find((f) => f.relPath === 'config.yaml');
    if (entry && Buffer.isBuffer(entry.buffer)) {
      try {
        raw = entry.buffer.toString('utf8');
      } catch {
        /* unreadable — fall back to defaults */
      }
    }
  }

  if (raw == null) return out;

  // Both patterns tolerate a trailing `# comment` tail so users can annotate
  // their config without breaking upgrade detection (e.g.
  // `retrospective_mode: stop  # we want manual retros`). `[ \t]` rather
  // than `\s` inside each line so matches never cross a newline.
  const commentTail = /[ \t]*(?:#.*)?$/.source;

  // `session_story_limit: 3`  — unquoted integer, optional trailing comment
  const limitMatch = raw.match(
    new RegExp(`^[ \\t]*session_story_limit:[ \\t]*(\\d+)${commentTail}`, 'm'),
  );
  if (limitMatch) {
    const n = Number.parseInt(limitMatch[1], 10);
    if (Number.isFinite(n) && n >= 0) out.sessionStoryLimit = n;
  }
  // `retrospective_mode: auto` — unquoted or single/double-quoted string,
  // optional trailing comment
  const modeMatch = raw.match(
    new RegExp(`^[ \\t]*retrospective_mode:[ \\t]*["']?([a-zA-Z_-]+)["']?${commentTail}`, 'm'),
  );
  if (modeMatch && RETROSPECTIVE_MODES.includes(modeMatch[1])) {
    out.retrospectiveMode = modeMatch[1];
  }
  // v2.3.0 — `auto_plan_on_start: true|false`. Bool; bundled default is false.
  const planMatch = raw.match(
    new RegExp(`^[ \\t]*auto_plan_on_start:[ \\t]*(true|false)${commentTail}`, 'm'),
  );
  if (planMatch) {
    out.autoPlanOnStart = planMatch[1] === 'true';
  }
  // Legacy `auto_infer_dependencies: true|false` — read so the installer can
  // surface a deprecation notice when the user is upgrading from v2.2.x with
  // the flag set to true (it's now a no-op). Never written back.
  const inferMatch = raw.match(
    new RegExp(`^[ \\t]*auto_infer_dependencies:[ \\t]*(true|false)${commentTail}`, 'm'),
  );
  if (inferMatch) {
    out.autoInferDependencies = inferMatch[1] === 'true';
  }
  return out;
}

// Rewrite the `session_story_limit:` and `retrospective_mode:` scalar lines
// in the freshly-copied autopilot/config.yaml with the user's chosen values.
// Done as a line-level string replacement instead of a token-substitution
// because workflow.md uses the `{{session_story_limit}}` / `{{retrospective_mode}}`
// variable-reference syntax — threading these keys through `renderString`
// would match the inner `{key}` inside `{{key}}` and corrupt the workflow
// variables to literal `{value}` strings.
//
// Handles three shapes for each key:
//   1. line present with a value    → in-place replace (preserves trailing comment)
//   2. line present with no value   → in-place fill
//   3. line missing                 → append to the `autopilot:` block
// (3) is the path that catches v1 (bmad-autopilot-addon) migrations whose
// legacy config predates `retrospective_mode` — without it, the user's
// prompted choice would be silently dropped.
function applyScalar(source, key, value) {
  // Structure of a YAML scalar line we support:
  //   [indent][key]:[space(s)][value][space(s) + # comment]?
  //
  // Groups, non-greedy on value so the trailing-comment capture wins:
  //   indent  — leading whitespace (preserved verbatim)
  //   value   — `\S[^#\n]*?` — starts non-ws, stops as early as possible so
  //             the comment tail can match. Optional, so this also matches
  //             "key:\n" (no value at all) — P1-C.
  //   tail    — `\s*#.*` — the whitespace-before-# is INSIDE the tail capture
  //             so the original spacing ("value  # note") round-trips
  //             instead of collapsing to a single space.
  // Using [ \t] instead of \s everywhere INSIDE the line so the match
  // cannot cross a newline — `\s*` would greedily consume the trailing
  // `\n` after "key:" on an empty-value line, breaking the rewrite.
  // Escape the key so a metacharacter in it can't alter the pattern.
  const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- pattern built from a regex-escaped config key
  const replaceRe = new RegExp(`^([ \\t]*)${safeKey}:[ \\t]*(\\S[^#\\n]*?)?([ \\t]*#.*)?$`, 'm');
  if (replaceRe.test(source)) {
    return source.replace(replaceRe, (_m, indent, _oldValue, tail) => {
      return `${indent}${key}: ${value}${tail || ''}`;
    });
  }

  // Key is absent. Append under the `autopilot:` block at the file's end.
  // The bundled shipping config always starts with `autopilot:` at column
  // 0 and indents children two spaces — match that style. If the file has
  // no `autopilot:` header at all (hand-edited to a different shape), bail
  // rather than guess.
  if (!/^autopilot:\s*$/m.test(source)) return source;
  const trimmed = source.endsWith('\n') ? source : `${source}\n`;
  return `${trimmed}  ${key}: ${value}\n`;
}

async function patchAutopilotConfig(
  projectRoot,
  { sessionStoryLimit, retrospectiveMode, autoPlanOnStart },
) {
  const file = path.join(
    projectRoot,
    PROJECT_ADDON_DIR_NAME,
    'modules',
    'autopilot',
    'config.yaml',
  );
  if (!(await fs.pathExists(file))) return;
  const original = await fs.readFile(file, 'utf8');
  let updated = applyScalar(original, 'session_story_limit', sessionStoryLimit);
  updated = applyScalar(updated, 'retrospective_mode', retrospectiveMode);
  // v2.3.0 — auto_plan_on_start is a boolean. applyScalar handles literal
  // values (true/false) the same way as numbers; we just need to pass the
  // unquoted lowercase string for booleans.
  if (autoPlanOnStart !== undefined && autoPlanOnStart !== null) {
    updated = applyScalar(updated, 'auto_plan_on_start', autoPlanOnStart ? 'true' : 'false');
  }
  if (updated !== original) {
    await writeAtomic(file, updated);
  }
}

// Read the existing complexity_profile from autopilot/config.yaml so upgrades
// preserve the user's v2 profile choice. Uses regex for the same reason
// readExistingAutopilotConfig does — workflow.md's `{{variable}}` syntax
// means a full YAML parse would mis-interpret the raw file.
async function readExistingComplexityProfile(projectRoot, v1Snapshot) {
  let raw = null;
  const candidates = [
    path.join(projectRoot, PROJECT_ADDON_DIR_NAME, 'modules', 'autopilot', 'config.yaml'),
    path.join(projectRoot, V1_ADDON_DIR_NAME, 'modules', 'autopilot', 'config.yaml'),
  ];
  for (const file of candidates) {
    if (!(await fs.pathExists(file))) continue;
    try {
      raw = await fs.readFile(file, 'utf8');
      break;
    } catch {
      /* try next */
    }
  }
  if (raw == null && v1Snapshot && Array.isArray(v1Snapshot.autopilot)) {
    const entry = v1Snapshot.autopilot.find((f) => f.relPath === 'config.yaml');
    if (entry && Buffer.isBuffer(entry.buffer)) {
      try {
        raw = entry.buffer.toString('utf8');
      } catch {
        /* unreadable */
      }
    }
  }
  if (raw == null) return null;
  const commentTail = /[ \t]*(?:#.*)?$/.source;
  const m = raw.match(
    new RegExp(`^[ \\t]*complexity_profile:[ \\t]*["']?([a-zA-Z_-]+)["']?${commentTail}`, 'm'),
  );
  if (!m) return null;
  if (!COMPLEXITY_PROFILES.includes(m[1])) return null;
  return m[1];
}

// v2.3.0 — packaging-hygiene check. Cross-reference the project's
// _Sprintpilot/manifest.yaml `installed_skills` against what the npm
// package actually ships under `<bundleDir>/skills/<name>/SKILL.md`.
// Catches the classic "added skill to manifest but forgot to ship the
// files" bug at install time rather than at first invocation.
//
// IMPORTANT: this checks the BUNDLE (the npm package's source tree
// pointed to by `bundleDir`, default `ADDON_DIR`), not the project's
// _Sprintpilot/. The project never gets `skills/` copied to its
// _Sprintpilot/ — skills only land in per-tool dirs (.claude/skills/,
// .cursor/skills/, ...). Earlier versions wrongly checked the project
// path, which caused a false-positive WARN on every install. Fixed in
// v2.3.2.
//
// Returns { missing: string[] } — empty array means everything is
// wired correctly. The caller chooses how to surface mismatches
// (warning vs fail). We never fail the install on a mismatch; it's
// hygiene, not correctness.
async function verifySkillManifest(projectRoot, bundleDir = ADDON_DIR) {
  const manifestPath = path.join(projectRoot, PROJECT_ADDON_DIR_NAME, 'manifest.yaml');
  if (!(await fs.pathExists(manifestPath))) {
    return { missing: [] };
  }
  let raw;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch {
    return { missing: [] };
  }
  // Parse the YAML list under `installed_skills:` via regex — bullet
  // lines starting with `-` at consistent indent. Cheap; no YAML dep.
  const skillNames = [];
  const installedMatch = raw.match(/^[ \t]*installed_skills:\s*\n((?:[ \t]+- [^\n]+\n?)+)/m);
  if (installedMatch) {
    for (const line of installedMatch[1].split(/\n/)) {
      const m = line.match(/^[ \t]+-\s+([A-Za-z0-9._-]+)/);
      if (m) skillNames.push(m[1]);
    }
  }
  const missing = [];
  for (const name of skillNames) {
    const skillFile = path.join(bundleDir, 'skills', name, 'SKILL.md');
    if (!(await fs.pathExists(skillFile))) missing.push(name);
  }
  return { missing };
}

async function patchComplexityProfile(projectRoot, profile) {
  const file = path.join(
    projectRoot,
    PROJECT_ADDON_DIR_NAME,
    'modules',
    'autopilot',
    'config.yaml',
  );
  if (!(await fs.pathExists(file))) return;
  const original = await fs.readFile(file, 'utf8');
  const updated = applyScalar(original, 'complexity_profile', profile);
  if (updated !== original) {
    await writeAtomic(file, updated);
  }
}

// Validates --profile flag (if provided) and prompts interactively when
// neither flag nor --yes is set. Returns the resolved profile string.
// Backwards-compatible: if the user is upgrading and already has a profile
// key, default to that; if absent, default to 'medium' (matches v1.0.5).
async function resolveComplexityProfile({ projectRoot, yes, dryRun, options, v1Snapshot }) {
  const existing = await readExistingComplexityProfile(projectRoot, v1Snapshot);

  // Flag takes priority even in interactive mode so scripted runs are
  // deterministic. Invalid flag = hard fail, not a silent default.
  if (options?.profile) {
    if (!COMPLEXITY_PROFILES.includes(options.profile)) {
      console.error(
        pc.red(
          `ERROR: unknown --profile '${options.profile}'. Valid: ${COMPLEXITY_PROFILES.join(', ')}`,
        ),
      );
      process.exit(1);
    }
    return options.profile;
  }

  const fallback = existing || DEFAULT_COMPLEXITY_PROFILE;

  if (yes) {
    if (existing != null) {
      console.log(pc.dim(`Preserving complexity_profile: ${existing}`));
    } else {
      console.log(
        pc.dim(
          `complexity_profile not set; defaulting to '${DEFAULT_COMPLEXITY_PROFILE}' (matches v1.0.5 behavior).`,
        ),
      );
    }
    return fallback;
  }

  if (dryRun) {
    console.log(
      pc.dim(`[DRY RUN] Would prompt for complexity_profile (current default: ${fallback})`),
    );
    return fallback;
  }

  const profile = await prompts.select({
    message: 'Which complexity profile fits your project?',
    options: [
      {
        value: 'nano',
        label: 'nano   — toy / tutorial / learning, solo, small codebase',
      },
      {
        value: 'small',
        label: 'small  — MVP / internal tool / prototype, solo or 1–2 devs',
      },
      {
        value: 'medium',
        label: 'medium — team product with real users (recommended)',
      },
      {
        value: 'large',
        label: 'large  — production, compliance / uptime stakes',
      },
      {
        value: 'legacy',
        label: 'legacy — pre-v2 behavior (rollback escape hatch)',
      },
    ],
    initialValue: fallback,
  });

  return profile;
}

async function resolveAutopilotSettings({ projectRoot, yes, dryRun, v1Snapshot }) {
  const existing = await readExistingAutopilotConfig(projectRoot, v1Snapshot);
  const defaultLimit = existing.sessionStoryLimit ?? DEFAULT_SESSION_STORY_LIMIT;
  const defaultMode = existing.retrospectiveMode ?? DEFAULT_RETROSPECTIVE_MODE;
  // v2.3.0 — opt-in default false; preserve existing user choice on upgrade.
  const defaultAutoPlan = existing.autoPlanOnStart ?? false;

  if (yes) {
    if (
      existing.sessionStoryLimit != null ||
      existing.retrospectiveMode != null ||
      existing.autoPlanOnStart != null
    ) {
      console.log(
        pc.dim(
          `Preserving autopilot config: session_story_limit=${defaultLimit}, retrospective_mode=${defaultMode}, auto_plan_on_start=${defaultAutoPlan}`,
        ),
      );
    }
    return {
      sessionStoryLimit: defaultLimit,
      retrospectiveMode: defaultMode,
      autoPlanOnStart: defaultAutoPlan,
    };
  }

  if (dryRun) {
    console.log(
      pc.dim(
        `[DRY RUN] Would prompt for autopilot config (current: session_story_limit=${defaultLimit}, retrospective_mode=${defaultMode}, auto_plan_on_start=${defaultAutoPlan})`,
      ),
    );
    return {
      sessionStoryLimit: defaultLimit,
      retrospectiveMode: defaultMode,
      autoPlanOnStart: defaultAutoPlan,
    };
  }

  const limitRaw = await prompts.text({
    message: 'Autopilot: stories to fully implement per session (0 = unlimited)',
    initialValue: String(defaultLimit),
    validate(value) {
      if (value == null || value === '') return undefined;
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n) || String(n) !== String(value).trim() || n < 0) {
        return 'Enter a non-negative integer (0 = unlimited)';
      }
      return undefined;
    },
  });
  const sessionStoryLimit =
    limitRaw == null || String(limitRaw).trim() === ''
      ? defaultLimit
      : Number.parseInt(String(limitRaw).trim(), 10);

  const retrospectiveMode = await prompts.select({
    message: 'Autopilot: retrospective handling at epic completion',
    options: [
      {
        value: 'auto',
        label: 'Auto — autopilot generates retrospective inline and continues (recommended)',
      },
      {
        value: 'stop',
        label: 'Stop — pause autopilot so you can run /bmad-retrospective manually',
      },
      {
        value: 'skip',
        label: 'Skip — do not generate a retrospective (NOT RECOMMENDED)',
      },
    ],
    initialValue: defaultMode,
  });

  // v2.3.0 — single yes/no prompt for the new plan workflow. Default false:
  // `autopilot start` runs in sprint-status order until the user explicitly
  // invokes /sprintpilot-plan-sprint, which is always available regardless.
  // Set this true to auto-trigger the planning skill on greenfield projects.
  const autoPlanOnStart = await prompts.confirm({
    message:
      'Auto-build a sprint plan on first `autopilot start`? (v2.3.0; runs /sprintpilot-plan-sprint to infer dependencies. You can always invoke the skill manually regardless of this setting.)',
    initialValue: defaultAutoPlan,
  });

  return { sessionStoryLimit, retrospectiveMode, autoPlanOnStart };
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
  const latestVersionPromise = fetchLatestVersion().catch(() => null);

  process.stdout.write(pc.cyan(renderBanner(addonVersion)));
  console.log('');

  // 0a. Recovery banner: surface any leftover backups/snapshots from a
  //     prior installer run that may have silently clobbered user configs
  //     before v2.1.2's preservation logic landed. Read-only; nothing is
  //     deleted — the user decides.
  try {
    const leftovers = await scanForLeftoverSnapshots(projectRoot);
    if (leftovers.length > 0) {
      console.log(pc.yellow('NOTE: detected leftover config snapshots from a prior install:'));
      for (const f of leftovers) {
        console.log(pc.yellow(`  - ${path.relative(projectRoot, f)}`));
      }
      console.log(
        pc.yellow('  These may contain config you customized but lost during a prior upgrade.'),
      );
      console.log(pc.yellow('  Review before deleting.'));
      console.log('');
    }
  } catch {
    // Non-fatal — banner is purely informational.
  }

  // 1. Verify BMad Method installed
  const bmadManifest = await verifyBmadInstalled(projectRoot);
  if (!bmadManifest) {
    console.error(pc.red(`ERROR: BMad Method not found at ${projectRoot}`));
    console.error('Install BMad Method first: npx bmad-method install');
    process.exit(1);
  }
  const bmadVersion = extractBmadVersion(bmadManifest) || 'unknown';
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

  // 1b. Sweep orphaned v1-named skill dirs from tool dirs unconditionally.
  //     evictV1Installation only fires when _bmad-addons/ is present, so a
  //     user who upgraded long ago (and removed _bmad-addons/) never gets
  //     stale .claude/skills/bmad-ma-* cleaned up — they linger as live
  //     duplicates of the new sprintpilot-* skills. Idempotent, no-op when
  //     nothing matches.
  const orphanedV1Skills = await evictV1SkillsFromToolDirs(projectRoot, { dryRun });
  if (orphanedV1Skills.length > 0) {
    console.log('');
    console.log(pc.yellow('Orphaned v1 skill directories found:'));
    for (const e of orphanedV1Skills) {
      console.log(`  ${dryRun ? 'Would remove' : 'Removed'} legacy skill: ${e}`);
    }
    console.log('');
  }

  // 2. Resolve output_folder
  const outputFolder = await readOutputFolder(projectRoot);
  if (outputFolder !== '_bmad-output') {
    console.log(pc.dim(`Using output_folder: ${outputFolder}`));
    console.log('');
  }

  // 2a. Complexity profile (Adaptive Process Scaling — v2.0.0).
  // Selected before the autopilot scalar prompts because a non-default
  // profile may influence those defaults in a future PR. For PR 1 the
  // profile is written to config.yaml alongside the existing keys; it
  // doesn't yet drive behavior — see docs/implementation-plan.md PR 4+.
  const complexityProfile = await resolveComplexityProfile({
    projectRoot,
    yes,
    dryRun,
    options,
    v1Snapshot: v1ConfigSnapshot,
  });

  // 2b. Autopilot configuration (prompt or preserve existing values).
  // These values are patched into modules/autopilot/config.yaml AFTER the
  // runtime copy — they're NOT threaded through `renderString`, because
  // workflow.md's `{{session_story_limit}}` / `{{retrospective_mode}}`
  // variable references would collide with single-brace token matching.
  const { sessionStoryLimit, retrospectiveMode, autoPlanOnStart } = await resolveAutopilotSettings({
    projectRoot,
    yes,
    dryRun,
    v1Snapshot: v1ConfigSnapshot,
  });
  const ctx = buildContext({ outputFolder });

  // 3. Detect + select tools
  const detected = await detectInstalledTools(projectRoot);

  const parsedTools = parseToolsArg(options.tools);
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
  const ignore = await resolveIgnoreFile(projectRoot);
  const lockResult = await addIgnoreEntry(ignore.path, '.autopilot.lock', { dryRun });
  if (lockResult.added) {
    const name = path.basename(ignore.path);
    if (dryRun) {
      console.log(
        pc.dim(
          `[DRY RUN] Would ${lockResult.created ? 'create' : 'add'} '.autopilot.lock' in ${name}`,
        ),
      );
    } else if (lockResult.created) {
      console.log(`Created ${name} with '.autopilot.lock'`);
    } else {
      console.log(`Added '.autopilot.lock' to ${name}`);
    }
  }

  // v2.3.3 — Sprintpilot bundles js-yaml into _Sprintpilot/node_modules/
  // at install time (see step 6b below). Guard against users committing it.
  const nodeModulesResult = await addIgnoreEntry(ignore.path, '_Sprintpilot/node_modules/', {
    dryRun,
  });
  if (nodeModulesResult.added && !dryRun) {
    console.log(`Added '_Sprintpilot/node_modules/' to ${path.basename(ignore.path)}`);
  }

  // v2.6.0 — runtime artifacts under _bmad-output/implementation-artifacts/.
  // Per-session, machine-generated, no merge story across branches.
  // Specs (story files, sprint-plan, sprint-status, decision-log, retros,
  // reviews) STAY tracked — those are team-shared. See docs/CONFIGURATION.md
  // § "Git tracking policy for `_bmad-output/`" for the full rationale.
  //
  // - ledger.jsonl: append-only autopilot audit log. Sequence numbers are
  //   local-monotonic; tracking it causes tail -F monitors to replay on
  //   every checkout/merge that rewrites the file inode.
  // - autopilot-state.yaml: carries current_story, phase_started_at,
  //   lock_session_id — per-machine runtime, meaningless on another machine.
  // - .timings/, .land-snapshots/, .autopilot-state/, .background-suite/:
  //   high-churn shards and scratch dirs.
  // - .worktrees/: per-story worktrees created by `git worktree add`.
  //
  // .autopilot.lock is already handled by step 4 above.
  const RUNTIME_ARTIFACT_ENTRIES = [
    '_bmad-output/implementation-artifacts/ledger.jsonl',
    '_bmad-output/implementation-artifacts/autopilot-state.yaml',
    '_bmad-output/implementation-artifacts/.autopilot-state/',
    '_bmad-output/implementation-artifacts/.timings/',
    '_bmad-output/implementation-artifacts/.land-snapshots/',
    '_bmad-output/implementation-artifacts/.background-suite/',
    '.worktrees/',
  ];
  for (const entry of RUNTIME_ARTIFACT_ENTRIES) {
    const r = await addIgnoreEntry(ignore.path, entry, { dryRun });
    if (r.added) {
      const name = path.basename(ignore.path);
      if (dryRun) {
        console.log(pc.dim(`[DRY RUN] Would add '${entry}' to ${name}`));
      } else {
        console.log(`Added '${entry}' to ${name}`);
      }
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
    // Backup dir was renamed in v2.2.6: `.addon-backups/` → `.sprintpilot-backups/`.
    // Migrate the legacy name on upgrade so users don't end up with both
    // an old (stale) and new (active) backup dir side-by-side. Migration
    // is a single fs.rename — preserves all existing backups.
    const legacyBackupDir = path.join(projectRoot, toolDir, '.addon-backups');
    const backupDir = path.join(projectRoot, toolDir, '.sprintpilot-backups');
    if (!dryRun && (await fs.pathExists(legacyBackupDir)) && !(await fs.pathExists(backupDir))) {
      await fs.rename(legacyBackupDir, backupDir);
      console.log(`Migrated ${toolDir}/.addon-backups/ → ${toolDir}/.sprintpilot-backups/`);
    }

    const backupIgnoreEntry = `${toolDir}/.sprintpilot-backups/`;
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

    // gemini-cli only: evict Sprintpilot-namespace skills lingering at the
    // legacy .gemini/skills/ location from pre-rename installs. Runs BEFORE
    // we create the new skills dir so the migration line lands above the
    // fresh-install output. Backups go to .agents/.sprintpilot-backups/.
    if (tool === 'gemini-cli') {
      const legacyEvicted = await evictLegacyGeminiSprintpilotSkills(projectRoot, backupDir, ts, {
        dryRun,
      });
      for (const name of legacyEvicted) {
        console.log(
          `  ${dryRun ? 'Would migrate' : 'Migrated'} legacy ${LEGACY_GEMINI_SKILLS_DIR}/skills/${name} → ${toolDir}/.sprintpilot-backups/`,
        );
      }
    }

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
              try {
                await fs.rename(oldTarget, target);
              } catch {
                /* best effort */
              }
            }
            throw e;
          }
          if (targetExistsNow) {
            await fs.remove(oldTarget);
          }
        } catch (e) {
          try {
            await fs.remove(stagingTarget);
          } catch {
            /* best effort */
          }
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

    // v2.3.2 — sweep Sprintpilot-namespace skills that fell out of the
    // manifest between releases. Backed up to .sprintpilot-backups/ before
    // removal. Skipped on dry-run except for reporting what would happen.
    const orphans = await pruneOrphanSkillsFromToolDir(skillsDir, allSkills, backupDir, ts, {
      dryRun,
    });
    for (const name of orphans) {
      console.log(`  ${dryRun ? 'Would remove' : 'Removed'} orphan skill: ${name}`);
    }

    await installSystemPrompt(tool, projectRoot, ADDON_DIR, ctx, { dryRun });
    console.log('');
  }

  // 6. Copy runtime resources into project's _Sprintpilot/
  const targetAddonDir = path.join(projectRoot, '_Sprintpilot');
  if (dryRun) {
    console.log(pc.dim(`[DRY RUN] Would copy runtime resources to ${targetAddonDir}`));
  } else {
    // 6-pre. Snapshot user-owned files BEFORE the destructive copy. On a
    //        fresh install the snapshot is empty; on upgrade it captures
    //        config.yaml edits, template customizations, and the secrets
    //        allowlist so they can be re-applied after step 6.
    const userOwnedSnapshot = await snapshotUserOwnedFiles(targetAddonDir);

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

    // 6b. v2.3.3 — bundle js-yaml into _Sprintpilot/node_modules/.
    //     Two runtime scripts (sprint-plan.js, infer-dependencies.js)
    //     require('js-yaml') for full YAML parse/dump support that the
    //     in-tree yaml-lite intentionally doesn't cover. Without this,
    //     `/sprintpilot-plan-sprint` and dependency inference crash with
    //     MODULE_NOT_FOUND on every invocation in the consumer project.
    //
    //     We resolve js-yaml from Sprintpilot's own node_modules (where
    //     npm placed it when the user ran `npx @ikunin/sprintpilot`) and
    //     copy the whole package into <projectRoot>/_Sprintpilot/node_modules/js-yaml/.
    //     Node's require walk finds it from _Sprintpilot/scripts/ at runtime.
    try {
      const jsYamlPkgJson = require.resolve('js-yaml/package.json');
      const jsYamlSrc = path.dirname(jsYamlPkgJson);
      const jsYamlDest = path.join(targetAddonDir, 'node_modules', 'js-yaml');
      await fs.remove(jsYamlDest);
      await fs.copy(jsYamlSrc, jsYamlDest, { overwrite: true });
      console.log('  Bundled js-yaml → _Sprintpilot/node_modules/js-yaml/');
    } catch (err) {
      console.warn(
        pc.yellow(
          `  WARN: failed to bundle js-yaml (${err.message || err}). sprint-plan and dependency inference will fail at runtime.`,
        ),
      );
    }

    // 6a. Re-apply v1 module-config snapshot (if any) — MUST happen after
    //     step 6 because step 6 wrote pristine bundled configs that would
    //     otherwise clobber the user's values. On failure, persist the
    //     snapshot to disk so the user can recover manually.
    if (Object.keys(v1ConfigSnapshot).length > 0) {
      try {
        const reapplied = await applyV1ModuleConfigs(projectRoot, v1ConfigSnapshot);
        for (const r of reapplied) console.log(`  Preserved v1 ${r}`);
      } catch (err) {
        console.error(
          pc.red('ERROR: failed to re-apply legacy module snapshot after Sprintpilot install.'),
        );
        console.error(pc.red(`  ${err.message || err}`));
        try {
          const recoveryFile = await persistSnapshotForRecovery(projectRoot, v1ConfigSnapshot);
          console.error(
            pc.yellow(
              `  Snapshot persisted to ${path.relative(projectRoot, recoveryFile)} — restore manually.`,
            ),
          );
        } catch (persistErr) {
          console.error(
            pc.red(
              `  Additionally failed to persist snapshot: ${persistErr.message || persistErr}`,
            ),
          );
        }
        throw err;
      }
    }
    // Gitignore entries for *.bak-sprintpilot-migration and
    // .sprintpilot-v1-snapshot*.json were added up-front in
    // evictV1Installation (step 0) so they're in place even if the
    // module-snapshot branch never runs.

    // 6b. Apply the resolved autopilot settings. Runs AFTER step 6 (which
    //     wrote the bundled default config) AND after the v1 snapshot
    //     reapply (which might have restored an older config.yaml without
    //     `retrospective_mode`). The user's prompted values always win.
    await patchAutopilotConfig(projectRoot, {
      sessionStoryLimit,
      retrospectiveMode,
      autoPlanOnStart,
    });

    // 6c. Persist the complexity_profile. Separate from patchAutopilotConfig
    //     so the existing upgrade test coverage (readExistingAutopilotConfig /
    //     patchAutopilotConfig) is unaffected by the new key.
    await patchComplexityProfile(projectRoot, complexityProfile);

    // 6d. Re-apply the user-owned snapshot taken before step 6. YAML configs
    //     get a line-aware merge (user scalars patched into the freshly
    //     copied bundled file, comments preserved, new bundled keys land).
    //     Templates fall back to skip-if-exists with a .bundled sidecar.
    //     Runs AFTER 6a (v1 reapply) and AFTER 6b / 6c so prompt-resolved
    //     autopilot values are not overwritten by a stale snapshot.
    if (userOwnedSnapshot.length > 0) {
      const merged = await applyUserOwnedFiles(targetAddonDir, userOwnedSnapshot, KEY_RENAMES);
      let anySidecar = false;
      for (const r of merged) {
        const detail =
          r.strategy === 'yaml' && r.preserved.length > 0
            ? ` (preserved ${r.preserved.length} setting${r.preserved.length === 1 ? '' : 's'})`
            : r.strategy === 'template' && r.preserved.length > 0
              ? ' (kept user version)'
              : '';
        console.log(`  Preserved ${r.path}${detail}`);
        if (r.note) console.log(pc.dim(`    note: ${r.note}`));
        if (r.orphans && r.orphans.length > 0) {
          console.log(pc.dim(`    orphan keys appended to file footer: ${r.orphans.join(', ')}`));
        }
        if (r.sidecar) anySidecar = true;
      }
      if (anySidecar) {
        console.log('');
        console.log(
          pc.yellow(
            '  Some bundled defaults were written next to user files as .bundled sidecars.',
          ),
        );
        console.log(pc.yellow('  Diff them by hand to pick up new options.'));
      }
    }
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
  console.log(
    `Total skills installed: ${totalInstalled} (${skillCount} skills x ${selectedTools.length} tools)`,
  );

  // v2.3.0 — post-install hygiene: warn if any skill in manifest.yaml
  // doesn't have a SKILL.md on disk. Non-blocking; surfaces packaging
  // bugs without failing the install.
  try {
    const verify = await verifySkillManifest(projectRoot);
    if (verify.missing.length > 0) {
      console.log('');
      console.log(
        pc.yellow(
          `  WARN: manifest references skills missing from disk: ${verify.missing.join(', ')}`,
        ),
      );
      console.log(
        pc.yellow(
          "  These won't appear under your host tool's / menu until the SKILL.md files are present.",
        ),
      );
    }
  } catch {
    // Self-check failure is non-fatal — never block install on hygiene.
  }

  // v2.3.0 upgrade notes — surfaced only when the relevant signals are
  // actually present. Greenfield installs see nothing; upgraders from
  // v2.2.x see migration + deprecation notices.
  const v23Notes = [];
  const legacyDepsPath = path.join(projectRoot, '_Sprintpilot', 'sprints', 'dependencies.yaml');
  if (await fs.pathExists(legacyDepsPath)) {
    v23Notes.push(
      'Legacy file detected: _Sprintpilot/sprints/dependencies.yaml',
      '  Auto-migrated to sprint-plan.yaml on the first `autopilot start`.',
      '  Run now: node _Sprintpilot/scripts/infer-dependencies.js migrate',
    );
  }
  // Re-read so we can show the deprecation notice without threading state
  // through every helper. Cheap (one regex scan); only happens once per install.
  try {
    const existingForNotes = await readExistingAutopilotConfig(projectRoot, v1ConfigSnapshot);
    if (existingForNotes.autoInferDependencies === true) {
      if (v23Notes.length > 0) v23Notes.push('');
      v23Notes.push(
        'Deprecated: autopilot.auto_infer_dependencies = true in your config.',
        '  This flag is a no-op in v2.3.0 — superseded by auto_plan_on_start (default false).',
        '  Safe to remove from config.yaml; the new /sprintpilot-plan-sprint workflow',
        '  handles inference manually or on opt-in auto-trigger.',
      );
    }
  } catch {
    // Config re-read failure is non-fatal — skip the deprecation notice.
  }
  if (v23Notes.length > 0) {
    console.log('');
    console.log(pc.cyan('v2.3.0 upgrade notes:'));
    for (const line of v23Notes) console.log('  ' + line);
  }
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
  console.log('First steps for a new sprint:');
  console.log('  1. BMad sprint planning:        /bmad-sprint-planning');
  console.log('  2. (optional) Sprint plan:      /sprintpilot-plan-sprint');
  console.log('  3. (optional) Inspect DAG:      /sprintpilot-dependency-graph mermaid');
  console.log('  4. Start autopilot:             /sprint-autopilot-on');
  console.log('  5. Check live progress:         /sprintpilot-sprint-progress');
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
  // padEnd so the description column stays aligned across both rows,
  // independent of the chosen values' widths (e.g. 2-digit limit, 4-char mode).
  const apKey = (k) => k.padEnd(31, ' ');
  const apVal = (v) => String(v).padEnd(6, ' ');
  console.log(
    `    ${apKey('autopilot.complexity_profile')}${apVal(complexityProfile)} Profile: nano | small | medium | large | legacy (rollback)`,
  );
  console.log(
    `    ${apKey('autopilot.session_story_limit')}${apVal(sessionStoryLimit)} Stories to fully implement per run (0 = unlimited)`,
  );
  console.log(
    `    ${apKey('autopilot.retrospective_mode')}${apVal(retrospectiveMode)} Epic-end retrospective: auto (inline) | stop (pause) | skip (not recommended)`,
  );
  console.log(
    `    ${apKey('autopilot.auto_plan_on_start')}${apVal(String(autoPlanOnStart))} Auto-build sprint plan on first start (v2.3.0; default off)`,
  );
  console.log('');
  console.log('Sprint planning + progress (v2.3.0):');
  console.log('  /sprintpilot-plan-sprint       Build dependency-aware sprint plan');
  console.log('  /sprintpilot-sprint-progress   Concise health-check of autopilot execution');
  console.log(
    '  /sprintpilot-dependency-graph  Render DAG (mermaid / graphviz / text / layers / json)',
  );
  console.log('');
  console.log('CLI utilities:');
  console.log('  autopilot progress             Live status (--json / --story <key>)');
  console.log('  autopilot start --no-auto-plan Skip auto-planning for one session');
  console.log('');
  console.log('Multi-agent skills — run parallel subagents for faster analysis:');
  console.log('  /sprintpilot-codebase-map      5-stream brownfield codebase analysis');
  console.log('  /sprintpilot-assess            Tech debt and dependency audit');
  console.log('  /sprintpilot-reverse-architect Extract architecture from existing code');
  console.log('  /sprintpilot-migrate           Legacy migration planning');
  console.log('  /sprintpilot-research          Parallel web research');
  console.log('');
  console.log('Documentation:');
  console.log('  Sprint planning walkthrough:   docs/USAGE.md');
  console.log('  Configuration reference:       docs/CONFIGURATION.md');
  console.log('  Architecture deep-dive:        docs/ARCHITECTURE.md');

  const latestVersion = await latestVersionPromise;
  if (latestVersion && addonVersion && compareVersions(addonVersion, latestVersion) === 'behind') {
    const msg = [
      pc.yellow(`┌─────────────────────────────────────────────────────────┐`),
      pc.yellow(`│  Update available: ${addonVersion} → ${latestVersion}`),
      pc.yellow(`│  Run: npx @ikunin/sprintpilot@latest`),
      pc.yellow(`└─────────────────────────────────────────────────────────┘`),
      '',
    ].join('\n');
    console.log(msg);
  }
  console.log('Apache 2.0 License — Igor Kunin — https://github.com/ikunin/sprintpilot');
}

module.exports = {
  runInstall,
  // Exported for unit tests only — do not depend on this surface elsewhere.
  _internals: {
    readExistingAutopilotConfig,
    patchAutopilotConfig,
    applyScalar,
    readExistingComplexityProfile,
    patchComplexityProfile,
    resolveComplexityProfile,
    RETROSPECTIVE_MODES,
    DEFAULT_SESSION_STORY_LIMIT,
    DEFAULT_RETROSPECTIVE_MODE,
    COMPLEXITY_PROFILES,
    DEFAULT_COMPLEXITY_PROFILE,
    RUNTIME_RESOURCES,
    USER_OWNED_FILES,
    KEY_RENAMES,
    snapshotUserOwnedFiles,
    applyUserOwnedFiles,
    verifySkillManifest,
    pruneOrphanSkillsFromToolDir,
    SPRINTPILOT_SKILL_PREFIXES,
    detectInstalledTools,
    evictLegacyGeminiSprintpilotSkills,
    hasLegacyGeminiSprintpilotSkills,
    LEGACY_GEMINI_SKILLS_DIR,
  },
};
