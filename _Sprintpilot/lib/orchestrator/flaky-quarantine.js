// flaky-quarantine.js — bookkeeping for tests that pass on retry — v2.4.0.
//
// File layout: <projectRoot>/_bmad-output/implementation-artifacts/
//              flaky-quarantine.yaml
//
//   schema: sprintpilot.flaky-quarantine.v1
//   last_updated: <iso>
//   flips:
//     - test_id: "<adapter-specific id>"
//       flip_count: <int>
//       first_observed: <iso>
//       last_observed: <iso>
//       seen_in_stories: ["1.1-foo", ...]
//   quarantined:
//     - test_id: ...
//       flip_count_at_quarantine: 3
//       quarantined_at: <iso>
//       reason: "exceeded_flip_threshold" | "manual"
//
// Pure-ish: fs is injected; tests use tmp dirs. Atomic writes via
// tmp+rename to survive interrupted runs without leaving corrupt state.
//
// The orchestrator records a flip whenever a signal carries
// `output.flaky_tests: string[]` (the LLM/adapter detects that a test
// that failed on first run passed on the auto-replay). After N=3 flips
// for a single test, promoteToQuarantineMaybe() moves it into
// `quarantined[]` and the side-effect applier appends an audit entry
// to decisions[]. The quarantine pattern is then threaded into the
// adapter's exclude flags via testing/scope.js so the test stops
// running until a human reviews it.

'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const SCHEMA = 'sprintpilot.flaky-quarantine.v1';
const DEFAULT_FLIP_THRESHOLD = 3;
const RELATIVE_PATH = nodePath.join(
  '_bmad-output',
  'implementation-artifacts',
  'flaky-quarantine.yaml',
);

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function emptyState() {
  return {
    schema: SCHEMA,
    last_updated: null,
    flips: [],
    quarantined: [],
  };
}

function filePath(projectRoot) {
  return nodePath.join(projectRoot, RELATIVE_PATH);
}

