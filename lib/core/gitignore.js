'use strict';

const path = require('node:path');
const fs = require('fs-extra');

async function resolveIgnoreFile(projectRoot) {
  const gitignore = path.join(projectRoot, '.gitignore');
  if (await fs.pathExists(gitignore)) return { path: gitignore, created: false };

  const exclude = path.join(projectRoot, '.git', 'info', 'exclude');
  if (await fs.pathExists(exclude)) {
    try {
      const stat = await fs.stat(exclude);
      if (stat.size > 0) {
        return { path: exclude, created: false, usedExclude: true };
      }
    } catch {
      // fall through
    }
  }

  return { path: gitignore, created: true };
}

async function addIgnoreEntry(ignoreFile, entry, { dryRun = false } = {}) {
  const exists = await fs.pathExists(ignoreFile);
  let content = '';
  if (exists) {
    content = await fs.readFile(ignoreFile, 'utf8');
    const lines = content.split(/\r?\n/);
    if (lines.some((l) => l.trim() === entry.trim())) {
      return { added: false, created: false };
    }
  }

  if (dryRun) {
    return { added: true, created: !exists, dryRun: true };
  }

  if (!exists) {
    await fs.ensureDir(path.dirname(ignoreFile));
    await fs.writeFile(ignoreFile, `${entry}\n`, 'utf8');
    return { added: true, created: true };
  }

  const needsNewline = content.length > 0 && !content.endsWith('\n');
  await fs.appendFile(ignoreFile, `${needsNewline ? '\n' : ''}${entry}\n`, 'utf8');
  return { added: true, created: false };
}

module.exports = {
  resolveIgnoreFile,
  addIgnoreEntry,
};
