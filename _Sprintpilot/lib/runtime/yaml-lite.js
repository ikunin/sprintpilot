'use strict';

// Narrow YAML helper covering the addon-owned shape:
//   key: value
//   stories:
//     <story-key>:
//       field: value
//       field2: value
// No deep nesting, no anchors, no flow sequences beyond [a,b,c] literal we pass through.

const SPECIAL_CHARS = /[:{}\[\],&*#?|<>=!%@`\n]|^-|^\s|\s$/;

// YAML 1.1 reserved literals that parsers interpret as booleans/null when
// unquoted (e.g. "no" -> false). Must be quoted to round-trip as strings.
const RESERVED_LITERAL = /^(true|false|yes|no|null|on|off|~|y|n)$/i;

function yamlSafe(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s === '') return '""';
  // Quote strings that look like reserved literals only when the input is
  // explicitly a string — numeric input should pass through as-is.
  const needsReservedQuote = typeof value === 'string' && RESERVED_LITERAL.test(s);
  if (SPECIAL_CHARS.test(s) || needsReservedQuote) {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return s;
}

function buildStoryBlock(storyKey, fields) {
  const lines = [`  ${storyKey}:`];
  for (const [k, v] of fields) {
    if (v === undefined || v === null) continue;
    // Raw pass-through for values already formatted (e.g. [a,b,c]).
    if (k.__raw__) {
      lines.push(`    ${k.name}: ${v}`);
    } else {
      lines.push(`    ${k}: ${yamlSafe(v)}`);
    }
  }
  return lines.join('\n');
}

function pushRawField(arr, name, formatted) {
  arr.push([{ __raw__: true, name }, formatted]);
}

function hasStoryBlock(existing, storyKey) {
  return new RegExp(`^  ${escapeRegex(storyKey)}:\\s*$`, 'm').test(existing);
}

// Leading whitespace length of a line (counts spaces; tabs count as 1 — the
// addon-owned shape is strictly 2-space-indented but tolerating tabs prevents
// orphaned fields when a user hand-edits the file).
function indentOf(line) {
  const m = line.match(/^[ \t]*/);
  return m ? m[0].length : 0;
}

// Replace a single story block in-place, preserving siblings and emitting
// exactly one blank line separator after the new block (idempotent across
// repeated upserts — prevents unbounded blank-line growth).
function replaceStoryBlock(existing, storyKey, newBlock) {
  const lines = existing.split('\n');
  // Story headers live at 2-space indent in the addon shape. Any line with
  // MORE indent is a continuation of the block; any line with equal-or-less
  // non-blank indent is a sibling/parent and must be preserved.
  const headerRe = new RegExp(`^(\\s*)${escapeRegex(storyKey)}:\\s*$`);
  const out = [];
  let i = 0;
  let replaced = false;

  while (i < lines.length) {
    const headerMatch = !replaced ? lines[i].match(headerRe) : null;
    if (headerMatch) {
      const headerIndent = headerMatch[1].length;
      out.push(newBlock);
      replaced = true;
      i++;
      // Consume all continuation lines — any line more-indented than the
      // header is part of this block. Blank lines inside the block count
      // as continuations and are also consumed.
      while (i < lines.length) {
        if (lines[i].length === 0) { i++; continue; }
        if (indentOf(lines[i]) > headerIndent) { i++; continue; }
        break;
      }
      // Strip any trailing blanks we may have consumed past the block.
      // Emit exactly one blank separator if more content follows.
      if (i < lines.length) out.push('');
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return out.join('\n');
}

function appendStoryBlock(existing, block) {
  const trimmed = existing.replace(/\s+$/, '');
  return `${trimmed}\n${block}\n`;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Strip surrounding double-quotes from a YAML scalar ONLY when the value is
// fully paired-quoted (both ends). Unescape \" inside paired quotes so the
// return value matches what `yamlSafe` originally received.
function unquoteScalar(s) {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\"/g, '"');
  }
  return t;
}

// Reader for the narrow addon-owned YAML shape. Returns the value of
// `field` under a top-level-indented (2-space) story key `storyKey`.
// Exits the story block when encountering any line whose indent is <= the
// header's indent (2 spaces) AND that line is not blank.
function readStoryField(text, storyKey, field) {
  const lines = text.split(/\r?\n/);
  const headerRe = new RegExp(`^(\\s*)${escapeRegex(storyKey)}:\\s*$`);
  const fieldRe = new RegExp(`^\\s+${escapeRegex(field)}:\\s*(.*)$`);
  let headerIndent = -1;

  for (const line of lines) {
    if (headerIndent < 0) {
      const m = line.match(headerRe);
      if (m) headerIndent = m[1].length;
      continue;
    }

    // Blank line inside a block is allowed; skip.
    if (line.length === 0) continue;

    const leading = line.match(/^(\s*)/);
    const indent = leading ? leading[1].length : 0;

    // Left the story block when we return to header indent or shallower
    // (on a non-blank line). No match found.
    if (indent <= headerIndent) return null;

    const m = line.match(fieldRe);
    if (m) return unquoteScalar(m[1]);
  }
  return null;
}

module.exports = {
  yamlSafe,
  buildStoryBlock,
  pushRawField,
  hasStoryBlock,
  replaceStoryBlock,
  appendStoryBlock,
  readStoryField,
};
