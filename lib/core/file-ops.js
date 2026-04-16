'use strict';

const path = require('node:path');
const fs = require('fs-extra');
const { isTextFile, renderString } = require('../substitute');

async function walkFiles(dir) {
  const out = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out;
}

async function copyDirWithSubstitution(src, dest, ctx, { dryRun = false } = {}) {
  if (dryRun) return;

  await fs.ensureDir(dest);
  const files = await walkFiles(src);

  for (const file of files) {
    const rel = path.relative(src, file);
    const target = path.join(dest, rel);
    await fs.ensureDir(path.dirname(target));

    if (ctx && isTextFile(file)) {
      const raw = await fs.readFile(file, 'utf8');
      const rendered = renderString(raw, ctx);
      await fs.writeFile(target, rendered, 'utf8');
      try {
        const mode = (await fs.stat(file)).mode;
        await fs.chmod(target, mode);
      } catch {
        // chmod best-effort
      }
    } else {
      await fs.copy(file, target, { overwrite: true, dereference: false, preserveTimestamps: false });
    }
  }
}

async function copyFileWithSubstitution(src, dest, ctx) {
  await fs.ensureDir(path.dirname(dest));
  if (ctx && isTextFile(src)) {
    const raw = await fs.readFile(src, 'utf8');
    const rendered = renderString(raw, ctx);
    await fs.writeFile(dest, rendered, 'utf8');
  } else {
    await fs.copy(src, dest, { overwrite: true });
  }
}

async function backupSkill(target, backupDir, timestamp) {
  const name = path.basename(target);
  const backup = path.join(backupDir, `${name}.${timestamp}`);
  await fs.ensureDir(backupDir);
  await fs.copy(target, backup);
  return backup;
}

async function pruneBackups(backupDir, skillName, max = 3) {
  if (!(await fs.pathExists(backupDir))) return;
  const prefix = `${skillName}.`;
  const entries = await fs.readdir(backupDir);
  const matches = entries
    .filter((e) => e.startsWith(prefix))
    .sort();
  if (matches.length <= max) return;
  const toRemove = matches.slice(0, matches.length - max);
  for (const name of toRemove) {
    await fs.remove(path.join(backupDir, name));
  }
}

module.exports = {
  walkFiles,
  copyDirWithSubstitution,
  copyFileWithSubstitution,
  backupSkill,
  pruneBackups,
};
