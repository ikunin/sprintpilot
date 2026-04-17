const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('fs-extra');

const BEGIN = '<!-- BEGIN:sprintpilot-rules -->';
const END = '<!-- END:sprintpilot-rules -->';

// Legacy markers from bmad-autopilot-addon v1. We never write these, but
// uninstall / v1 eviction must recognize and strip them.
const LEGACY_BEGIN = '<!-- BEGIN:bmad-workflow-rules -->';
const LEGACY_END = '<!-- END:bmad-workflow-rules -->';

function escRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Match BEGIN / END only at the start of a line (optionally preceded by
// whitespace) so plain-text mentions of the marker string inside code
// blocks or documentation don't get mistaken for real delimiters.
const BEGIN_RE = new RegExp(`^[ \\t]*${escRegex(BEGIN)}[ \\t]*$`, 'm');
const END_RE_GLOBAL = new RegExp(`^[ \\t]*${escRegex(END)}[ \\t]*$`, 'gm');
const LEGACY_BEGIN_RE = new RegExp(`^[ \\t]*${escRegex(LEGACY_BEGIN)}[ \\t]*$`, 'm');
const LEGACY_END_RE_GLOBAL = new RegExp(`^[ \\t]*${escRegex(LEGACY_END)}[ \\t]*$`, 'gm');

// Find a BEGIN..END span where both markers sit on their own line. Uses the
// FIRST line-anchored BEGIN and the FIRST line-anchored END after it.
//
// Earlier revisions used the LAST END to aggressively collapse nested /
// duplicate marker pairs from buggy prior installs. That was unsafe: if a
// document contained two independent, well-formed blocks with unrelated
// user content between them, a single strip would delete everything from
// the first BEGIN through the last END — including the user content.
// First-END is safe: it strips exactly one block. Duplicate cleanup is
// still handled because stripBlock iterates until no blocks remain.
function findSpan(text, beginRe, endReGlobal) {
  const beginMatch = text.match(beginRe);
  if (!beginMatch) return null;
  const start = beginMatch.index;

  for (const m of text.matchAll(endReGlobal)) {
    if (m.index >= start) return { start, end: m.index + m[0].length };
  }
  return null;
}

function findBlock(text) {
  return findSpan(text, BEGIN_RE, END_RE_GLOBAL);
}

function findLegacyBlock(text) {
  return findSpan(text, LEGACY_BEGIN_RE, LEGACY_END_RE_GLOBAL);
}

function stripSpan(text, block) {
  const before = text.slice(0, block.start).replace(/\s+$/, '');
  const after = text.slice(block.end).replace(/^\s+/, '');
  if (before && after) return `${before}\n\n${after}\n`;
  if (before) return `${before}\n`;
  return after ? after : '';
}

// Strip ALL matching blocks — not just the first — so duplicate/nested
// blocks from buggy prior installs collapse cleanly. Iterating with
// first-END semantics preserves any unrelated content between blocks.
function stripBlock(text) {
  let result = text;
  while (true) {
    const block = findBlock(result);
    if (!block) return result;
    result = stripSpan(result, block);
  }
}

function stripLegacyBlock(text) {
  let result = text;
  while (true) {
    const block = findLegacyBlock(result);
    if (!block) return result;
    result = stripSpan(result, block);
  }
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

function hasLegacyBlock(text) {
  return findLegacyBlock(text) !== null;
}

async function writeAtomic(filePath, content) {
  await fs.ensureDir(path.dirname(filePath));
  const suffix = crypto.randomBytes(4).toString('hex');
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${suffix}.tmp`;
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.move(tmp, filePath, { overwrite: true });
  } catch (e) {
    try {
      await fs.remove(tmp);
    } catch {
      /* best effort */
    }
    throw e;
  }
}

module.exports = {
  BEGIN,
  END,
  LEGACY_BEGIN,
  LEGACY_END,
  findBlock,
  findLegacyBlock,
  stripBlock,
  stripLegacyBlock,
  upsertBlock,
  hasBlock,
  hasLegacyBlock,
  writeAtomic,
};