// Narrow YAML parser sufficient for this file's shape. We reuse the same
// strategy as state-store.js (block-form objects + arrays, JSON scalars).
function parseYaml(text) {
  if (!text) return emptyState();
  const lines = text.split(/\r?\n/);
  const root = {};
  const stack = [{ indent: -1, container: root, isArray: false, parentObj: null, parentKey: null }];
  for (const raw of lines) {
    const hashIdx = raw.indexOf('#');
    const line = hashIdx === -1 ? raw : raw.slice(0, hashIdx);
    if (!line.trim()) continue;
    const indent = line.match(/^( *)/)[1].length;
    const content = line.slice(indent).trimEnd();
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const top = stack[stack.length - 1];

    if (content === '-' || content.startsWith('- ')) {
      if (!top.isArray) {
        if (!top.parentObj || top.parentKey == null) continue;
        const arr = [];
        top.parentObj[top.parentKey] = arr;
        top.container = arr;
        top.isArray = true;
      }
      const rest = content === '-' ? '' : content.slice(2).trim();
      if (rest === '') {
        const child = {};
        top.container.push(child);
        stack.push({ indent, container: child, isArray: false, parentObj: null, parentKey: null });
        continue;
      }
      const colon = rest.indexOf(':');
      if (colon === -1) {
        top.container.push(parseScalar(rest));
        continue;
      }
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

    const colon = content.indexOf(':');
    if (colon === -1) continue;
    const key = content.slice(0, colon).trim();
    const rest = content.slice(colon + 1).trim();
    if (top.isArray) continue;
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

function dumpYaml(state) {
  const out = [];
  out.push(`schema: ${state.schema || SCHEMA}`);
  out.push(`last_updated: ${state.last_updated ? JSON.stringify(state.last_updated) : 'null'}`);
  // List-item shape uses the bare-dash form so the narrow YAML parser
  // (shared with state-store.js) correctly pushes a stack frame and
  // groups all keys under the same array element. The compact
  // `- key: val` form would silently drop subsequent keys.
  out.push('flips:');
  for (const entry of state.flips || []) {
    out.push('  -');
    out.push(`    test_id: ${JSON.stringify(entry.test_id || '')}`);
    out.push(`    flip_count: ${entry.flip_count || 0}`);
    out.push(`    first_observed: ${entry.first_observed ? JSON.stringify(entry.first_observed) : 'null'}`);
    out.push(`    last_observed: ${entry.last_observed ? JSON.stringify(entry.last_observed) : 'null'}`);
    out.push(`    seen_in_stories: ${JSON.stringify(entry.seen_in_stories || [])}`);
  }
  out.push('quarantined:');
  for (const entry of state.quarantined || []) {
    out.push('  -');
    out.push(`    test_id: ${JSON.stringify(entry.test_id || '')}`);
    out.push(`    flip_count_at_quarantine: ${entry.flip_count_at_quarantine || 0}`);
    out.push(`    quarantined_at: ${entry.quarantined_at ? JSON.stringify(entry.quarantined_at) : 'null'}`);
    out.push(`    reason: ${JSON.stringify(entry.reason || 'exceeded_flip_threshold')}`);
  }
  return out.join('\n') + '\n';
}

// read(projectRoot, fs?) — return the persisted state, or an empty
// shape when the file doesn't exist / is unparseable.
function read(projectRoot, fs) {
  const f = fs || nodeFs;
  try {
    const text = f.readFileSync(filePath(projectRoot), 'utf8');
    const parsed = parseYaml(text);
    return normalize(parsed);
  } catch (_e) {
    return emptyState();
  }
}

function normalize(parsed) {
  const state = emptyState();
  if (!isPlainObject(parsed)) return state;
  if (typeof parsed.schema === 'string') state.schema = parsed.schema;
  if (typeof parsed.last_updated === 'string') state.last_updated = parsed.last_updated;
  if (Array.isArray(parsed.flips)) {
    state.flips = parsed.flips
      .map((f) => normalizeFlip(f))
      .filter((f) => f !== null);
  }
  if (Array.isArray(parsed.quarantined)) {
    state.quarantined = parsed.quarantined
      .map((q) => normalizeQuarantineEntry(q))
      .filter((q) => q !== null);
  }
  return state;
}

function normalizeFlip(raw) {
  if (!isPlainObject(raw) || typeof raw.test_id !== 'string' || !raw.test_id) return null;
  return {
    test_id: raw.test_id,
    flip_count: Number.isFinite(raw.flip_count) ? raw.flip_count : 0,
    first_observed: typeof raw.first_observed === 'string' ? raw.first_observed : null,
    last_observed: typeof raw.last_observed === 'string' ? raw.last_observed : null,
    seen_in_stories: Array.isArray(raw.seen_in_stories)
      ? raw.seen_in_stories.filter((s) => typeof s === 'string')
      : [],
  };
}

function normalizeQuarantineEntry(raw) {
  if (!isPlainObject(raw) || typeof raw.test_id !== 'string' || !raw.test_id) return null;
  return {
    test_id: raw.test_id,
    flip_count_at_quarantine: Number.isFinite(raw.flip_count_at_quarantine)
      ? raw.flip_count_at_quarantine
      : 0,
    quarantined_at: typeof raw.quarantined_at === 'string' ? raw.quarantined_at : null,
    reason: typeof raw.reason === 'string' ? raw.reason : 'exceeded_flip_threshold',
  };
}

// write(projectRoot, state, fs?) — atomic write via tmp+rename.
function write(projectRoot, state, fs) {
  const f = fs || nodeFs;
  const fp = filePath(projectRoot);
  f.mkdirSync(nodePath.dirname(fp), { recursive: true });
  const text = dumpYaml({
    ...state,
    last_updated: new Date().toISOString(),
  });
  const tmp = `${fp}.tmp.${process.pid}.${Date.now()}`;
  f.writeFileSync(tmp, text, 'utf8');
  f.renameSync(tmp, fp);
}

// recordFlip(state, { testId, storyKey, now }) → new state with the
// flip recorded. Increments flip_count and appends storyKey to
// seen_in_stories (dedup). Idempotent on repeat calls within the same
// story when storyKey is already present.
function recordFlip(state, { testId, storyKey, now }) {
  if (!testId) return state;
  const ts = now || new Date().toISOString();
  const flips = (state.flips || []).slice();
  const idx = flips.findIndex((f) => f.test_id === testId);
  if (idx < 0) {
    flips.push({
      test_id: testId,
      flip_count: 1,
      first_observed: ts,
      last_observed: ts,
      seen_in_stories: storyKey ? [storyKey] : [],
    });
  } else {
    const cur = flips[idx];
    const stories = Array.isArray(cur.seen_in_stories) ? cur.seen_in_stories.slice() : [];
    if (storyKey && !stories.includes(storyKey)) stories.push(storyKey);
    flips[idx] = {
      ...cur,
      flip_count: (cur.flip_count || 0) + 1,
      last_observed: ts,
      seen_in_stories: stories,
    };
  }
  return { ...state, flips };
}

// promoteToQuarantineMaybe(state, { testId, threshold, now }) → { state,
// quarantined } where `quarantined` is true when the test crossed the
// threshold on this call. Removes the flip entry once quarantined (the
// historical record lives in quarantined[].flip_count_at_quarantine).
function promoteToQuarantineMaybe(state, { testId, threshold, now }) {
  if (!testId) return { state, quarantined: false };
  const t = typeof threshold === 'number' && threshold > 0 ? threshold : DEFAULT_FLIP_THRESHOLD;
  // Already quarantined? No-op.
  if (isQuarantined(state, testId)) return { state, quarantined: false };
  const flipEntry = (state.flips || []).find((f) => f.test_id === testId);
  if (!flipEntry || (flipEntry.flip_count || 0) < t) return { state, quarantined: false };
  const ts = now || new Date().toISOString();
  const newFlips = (state.flips || []).filter((f) => f.test_id !== testId);
  const newQ = (state.quarantined || []).concat([
    {
      test_id: testId,
      flip_count_at_quarantine: flipEntry.flip_count || 0,
      quarantined_at: ts,
      reason: 'exceeded_flip_threshold',
    },
  ]);
  return {
    state: { ...state, flips: newFlips, quarantined: newQ },
    quarantined: true,
  };
}

function isQuarantined(state, testId) {
  return (state.quarantined || []).some((q) => q.test_id === testId);
}

function listQuarantined(state) {
  return (state.quarantined || []).map((q) => q.test_id);
}

function listFlips(state) {
  return (state.flips || []).map((f) => ({ ...f }));
}

// ejectFromQuarantine(state, { testId }) → new state with the test
// removed from quarantined[]. Manual operation — the user has
// reviewed/fixed the test and wants it back in the active suite.
function ejectFromQuarantine(state, { testId }) {
  if (!testId) return state;
  return {
    ...state,
    quarantined: (state.quarantined || []).filter((q) => q.test_id !== testId),
  };
}

// quarantineManually(state, { testId, now, reason }) — append a manual
// quarantine entry without a flip-count crossing. Useful for the CLI
// `autopilot quarantine add <test_id>` path.
function quarantineManually(state, { testId, now, reason }) {
  if (!testId) return state;
  if (isQuarantined(state, testId)) return state;
  const ts = now || new Date().toISOString();
  return {
    ...state,
    quarantined: (state.quarantined || []).concat([
      {
        test_id: testId,
        flip_count_at_quarantine: 0,
        quarantined_at: ts,
        reason: reason || 'manual',
      },
    ]),
  };
}

module.exports = {
  SCHEMA,
  DEFAULT_FLIP_THRESHOLD,
  RELATIVE_PATH,
  emptyState,
  read,
  write,
  filePath,
  recordFlip,
  promoteToQuarantineMaybe,
  isQuarantined,
  listQuarantined,
  listFlips,
  ejectFromQuarantine,
  quarantineManually,
  // Exposed for tests / inspection.
  parseYaml,
  dumpYaml,
  normalize,
};
