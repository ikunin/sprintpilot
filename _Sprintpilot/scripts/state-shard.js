#!/usr/bin/env node

// state-shard.js — per-story read/write primitive for state + decision-log.
//
// Usage:
//   state-shard.js write  --story <key> [--kind state|decision-log]
//                         (--field <path>=<value> | --json <json>)
//   state-shard.js read   --story <key> [--kind state|decision-log]
//                         [--format yaml|json]
//   state-shard.js append --story <key> [--kind state|decision-log]
//                         --path <list-path> --entry <json>
//   state-shard.js init   --story <key> [--kind state|decision-log]
//
// Shard layout:
//   <project-root>/_bmad-output/implementation-artifacts/
//     .autopilot-state/<story>.yaml   (kind=state, default)
//     .decision-log/<story>.yaml      (kind=decision-log)
//
// File format:
//   Flat dotted-keys + JSON flow-form for arrays and objects-of-arrays.
//   Still valid YAML ("a.b: 1" is a single-key mapping), but trivial to
//   round-trip without a full YAML parser. This keeps the installer
//   dep-free — user projects don't need js-yaml to run the script.
//
// Atomic writes: tmp sibling + rename(). POSIX rename is atomic inside a
// filesystem; readers never see a partial file.

const fs = require('node:fs');
const path = require('node:path');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');

const STORY_RE = /^[a-z0-9][a-z0-9-]*$/;
const VALID_KINDS = ['state', 'decision-log'];
const VALID_ACTIONS = ['write', 'read', 'append', 'init', 'batch', 'flush'];
const SCHEMA_VERSION = 1;

// PR 6: critical-state keys that bypass buffering. Writing one of these
// via `batch` flushes the pending buffer first and then the write itself
// goes straight to the shard. Rationale: current_story / current_bmad_step
// / in_worktree / patch_commits are required for crash-resume correctness,
// so they cannot sit in an unflushed buffer when the process is killed.
const CRITICAL_KEYS = new Set([
  'current_story',
  'current_bmad_step',
  'in_worktree',
  'patch_commits',
]);

const KIND_DIR = {
  state: '.autopilot-state',
  'decision-log': '.decision-log',
};

const PENDING_DIR = '.pending';

function help() {
  log.out(
    [
      'Usage:',
      '  state-shard.js write  --story <key> [--kind state|decision-log]',
      '                        (--field <dotted.path>=<value> | --json <json>)',
      '  state-shard.js read   --story <key> [--kind state|decision-log]',
      '                        [--format yaml|json]',
      '  state-shard.js append --story <key> [--kind state|decision-log]',
      '                        --path <list-path> --entry <json>',
      '  state-shard.js init   --story <key> [--kind state|decision-log]',
      '',
      'Single-writer per story-key. No locks. Atomic via rename().',
    ].join('\n'),
  );
}

function validateStory(s) {
  if (!s || !STORY_RE.test(s)) {
    return { ok: false, error: `invalid --story '${s}': must match ${STORY_RE}` };
  }
  return { ok: true, value: s };
}

function validateKind(k) {
  const kind = k || 'state';
  if (!VALID_KINDS.includes(kind)) {
    return { ok: false, error: `invalid --kind '${k}': must be ${VALID_KINDS.join('|')}` };
  }
  return { ok: true, value: kind };
}

