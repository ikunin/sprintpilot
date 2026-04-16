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
  BEGIN, END, stripBlock, upsertBlock, writeAtomic, hasBlock,
} = require('../core/markers');
const { renderString, buildContext, isTextFile } = require('../substitute');
const { fetchLatestVersion, compareVersions } = require('../core/update-check');
const prompts = require('../prompts');

const execFileAsync = promisify(execFile);

const BANNER = String.raw`
 ____  __  __    _    ____       _         _              _ _       _
| __ )|  \/  |  / \  |  _ \     / \  _   _| |_ ___  _ __ (_) | ___ | |_
|  _ \| |\/| | / _ \ | | | |   / _ \| | | | __/ _ \| '_ \| | |/ _ \| __|
| |_) | |  | |/ ___ \| |_| |  / ___ \ |_| | || (_) | |_) | | | (_) | |_
|____/|_|  |_/_/   \_\____/  /_/   \_\__,_|\__\___/| .__/|_|_|\___/ \__|
                                                   |_|
`;

const ADDON_DIR = path.resolve(__dirname, '..', '..', '_bmad-addons');
const RUNTIME_RESOURCES = ['BMAD.md', 'manifest.yaml', '.secrets-allowlist', 'lib', 'modules', 'scripts', 'templates'];

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

  const addonVersion = await readAddonManifestVersion(path.join(ADDON_DIR, 'manifest.yaml'));

  // Non-blocking update check
  let latestVersionPromise = fetchLatestVersion().catch(() => null);

  process.stdout.write(pc.cyan(BANNER));
  if (addonVersion) console.log(pc.cyan(`  v${addonVersion}`));
  console.log('');

  // 1. Verify BMAD installed
  const bmadManifest = await verifyBmadInstalled(projectRoot);
  if (!bmadManifest) {
    console.error(pc.red(`ERROR: BMAD not found at ${projectRoot}`));
    console.error('Install BMAD first: npx bmad-method install');
    process.exit(1);
  }
  const bmadVersion = bmadManifest.version || 'unknown';
  console.log(`BMAD version: ${bmadVersion}`);
  console.log('');

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

  // 6. Copy runtime resources into project's _bmad-addons/
  const targetAddonDir = path.join(projectRoot, '_bmad-addons');
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
    console.log('Runtime resources installed to _bmad-addons/');
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

  console.log(pc.green(`=== Add-on v${addonVersion || 'unknown'} installed ===`));
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
  console.log('  /bmad-autopilot-on   Engage autonomous story execution');
  console.log('  /bmad-autopilot-off  Disengage and show status');
  console.log('  /bmad-help           Orientation and next-step guidance');
  console.log('');
  console.log('Configuration (edit these files to customize behavior):');
  console.log('');
  console.log('  _bmad-addons/modules/git/config.yaml');
  console.log('    git.base_branch       main        Branch PRs target');
  console.log('    git.branch_prefix     story/      Story branch naming');
  console.log('    git.lint.enabled      true        Lint changed files');
  console.log('    git.lint.blocking     false       true = lint errors halt autopilot');
  console.log('    git.push.auto         true        Auto-push after commit');
  console.log('    git.push.create_pr    true        Create PR (false = direct merge)');
  console.log('    git.platform.provider auto        auto|github|gitlab|bitbucket|gitea');
  console.log('');
  console.log('  _bmad-addons/modules/ma/config.yaml');
  console.log('    multi_agent.enabled               true   Enable parallel agents');
  console.log('    multi_agent.max_parallel_analysis  5      Codebase analysis agents');
  console.log('');
  console.log('  _bmad-addons/modules/autopilot/config.yaml');
  console.log('    autopilot.session_story_limit    3      Stories to fully implement per run (0 = unlimited)');
  console.log('');
  console.log('Multi-agent (ma) skills — run parallel subagents for faster analysis:');
  console.log('  /bmad-ma-code-review       Parallel 3-layer adversarial review');
  console.log('  /bmad-ma-codebase-map      5-stream brownfield codebase analysis');
  console.log('  /bmad-ma-assess            Tech debt and dependency audit');
  console.log('  /bmad-ma-reverse-architect Extract architecture from existing code');
  console.log('  /bmad-ma-migrate           Legacy migration planning');
  console.log('  /bmad-ma-research          Parallel web research');
  console.log('  /bmad-ma-party-mode        Multi-persona agent discussions');

  const latestVersion = await latestVersionPromise;
  if (latestVersion && addonVersion && compareVersions(addonVersion, latestVersion) === 'behind') {
    const msg = [
      pc.yellow(`┌─────────────────────────────────────────────────────────┐`),
      pc.yellow(`│  Update available: ${addonVersion} → ${latestVersion}`),
      pc.yellow(`│  Run: npx bmad-autopilot-addon@latest`),
      pc.yellow(`└─────────────────────────────────────────────────────────┘`),
      '',
    ].join('\n');
    console.log(msg);
  }
  console.log('Apache 2.0 License — Igor Kunin — https://github.com/ikunin/bmad-autopilot-addon');
}

module.exports = { runInstall };
