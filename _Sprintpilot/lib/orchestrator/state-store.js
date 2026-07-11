// state-store.js — single chokepoint for autopilot state writes.
//
// Honors `coalesce_state_writes` from the active profile:
//
//   coalesce_state_writes: false  (legacy v1.0.5 path)
//     → every write goes straight to autopilot-state.yaml
//
//   coalesce_state_writes: true   (M3 / PR 6 path)
//     → CRITICAL_KEYS write straight through (crash-recovery semantics)
//     → non-critical fields accumulate in a pending buffer per story
//     → buffer is flushed at story boundary + session checkpoint
//
// CRITICAL_KEYS mirror state-shard.js so the two implementations stay
// semantically aligned. Tests cover both code paths.
//
// All I/O goes through an injected `fs` so tests use tmp dirs and the
// orchestrator can wire in alternative stores later.

'use strict';

const nodeFs = require('node:fs');
const path = require('node:path');

// Mirrors _Sprintpilot/scripts/state-shard.js#CRITICAL_KEYS.
const CRITICAL_KEYS = new Set([
  'current_story',
  'current_bmad_step',
  'in_worktree',
  'patch_commits',
  // Explicit story queue populated by `autopilot start --stories <csv>`
  // / `--epic <id>`. composeRuntimeState reads queue[0] as the next
  // story_key; adapt.advanceState pops the head when a story completes.
  // When empty, the orchestrator falls back to resolveNextStoryKey.
  'story_queue',
  // v2.3.0 — verify-loop trackers. These must write through immediately
  // so a crash between verify rejections doesn't reset the
  // consecutive-identical counter. Without write-through, the
  // budget-exhaustion halt would emit the generic prompt instead of
  // the loop-hint enriched prompt, defeating the loop-detection UX.
  'last_verify_issues_signature',
  'consecutive_identical_rejections',
  // Fast-lane escalation ledger (story keys bounced from the quick-dev
  // fast lane back to the full 7-step cycle). Must write through so a
  // crash between the escalation and the story boundary doesn't let the
  // pre-story gate re-fast-lane a story that already failed the fast path.
  // Array value → replaced wholesale by deepMerge (never partially merged).
  'fast_lane_forced_full',
]);

// In-memory pending buffer. Process-scoped — flushed at story boundary or
// session checkpoint. Keyed by story.
const _pendingBuffers = new Map();

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Prototype-pollution guard. State keys are machine-generated field names;
// __proto__ / constructor / prototype can only appear from a malformed or
// crafted state file, so we drop them rather than let them reach the
// prototype chain. Mirrors state-shard.js#UNSAFE_KEYS.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepMerge(target, source) {
  if (!isPlainObject(source)) return source;
  const out = isPlainObject(target) ? { ...target } : {};
  for (const key of Object.keys(source)) {
    if (UNSAFE_KEYS.has(key)) continue; // prototype-pollution guard
    const sv = source[key];
    const tv = out[key];
    if (isPlainObject(sv) && isPlainObject(tv)) out[key] = deepMerge(tv, sv);
    else out[key] = sv;
  }
  return out;
}

function dumpYaml(obj, indent = 0) {
  const pad = '  '.repeat(indent);
  const lines = [];
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val === null || val === undefined) lines.push(`${pad}${key}: null`);
    else if (Array.isArray(val)) lines.push(`${pad}${key}: ${JSON.stringify(val)}`);
    else if (isPlainObject(val)) {
      lines.push(`${pad}${key}:`);
      const inner = dumpYaml(val, indent + 1);
      if (inner) lines.push(inner);
    } else if (typeof val === 'boolean' || typeof val === 'number') {
      lines.push(`${pad}${key}: ${val}`);
    } else {
      const s = String(val);
      const needsQuote = /^(true|false|null|~)$/i.test(s) || /^-?\d/.test(s) || /[:#]/.test(s);
      lines.push(`${pad}${key}: ${needsQuote ? JSON.stringify(s) : s}`);
    }
  }
  return lines.join('\n');
}

// Atomic write via tmp sibling + rename.
function atomicWrite(fs, filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, filePath);
}

