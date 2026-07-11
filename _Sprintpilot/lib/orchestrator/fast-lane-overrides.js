// fast-lane-overrides.js — Sprintpilot-owned, durable per-story / per-epic
// fast|full overrides for the quick-dev fast lane.
//
// A user can explicitly mark a story (or a whole epic) `fast` or `full`, in
// chat ("fast-lane 4-1", "mark 4-2 full") via the `set_fast_lane` UserCommand,
// or from the CLI (`autopilot fast-lane <key> <fast|full|auto>`), or during
// `/sprintpilot-plan-sprint`. Those marks are the HIGHEST-authority routing
// signal — a `fast` mark wins over the gate's deny-globs / size budget / tags
// (the human is trusted), a `full` mark forces the full cycle. The only thing
// that still overrides a `fast` mark is `fast_lane_forced_full` (a story the
// automatic escalation net bounced after it actually failed the fast path —
// that wins to prevent a fast→fail→fast loop).
//
// Stored as its OWN JSON file — NOT sprint-plan.yaml, NOT autopilot-state.yaml
// — so it is clobber-resistant: a `/sprintpilot-plan-sprint` re-derivation
// regenerates the plan but never touches these marks (same rationale as
// excluded-stories.js). Replace-on-write semantics; a mark cleared to `auto`
// is deleted (deep-merge can't delete a nested key, which is why this isn't in
// autopilot-state.yaml).
//
// File: _bmad-output/implementation-artifacts/fast-lane-overrides.json
//   { "fast_lane_overrides": {
//       "stories": { "<story-key>": { "decision": "fast"|"full", "recorded_at": ... } },
//       "epics":   { "<epic-id>":   { "decision": "fast"|"full", "recorded_at": ... } } } }
//
// All I/O goes through an injected `fs` so tests use tmp dirs.

'use strict';

const nodeFs = require('node:fs');
const path = require('node:path');

const VALID_DECISIONS = new Set(['fast', 'full']);

function overridesPath(projectRoot) {
  return path.join(
    projectRoot,
    '_bmad-output',
    'implementation-artifacts',
    'fast-lane-overrides.json',
  );
}

// Epic keys are normalized to a bare id (`epic-5` / `Epic-5` / `5` → `5`) so a
// mark set as `epic-5` resolves against an epic derived as `5` and vice-versa.
function normalizeEpicKey(key) {
  return typeof key === 'string' ? key.trim().replace(/^epic-/i, '') : '';
}

// Read the raw { stories, epics } maps. Tolerant: missing / unreadable /
// malformed file → empty maps (a mangled artifact must never wedge routing).
function readMap(projectRoot, fsImpl = nodeFs) {
  const empty = { stories: {}, epics: {} };
  if (!projectRoot) return empty;
  try {
    const raw = fsImpl.readFileSync(overridesPath(projectRoot), 'utf8');
    const obj = JSON.parse(raw);
    const root = obj && typeof obj === 'object' ? obj.fast_lane_overrides : null;
    if (!root || typeof root !== 'object' || Array.isArray(root)) return empty;
    const stories =
      root.stories && typeof root.stories === 'object' && !Array.isArray(root.stories)
        ? root.stories
        : {};
    const epics =
      root.epics && typeof root.epics === 'object' && !Array.isArray(root.epics)
        ? root.epics
        : {};
    return { stories, epics };
  } catch (_e) {
    return empty;
  }
}

function decisionOf(entry) {
  const d = entry && typeof entry === 'object' ? entry.decision : entry;
  return VALID_DECISIONS.has(d) ? d : null;
}

// resolve(projectRoot, storyKey, epicKey) → 'fast' | 'full' | null.
// A story-level mark wins over its epic-level mark; null when neither is set.
function resolve(projectRoot, storyKey, epicKey, fsImpl = nodeFs) {
  const { stories, epics } = readMap(projectRoot, fsImpl);
  if (typeof storyKey === 'string' && storyKey) {
    const s = decisionOf(stories[storyKey]);
    if (s) return s;
  }
  const ek = normalizeEpicKey(epicKey);
  if (ek) {
    const e = decisionOf(epics[ek]);
    if (e) return e;
  }
  return null;
}

function writeMap(projectRoot, map, fsImpl = nodeFs) {
  const filePath = overridesPath(projectRoot);
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = {
    fast_lane_overrides: { stories: map.stories || {}, epics: map.epics || {} },
  };
  const text = `${JSON.stringify(body, null, 2)}\n`;
  // Atomic write via tmp sibling + rename (mirrors state-store.js).
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fsImpl.writeFileSync(tmp, text, 'utf8');
  fsImpl.renameSync(tmp, filePath);
}

// setOverride(projectRoot, key, decision, { isEpic }) — mark a story or epic
// `fast` or `full`. Idempotent on the decision; preserves recorded_at only when
// the decision is unchanged. Returns { ok, bucket, key } or { ok:false }.
function setOverride(projectRoot, key, decision, opts = {}, fsImpl = nodeFs) {
  if (typeof key !== 'string' || !key || !VALID_DECISIONS.has(decision)) {
    return { ok: false, reason: 'invalid_args' };
  }
  const map = readMap(projectRoot, fsImpl);
  const bucket = opts.isEpic ? 'epics' : 'stories';
  const storeKey = opts.isEpic ? normalizeEpicKey(key) : key;
  if (!storeKey) return { ok: false, reason: 'invalid_args' };
  const existing = map[bucket][storeKey];
  map[bucket][storeKey] = {
    decision,
    recorded_at:
      existing && existing.decision === decision && existing.recorded_at
        ? existing.recorded_at
        : new Date().toISOString(),
  };
  writeMap(projectRoot, map, fsImpl);
  return { ok: true, bucket, key: storeKey, decision };
}

// clearOverride(projectRoot, key, { isEpic }) — revert a story/epic to `auto`
// (gate-decided). Returns true iff an entry was removed.
function clearOverride(projectRoot, key, opts = {}, fsImpl = nodeFs) {
  if (typeof key !== 'string' || !key) return false;
  const map = readMap(projectRoot, fsImpl);
  const bucket = opts.isEpic ? 'epics' : 'stories';
  const storeKey = opts.isEpic ? normalizeEpicKey(key) : key;
  if (!Object.prototype.hasOwnProperty.call(map[bucket], storeKey)) return false;
  delete map[bucket][storeKey];
  writeMap(projectRoot, map, fsImpl);
  return true;
}

module.exports = {
  overridesPath,
  normalizeEpicKey,
  readMap,
  resolve,
  setOverride,
  clearOverride,
  VALID_DECISIONS,
};