// Read BMad's `output_folder` config so a project that customized its
// output location doesn't end up with shards split between
// `_bmad-output/` (writer hardcoded) and `<output_folder>/` (reader
// honoring config). Pre-2.0.8 this script ignored output_folder
// entirely, contradicting sibling scripts (mark-done-stories-tasks.js)
// that did read it.
function readOutputFolder(projectRoot) {
  const cfg = path.join(projectRoot, '_bmad', 'bmm', 'config.yaml');
  if (!fs.existsSync(cfg)) return null;
  try {
    const body = fs.readFileSync(cfg, 'utf8');
    const m = body.match(/^output_folder\s*:\s*(\S+)/m);
    if (!m) return null;
    return m[1].replace(/^["']|["']$/g, '').trim();
  } catch {
    return null;
  }
}

function implArtifactsDir(projectRoot) {
  const folder = readOutputFolder(projectRoot) || '_bmad-output';
  return path.join(projectRoot, folder, 'implementation-artifacts');
}

function shardDir(projectRoot, kind) {
  return path.join(implArtifactsDir(projectRoot), KIND_DIR[kind]);
}

function shardPath(projectRoot, story, kind) {
  const dir = shardDir(projectRoot, kind);
  const full = path.join(dir, `${story}.yaml`);
  // Defense-in-depth: refuse any resolved path that escapes the shard dir.
  const expectedPrefix = path.resolve(dir) + path.sep;
  const resolved = path.resolve(full);
  if (!resolved.startsWith(expectedPrefix)) {
    throw new Error(`shard path escapes expected directory: ${resolved}`);
  }
  return full;
}

function nowStamp() {
  return {
    wall: new Date().toISOString(),
    monotonic: process.hrtime.bigint().toString(),
  };
}

// --------------------------------------------------------------------------
// Flat-YAML writer: each leaf is a single line "dotted.key: value".
// Arrays / nested arrays use JSON flow-form on the value side.
// --------------------------------------------------------------------------

function yamlScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'bigint') return String(v);
  const s = String(v);
  const needsQuote =
    s === '' ||
    /^(true|false|null|~|yes|no|on|off)$/i.test(s) ||
    /[:#\n\r]/.test(s) ||
    /^[\s-]/.test(s) ||
    /^-?\d/.test(s);
  return needsQuote ? JSON.stringify(s) : s;
}

function yamlDump(obj) {
  const lines = [];
  const emit = (value, prefix) => {
    if (value === null || value === undefined) {
      lines.push(`${prefix}: null`);
      return;
    }
    if (Array.isArray(value)) {
      // JSON flow-form — compact and exact round-trip.
      lines.push(`${prefix}: ${JSON.stringify(value)}`);
      return;
    }
    if (typeof value === 'object') {
      const keys = Object.keys(value);
      if (keys.length === 0) {
        lines.push(`${prefix}: {}`);
        return;
      }
      for (const k of keys) emit(value[k], prefix === '' ? k : `${prefix}.${k}`);
      return;
    }
    lines.push(`${prefix}: ${yamlScalar(value)}`);
  };
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const k of Object.keys(obj)) emit(obj[k], k);
  }
  return lines.join('\n');
}

function yamlLoad(text) {
  const root = {};
  for (const rawLine of text.split(/\r?\n/)) {
    // Strip trailing comments only when preceded by whitespace so "#" inside
    // a JSON-quoted value isn't eaten.
    const line = stripTrailingComment(rawLine);
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = firstTopLevelColon(trimmed);
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const raw = trimmed.slice(colon + 1).trim();
    const value = parseValue(raw);
    setByDottedPath(root, key, value);
  }
  return root;
}

function stripTrailingComment(line) {
  let inQuote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === inQuote) inQuote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inQuote = c;
      continue;
    }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function firstTopLevelColon(s) {
  let inQuote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === inQuote) inQuote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inQuote = c;
      continue;
    }
    if (c === ':') return i;
  }
  return -1;
}

function parseValue(raw) {
  if (raw === '' || raw === 'null' || raw === '~') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === '[]') return [];
  if (raw === '{}') return {};
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    try {
      return raw.startsWith('"') ? JSON.parse(raw) : raw.slice(1, -1);
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
  return raw;
}

function setByDottedPath(obj, key, value) {
  const parts = key.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!cur[p] || typeof cur[p] !== 'object' || Array.isArray(cur[p])) {
      cur[p] = {};
    }
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

function getByDottedPath(obj, key) {
  const parts = key.split('.');
  let cur = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

// --------------------------------------------------------------------------
// Shard I/O
// --------------------------------------------------------------------------

function readShard(projectRoot, story, kind) {
  const file = shardPath(projectRoot, story, kind);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return yamlLoad(raw);
  } catch (e) {
    throw new Error(`failed to parse shard ${file}: ${e.message}`);
  }
}

function writeShardAtomic(projectRoot, story, kind, obj) {
  const file = shardPath(projectRoot, story, kind);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const normalized = {
    story,
    schema_version: SCHEMA_VERSION,
    updated_at: nowStamp(),
    ...stripReservedKeys(obj),
  };
  const body = `${yamlDump(normalized)}\n`;
  // Unique tmp name per (pid, monotonic ns) so concurrent writers to
  // different stories never collide on the tmp file. Same-story writers
  // are single-writer by contract.
  const tmp = `${file}.tmp.${process.pid}.${process.hrtime.bigint().toString(36)}`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
  return file;
}