function readStateFile(fs, filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return parseYamlNarrow(text);
  } catch (_e) {
    return {};
  }
}

// Narrow YAML parser sufficient for our write shape (the same shape we
// produce via dumpYaml above). We deliberately avoid js-yaml so we don't
// pull a runtime dep into the install-time script bundle.
//
// Supports:
//   key: scalar               (inline scalar)
//   key: [a, b]               (inline JSON array via parseScalar)
//   key:                      (nested object — children at deeper indent)
//     subkey: value
//   key:                      (nested array — `- item` lines at deeper indent)
//     - item-scalar
//     - item-key: item-value
//
// dumpYaml emits inline JSON for arrays; the block-form path handles
// hand edits and tools that emit `- item` lines.
function parseYamlNarrow(text) {
  if (!text) return {};
  const lines = text.split(/\r?\n/);
  const root = {};
  // Stack frame:
  //   indent       — indent of the KEY that opened this container (its
  //                  children live at indent > frame.indent)
  //   container    — the object or array we're populating
  //   isArray      — true once we've promoted container from {} to []
  //   parentObj    — owner of container (used to swap {} → [] when the
  //                  first child is a `- ` line)
  //   parentKey    — slot on parentObj that holds container
  const stack = [{ indent: -1, container: root, isArray: false, parentObj: null, parentKey: null }];
  for (const raw of lines) {
    const hashIdx = raw.indexOf('#');
    const line = hashIdx === -1 ? raw : raw.slice(0, hashIdx);
    if (!line.trim()) continue;
    const indent = line.match(/^( *)/)[1].length;
    const content = line.slice(indent).trimEnd();
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const top = stack[stack.length - 1];

    // List item shape: `- ` or bare `-`.
    if (content === '-' || content.startsWith('- ')) {
      // Promote container to array if this is the first list item seen
      // for the current key. Root-level lists aren't supported (state
      // files always have an object root) — skip cleanly.
      if (!top.isArray) {
        if (!top.parentObj || top.parentKey == null) continue;
        const arr = [];
        top.parentObj[top.parentKey] = arr;
        top.container = arr;
        top.isArray = true;
      }
      const rest = content === '-' ? '' : content.slice(2).trim();
      if (rest === '') {
        // Bare `-` with children below — append a fresh object and let
        // subsequent deeper-indent lines populate it.
        const child = {};
        top.container.push(child);
        stack.push({ indent, container: child, isArray: false, parentObj: null, parentKey: null });
        continue;
      }
      const colon = rest.indexOf(':');
      if (colon === -1) {
        // Plain scalar list item.
        top.container.push(parseScalar(rest));
        continue;
      }
      // `- key: value` or `- key:` (object item).
      const k = rest.slice(0, colon).trim();
      const v = rest.slice(colon + 1).trim();
      if (v === '') {
        const child = {};
        const wrapper = { [k]: child };
        top.container.push(wrapper);
        stack.push({ indent, container: child, isArray: false, parentObj: wrapper, parentKey: k });
      } else {
        top.container.push({ [k]: parseScalar(v) });
      }
      continue;
    }

    // Object key: value
    const colon = content.indexOf(':');
    if (colon === -1) continue;
    const key = content.slice(0, colon).trim();
    const rest = content.slice(colon + 1).trim();
    if (top.isArray) {
      // Defensive: a stray `key:` inside an array context is malformed.
      // Skip rather than corrupt the array.
      continue;
    }
    // Prototype-pollution guard: a crafted `__proto__:` / `constructor:` line
    // would otherwise write into the prototype chain via top.container[key].
    if (UNSAFE_KEYS.has(key)) continue;
    if (rest === '') {
      const child = {};
      top.container[key] = child;
      stack.push({ indent, container: child, isArray: false, parentObj: top.container, parentKey: key });
      continue;
    }
    top.container[key] = parseScalar(rest);
  }
  return root;
}

function parseScalar(raw) {
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    try {
      return JSON.parse(raw);
    } catch (_e) {
      return raw.slice(1, -1);
    }
  }
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      return JSON.parse(raw);
    } catch (_e) {
      return raw;
    }
  }
  if (raw === 'null' || raw === '~') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
  return raw;
}

