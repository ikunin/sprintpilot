'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('fs-extra');
const pc = require('picocolors');

const { ALL_TOOLS, getToolDir, getSystemPromptFile, getSystemPromptMode } = require('../core/tool-registry');
const { stripBlock, hasBlock, writeAtomic } = require('../core/markers');

const execFileAsync = promisify(execFile);
const ADDON_DIR = path.resolve(__dirname, '..', '..', '_bmad-addons');

async function listSkills() {
  const entries = await fs.readdir(path.join(ADDON_DIR, 'skills'), { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function removeSystemPrompt(tool, projectRoot) {
  const mode = getSystemPromptMode(tool);
  const promptFileRel = getSystemPromptFile(tool);

  if (mode === 'claude-code') {
    const agentsFile = path.join(projectRoot, 'AGENTS.md');
    if (await fs.pathExists(agentsFile)) {
      const content = await fs.readFile(agentsFile, 'utf8');
      if (hasBlock(content)) {
        const stripped = stripBlock(content);
        if (!stripped.trim()) {
          await fs.remove(agentsFile);
          console.log(`${tool}: removed AGENTS.md (was BMAD-only)`);
        } else {
          await writeAtomic(agentsFile, stripped);
          console.log(`${tool}: removed BMAD section from AGENTS.md`);
        }
      }
    }

    const claudeFile = path.join(projectRoot, 'CLAUDE.md');
    if (await fs.pathExists(claudeFile)) {
      const content = await fs.readFile(claudeFile, 'utf8');
      if (content.includes('@AGENTS.md')) {
        const newContent = content.split(/\r?\n/).filter((l) => !l.includes('@AGENTS.md')).join('\n');
        if (!newContent.trim()) {
          await fs.remove(claudeFile);
          console.log(`${tool}: removed CLAUDE.md (was BMAD-only)`);
        } else {
          await writeAtomic(claudeFile, newContent.endsWith('\n') ? newContent : `${newContent}\n`);
          console.log(`${tool}: removed @AGENTS.md from CLAUDE.md`);
        }
      }
    }
    return;
  }

  if (!promptFileRel) return;
  const promptFile = path.join(projectRoot, promptFileRel);

  if (mode === 'own-file') {
    if (await fs.pathExists(promptFile)) {
      await fs.remove(promptFile);
      console.log(`${tool}: removed ${promptFileRel}`);
    }
    return;
  }

  if (mode === 'append') {
    if (!(await fs.pathExists(promptFile))) return;
    const content = await fs.readFile(promptFile, 'utf8');
    if (!hasBlock(content)) return;
    const stripped = stripBlock(content);
    if (!stripped.trim()) {
      await fs.remove(promptFile);
      console.log(`${tool}: removed ${promptFileRel} (was BMAD-only)`);
    } else {
      await writeAtomic(promptFile, stripped);
      console.log(`${tool}: removed BMAD section from ${promptFileRel}`);
    }
  }
}

async function cleanupWorktrees(projectRoot, force) {
  const worktreesDir = path.join(projectRoot, '.worktrees');
  if (!(await fs.pathExists(worktreesDir))) return;

  console.log('');
  console.log('Cleaning worktrees...');
  const entries = await fs.readdir(worktreesDir, { withFileTypes: true });
  let skipped = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const wt = path.join(worktreesDir, entry.name);

    let dirty = false;
    try {
      const { stdout } = await execFileAsync('git', ['-C', wt, 'status', '--porcelain']);
      dirty = stdout.trim().length > 0;
    } catch {
      dirty = false;
    }

    if (dirty && !force) {
      console.log(`  SKIPPED: ${entry.name} (has uncommitted changes — use --force to override)`);
      skipped++;
      continue;
    }

    let removed = false;
    try {
      await execFileAsync('git', ['worktree', 'remove', '--force', wt]);
      removed = true;
    } catch {
      // fallback
    }
    if (!removed) {
      await fs.remove(wt);
    }
    console.log(`  Removed: ${entry.name}`);
  }

  try {
    await execFileAsync('git', ['-C', projectRoot, 'worktree', 'prune']);
  } catch {
    // ignore
  }

  if (skipped > 0) {
    console.log('');
    console.log(pc.yellow(`WARNING: ${skipped} worktree(s) skipped due to uncommitted changes.`));
    console.log(pc.yellow('Remove manually after saving your work.'));
  }
}

async function runUninstall(options = {}) {
  const projectRoot = process.env.BMAD_PROJECT_ROOT || process.cwd();
  const force = !!options.force;

  console.log('=== BMAD Autopilot Add-On Uninstaller ===');
  console.log('');

  const skills = await listSkills();
  let totalRemoved = 0;

  for (const tool of ALL_TOOLS) {
    const toolDir = getToolDir(tool);
    const skillsDir = path.join(projectRoot, toolDir, 'skills');
    if (!(await fs.pathExists(skillsDir))) continue;

    let removed = 0;
    for (const skillName of skills) {
      const target = path.join(skillsDir, skillName);
      if (await fs.pathExists(target)) {
        await fs.remove(target);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(`${tool}: removed ${removed} skills from ${toolDir}/skills/`);
      totalRemoved += removed;
    }

    const backupDir = path.join(projectRoot, toolDir, '.addon-backups');
    if (await fs.pathExists(backupDir)) {
      await fs.remove(backupDir);
      console.log(`${tool}: removed backup directory`);
    }

    await removeSystemPrompt(tool, projectRoot);
  }

  if (totalRemoved === 0) {
    console.log('No add-on skills found in any tool directory.');
  }

  await cleanupWorktrees(projectRoot, force);

  const targetAddonDir = path.join(projectRoot, '_bmad-addons');
  if (await fs.pathExists(targetAddonDir)) {
    await fs.remove(targetAddonDir);
    console.log('');
    console.log('Removed _bmad-addons/');
  }

  const lockFile = path.join(projectRoot, '.autopilot.lock');
  if (await fs.pathExists(lockFile)) {
    await fs.remove(lockFile);
    console.log('');
    console.log('Removed .autopilot.lock');
  }

  console.log('');
  console.log(pc.green(`Add-on uninstalled (${totalRemoved} skills removed). BMAD skills are unaffected.`));
}

module.exports = { runUninstall };
