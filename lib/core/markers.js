'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('fs-extra');

const BEGIN = '<!-- BEGIN:bmad-workflow-rules -->';
const END = '<!-- END:bmad-workflow-rules -->';

function escRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Match BEGIN / END only at the start of a line (optionally preceded by
// whitespace) so plain-text mentions of the marker string inside code
// blocks or documentation don't get mistaken for real delimiters.
const BEGIN_RE = new RegExp(`^[ \\t]*${escRegex(BEGIN)}[ \\t]*$`, 'm');
const END_RE_GLOBAL = new RegExp(`^[ \\t]*${escRegex(END)}[ \\t]*$`, 'gm');

// Find a BEGIN..END span where both markers sit on their own line. Uses the
// FIRST line-anchored BEGIN and the LAST line-anchored END so nested/
// duplicate markers from a prior buggy install collapse to a single block,
// while plain-text mentions of the marker inside code blocks no longer
// corrupt the document.
function findBlock(text) {
  const beginMatch = text.match(BEGIN_RE);
  if (!beginMatch) return null;
  const start = beginMatch.index;

  let end = -1;
  // lastIndex of matchAll iterator — just iterate.
  for (const m of text.matchAll(END_RE_GLOBAL)) {
    if (m.index >= start) end = m.index + m[0].length;
  }
  if (end < 0) return null;
  return { start, end };
}

function stripBlock(text) {
  const block = findBlock(text);
  if (!block) return text;
  const before = text.slice(0, block.start).replace(/\s+$/, '');
  const after = text.slice(block.end).replace(/^\s+/, '');
  if (before && after) return `${before}\n\n${after}\n`;
  if (before) return `${before}\n`;
  return after ? after : '';
}

function upsertBlock(existingText, block) {
  const baseline = stripBlock(existingText || '').replace(/\s+$/, '');
  const trimmedBlock = block.replace(/^\s+|\s+$/g, '');
  if (!baseline) return `${trimmedBlock}\n`;
  return `${baseline}\n\n${trimmedBlock}\n`;
}

function hasBlock(text) {
  return findBlock(text) !== null;
}

async function writeAtomic(filePath, content) {
  await fs.ensureDir(path.dirname(filePath));
  const suffix = crypto.randomBytes(4).toString('hex');
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${suffix}.tmp`;
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.move(tmp, filePath, { overwrite: true });
  } catch (e) {
    try { await fs.remove(tmp); } catch { /* best effort */ }
    throw e;
  }
}

module.exports = {
  BEGIN,
  END,
  findBlock,
  stripBlock,
  upsertBlock,
  hasBlock,
  writeAtomic,
};