function resolveStatePath(projectRoot) {
  return path.join(
    projectRoot,
    '_bmad-output',
    'implementation-artifacts',
    'autopilot-state.yaml',
  );
}

function bufferKey(story) {
  return story || 'sprint';
}

// write(updates, profile, context)
//   updates: object of key→value updates (deep-merged into the file)
//   profile: typed Profile (only `coalesce_state_writes` is consulted here)
//   context: { projectRoot, story, fs? }
// Returns { mode: 'direct' | 'critical' | 'pending', flushed: boolean }
function write(updates, profile, context) {
  if (!isPlainObject(updates)) throw new Error('write: updates must be an object');
  if (!profile) throw new Error('write: profile required');
  if (!context || !context.projectRoot) throw new Error('write: context.projectRoot required');
  const fs = (context && context.fs) || nodeFs;
  const story = context.story;

  // Legacy path: direct write.
  if (!profile.coalesce_state_writes) {
    return writeDirect(fs, context.projectRoot, updates);
  }

  // Coalesce path. Split critical vs non-critical.
  const critical = {};
  const nonCritical = {};
  let hasCritical = false;
  let hasNonCritical = false;
  for (const k of Object.keys(updates)) {
    if (CRITICAL_KEYS.has(k)) {
      critical[k] = updates[k];
      hasCritical = true;
    } else {
      nonCritical[k] = updates[k];
      hasNonCritical = true;
    }
  }

  // If we have critical writes, flush pending first then write critical + accumulated.
  if (hasCritical) {
    const key = bufferKey(story);
    const buf = _pendingBuffers.get(key) || {};
    const merged = { ...buf, ...nonCritical, ...critical };
    _pendingBuffers.delete(key);
    writeDirect(fs, context.projectRoot, merged);
    return { mode: 'critical', flushed: true };
  }

  // Non-critical only → buffer.
  if (hasNonCritical) {
    const key = bufferKey(story);
    const buf = _pendingBuffers.get(key) || {};
    _pendingBuffers.set(key, deepMerge(buf, nonCritical));
    return { mode: 'pending', flushed: false };
  }
  return { mode: 'noop', flushed: false };
}

// writeDirect — write to autopilot-state.yaml directly, merging on top.
function writeDirect(fs, projectRoot, updates) {
  const filePath = resolveStatePath(projectRoot);
  const existing = readStateFile(fs, filePath);
  const merged = deepMerge(existing, updates);
  merged.last_updated = new Date().toISOString();
  atomicWrite(fs, filePath, `${dumpYaml(merged)}\n`);
  return { mode: 'direct', flushed: true };
}

// flush(profile, context) — flush pending buffer for the given story.
// Called at story boundary and session checkpoint.
function flush(profile, context) {
  if (!profile || !profile.coalesce_state_writes) return { flushed: false, mode: 'noop' };
  if (!context || !context.projectRoot) throw new Error('flush: context.projectRoot required');
  const fs = (context && context.fs) || nodeFs;
  const key = bufferKey(context.story);
  const buf = _pendingBuffers.get(key);
  if (!buf || Object.keys(buf).length === 0) return { flushed: false, mode: 'noop' };
  _pendingBuffers.delete(key);
  writeDirect(fs, context.projectRoot, buf);
  return { flushed: true, mode: 'flush' };
}

// read(context) — read full state object from disk.
function read(context) {
  if (!context || !context.projectRoot) throw new Error('read: context.projectRoot required');
  const fs = (context && context.fs) || nodeFs;
  return readStateFile(fs, resolveStatePath(context.projectRoot));
}

// peekPending(story) — for tests + debugging.
function peekPending(story) {
  const buf = _pendingBuffers.get(bufferKey(story));
  return buf ? { ...buf } : null;
}

// resetPending() — clear all buffers; tests only.
function resetPending() {
  _pendingBuffers.clear();
}

module.exports = {
  CRITICAL_KEYS: Array.from(CRITICAL_KEYS),
  write,
  flush,
  read,
  peekPending,
  resetPending,
  resolveStatePath,
};