function stripReservedKeys(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const { story: _s, schema_version: _sv, updated_at: _u, ...rest } = obj;
  return rest;
}

function appendToListAtPath(obj, dottedPath, entry) {
  const parts = dottedPath.split('.').filter(Boolean);
  if (parts.length === 0) throw new Error('--path required for append');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!cur[p] || typeof cur[p] !== 'object' || Array.isArray(cur[p])) {
      cur[p] = {};
    }
    cur = cur[p];
  }
  const last = parts[parts.length - 1];
  if (!Array.isArray(cur[last])) cur[last] = [];
  cur[last].push(entry);
  return obj;
}

function parseFieldValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return parseValue(raw);
  }
}

function listShardStories(projectRoot, kind) {
  const dir = shardDir(projectRoot, kind);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') && !f.startsWith('.tmp'))
    .map((f) => f.slice(0, -'.yaml'.length));
}

// --------------------------------------------------------------------------
// Pending buffer (PR 6 — coalesce state writes)
// --------------------------------------------------------------------------

function pendingDir(projectRoot, kind) {
  return path.join(implArtifactsDir(projectRoot), PENDING_DIR, KIND_DIR[kind]);
}

function pendingPath(projectRoot, story, kind) {
  const dir = pendingDir(projectRoot, kind);
  const full = path.join(dir, `${story}.yaml`);
  const expectedPrefix = path.resolve(dir) + path.sep;
  const resolved = path.resolve(full);
  if (!resolved.startsWith(expectedPrefix)) {
    throw new Error(`pending path escapes expected directory: ${resolved}`);
  }
  return full;
}

function readPending(projectRoot, story, kind) {
  const file = pendingPath(projectRoot, story, kind);
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return yamlLoad(raw) || {};
  } catch {
    // Corrupt pending — drop it; the caller's write will overwrite atomically.
    return {};
  }
}

function writePendingAtomic(projectRoot, story, kind, obj) {
  const file = pendingPath(projectRoot, story, kind);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = `${yamlDump(obj)}\n`;
  const tmp = `${file}.tmp.${process.pid}.${process.hrtime.bigint().toString(36)}`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
  return file;
}

function clearPending(projectRoot, story, kind) {
  const file = pendingPath(projectRoot, story, kind);
  try {
    fs.unlinkSync(file);
  } catch {
    // Not present — nothing to clear.
  }
}

function batchWrite(projectRoot, story, kind, partial) {
  const pending = readPending(projectRoot, story, kind);
  const merged = deepAssign(pending, partial);
  writePendingAtomic(projectRoot, story, kind, merged);
  return merged;
}

function flushPending(projectRoot, story, kind) {
  const pending = readPending(projectRoot, story, kind);
  if (!pending || Object.keys(pending).length === 0) {
    clearPending(projectRoot, story, kind);
    return { flushed: false, fields: 0 };
  }
  const existing = readShard(projectRoot, story, kind) || {};
  const merged = deepAssign(stripReservedKeys(existing), pending);
  writeShardAtomic(projectRoot, story, kind, merged);
  clearPending(projectRoot, story, kind);
  return { flushed: true, fields: Object.keys(pending).length };
}

function containsCriticalKey(partial) {
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) return false;
  for (const k of Object.keys(partial)) {
    if (CRITICAL_KEYS.has(k)) return true;
  }
  return false;
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));
  if (opts.help || positional.length === 0) {
    help();
    process.exit(opts.help ? 0 : 1);
  }
  const action = positional[0];
  if (!VALID_ACTIONS.includes(action)) {
    log.error(`unknown action '${action}'. Valid: ${VALID_ACTIONS.join(', ')}`);
    process.exit(1);
  }
  const story = validateStory(opts.story);
  if (!story.ok) {
    log.error(story.error);
    process.exit(1);
  }
  const kind = validateKind(opts.kind);
  if (!kind.ok) {
    log.error(kind.error);
    process.exit(1);
  }
  const projectRoot = opts['project-root'] || process.cwd();
  const format = opts.format || 'yaml';

  const existing = (() => {
    try {
      return readShard(projectRoot, story.value, kind.value) || {};
    } catch (e) {
      log.error(e.message);
      process.exit(1);
    }
  })();

  if (action === 'read') {
    const shard = readShard(projectRoot, story.value, kind.value);
    if (!shard) process.exit(2);
    if (format === 'json') process.stdout.write(`${JSON.stringify(shard)}\n`);
    else process.stdout.write(`${yamlDump(shard)}\n`);
    return;
  }
  if (action === 'init') {
    writeShardAtomic(projectRoot, story.value, kind.value, {});
    return;
  }
  if (action === 'write' || action === 'batch') {
    const partial = {};
    if (opts.json !== undefined) {
      let parsed;
      try {
        parsed = JSON.parse(opts.json);
      } catch (e) {
        log.error(`--json is not valid JSON: ${e.message}`);
        process.exit(1);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        log.error('--json must be a JSON object');
        process.exit(1);
      }
      Object.assign(partial, parsed);
    }
    if (opts.field !== undefined) {
      const eq = opts.field.indexOf('=');
      if (eq === -1) {
        log.error(`--field must be <path>=<value>, got '${opts.field}'`);
        process.exit(1);
      }
      const p = opts.field.slice(0, eq);
      const v = opts.field.slice(eq + 1);
      setByDottedPath(partial, p, parseFieldValue(v));
    }

    if (action === 'batch') {
      // Critical keys bypass the buffer — flush pending, re-read the now-
      // flushed shard, then write straight through so crash-recovery always
      // sees both the prior buffered fields and the new critical fields.
      if (containsCriticalKey(partial)) {
        flushPending(projectRoot, story.value, kind.value);
        const fresh = readShard(projectRoot, story.value, kind.value) || {};
        const next = deepAssign(stripReservedKeys(fresh), partial);
        writeShardAtomic(projectRoot, story.value, kind.value, next);
        return;
      }
      batchWrite(projectRoot, story.value, kind.value, partial);
      return;
    }
    // action === 'write' — direct write to shard (also flushes any pending
    // to keep flush-before-write invariant).
    flushPending(projectRoot, story.value, kind.value);
    const fresh = readShard(projectRoot, story.value, kind.value) || existing;
    const next = deepAssign({ ...fresh }, partial);
    writeShardAtomic(projectRoot, story.value, kind.value, next);
    return;
  }
  if (action === 'flush') {
    const res = flushPending(projectRoot, story.value, kind.value);
    process.stdout.write(`${JSON.stringify(res)}\n`);
    return;
  }
  if (action === 'append') {
    if (!opts.path) {
      log.error('--path is required for append');
      process.exit(1);
    }
    if (!opts.entry) {
      log.error('--entry is required for append');
      process.exit(1);
    }
    let entry;
    try {
      entry = JSON.parse(opts.entry);
    } catch (e) {
      log.error(`--entry is not valid JSON: ${e.message}`);
      process.exit(1);
    }
    const next = appendToListAtPath({ ...existing }, opts.path, entry);
    writeShardAtomic(projectRoot, story.value, kind.value, next);
  }
}

function deepAssign(target, source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return source;
  const out = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const k of Object.keys(source)) {
    const sv = source[k];
    const tv = out[k];
    if (
      sv &&
      typeof sv === 'object' &&
      !Array.isArray(sv) &&
      tv &&
      typeof tv === 'object' &&
      !Array.isArray(tv)
    ) {
      out[k] = deepAssign(tv, sv);
    } else {
      out[k] = sv;
    }
  }
  return out;
}

module.exports = {
  STORY_RE,
  VALID_KINDS,
  VALID_ACTIONS,
  SCHEMA_VERSION,
  KIND_DIR,
  PENDING_DIR,
  CRITICAL_KEYS,
  validateStory,
  validateKind,
  shardDir,
  shardPath,
  pendingDir,
  pendingPath,
  nowStamp,
  yamlDump,
  yamlLoad,
  parseValue,
  setByDottedPath,
  getByDottedPath,
  readShard,
  writeShardAtomic,
  appendToListAtPath,
  parseFieldValue,
  listShardStories,
  stripReservedKeys,
  deepAssign,
  stripTrailingComment,
  firstTopLevelColon,
  readPending,
  writePendingAtomic,
  clearPending,
  batchWrite,
  flushPending,
  containsCriticalKey,
};

if (require.main === module) {
  main();
}
