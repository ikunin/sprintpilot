// excluded-stories.js — Sprintpilot-owned exclusion ledger.
//
// Stories listed here are NEVER auto-selected by the next-story resolver,
// regardless of what BMad writes to sprint-status.yaml. This makes the
// Sprintpilot resolver authoritative about scope:
//
//   - A BMad re-plan (`bmad-sprint-planning`) re-detects a parked story's
//     file on disk and "upgrades status to at least ready-for-dev", and its
//     "never downgrade" rule only reasons about the canonical ladder
//     (backlog → ready-for-dev → in-progress → review → done) — on which our
//     `deferred`/`skipped` values don't sit. So a re-plan can silently flip a
//     parked story back to ready-for-dev. With this ledger, the resolver still
//     excludes it.
//   - `skip_story` resets runtime but does NOT mark sprint-status (BMad's
//     domain), so without this ledger the resolver re-picks the skipped story.
//     Recording it here makes the skip "stick".
//
// Stored as JSON (not YAML / not folded into autopilot-state.yaml) because:
//   - removals need clean replace semantics; the autopilot-state.yaml writer
//     deep-merges and cannot delete a nested key (un-exclusion would fail).
//   - JSON needs no bespoke parser (the sibling ledger.jsonl is already JSON).
//
// File: _bmad-output/implementation-artifacts/excluded-stories.json
//   { "excluded_stories": { "<story-key>": { "reason": ..., "recorded_at": ... } } }
//
// Populated by skip_story / remove_from_sprint (record); cleared by
// add_to_sprint (remove). All I/O goes through an injected `fs` so tests use
// tmp dirs.

'use strict';

const nodeFs = require('node:fs');
const path = require('node:path');

function excludedPath(projectRoot) {
  return path.join(
    projectRoot,
    '_bmad-output',
    'implementation-artifacts',
    'excluded-stories.json',
  );
}

// Read the raw map. Tolerant: a missing file, unreadable file, malformed JSON,
// or unexpected shape all yield an empty map — the user should never have the
// sprint reset just because this artifact is absent or hand-mangled.
function readMap(projectRoot, fsImpl = nodeFs) {
  if (!projectRoot) return {};
  try {
    const raw = fsImpl.readFileSync(excludedPath(projectRoot), 'utf8');
    const obj = JSON.parse(raw);
    const m = obj && typeof obj === 'object' ? obj.excluded_stories : null;
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  } catch (_e) {
    return {};
  }
}

// Read the set of excluded story keys.
function readSet(projectRoot, fsImpl = nodeFs) {
  return new Set(Object.keys(readMap(projectRoot, fsImpl)));
}

function isExcluded(projectRoot, key, fsImpl = nodeFs) {
  if (typeof key !== 'string' || !key) return false;
  return Object.prototype.hasOwnProperty.call(readMap(projectRoot, fsImpl), key);
}

function writeMap(projectRoot, map, fsImpl = nodeFs) {
  const filePath = excludedPath(projectRoot);
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  const text = `${JSON.stringify({ excluded_stories: map }, null, 2)}\n`;
  // Atomic write via tmp sibling + rename (mirrors state-store.js).
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fsImpl.writeFileSync(tmp, text, 'utf8');
  fsImpl.renameSync(tmp, filePath);
}

function normalizeKeys(keys) {
  if (Array.isArray(keys)) return keys.filter((k) => typeof k === 'string' && k);
  return typeof keys === 'string' && keys ? [keys] : [];
}

// Upsert one or more story keys into the ledger. Idempotent: re-recording an
// existing key preserves its original recorded_at. Returns the count of keys
// newly added.
function recordExcluded(projectRoot, keys, meta = {}, fsImpl = nodeFs) {
  const list = normalizeKeys(keys);
  if (list.length === 0) return 0;
  const map = readMap(projectRoot, fsImpl);
  const at = new Date().toISOString();
  let added = 0;
  for (const k of list) {
    const existing = map[k];
    if (!existing) added += 1;
    map[k] = {
      reason:
        typeof meta.reason === 'string'
          ? meta.reason
          : (existing && existing.reason) || null,
      recorded_at: (existing && existing.recorded_at) || at,
    };
  }
  writeMap(projectRoot, map, fsImpl);
  return added;
}

// Remove one or more story keys from the ledger (un-exclude). Idempotent.
// Returns the count of keys actually removed.
function removeExcluded(projectRoot, keys, fsImpl = nodeFs) {
  const list = normalizeKeys(keys);
  if (list.length === 0) return 0;
  const map = readMap(projectRoot, fsImpl);
  let removed = 0;
  for (const k of list) {
    if (Object.prototype.hasOwnProperty.call(map, k)) {
      delete map[k];
      removed += 1;
    }
  }
  if (removed > 0) writeMap(projectRoot, map, fsImpl);
  return removed;
}

// Fold any sprint-status entry whose status is a terminal-non-done value
// (e.g. `deferred`, `skipped`, `cancelled`, `wont_do`, `abandoned`) into the
// owned ledger. Used by the resolver to durably remember externally-parked
// stories — hand-edits or any future BMad path that writes a non-canonical
// terminal value to sprint-status — so a later BMad re-plan that resets the
// value cannot reactivate them.
//
// `sprintStatuses` is the parsed map of story_key → { status }. `terminalNonDone`
// is the Set of status strings (lowercased) the caller considers exclusion-worthy
// (kept as a parameter so TERMINAL_STATUSES stays the single source of truth in
// autopilot.js). Idempotent: existing entries are left untouched.
function reconcileFromSprintStatus(projectRoot, sprintStatuses, terminalNonDone, fsImpl = nodeFs) {
  if (!projectRoot || !sprintStatuses || typeof sprintStatuses !== 'object') return 0;
  if (!terminalNonDone || typeof terminalNonDone.has !== 'function') return 0;
  const map = readMap(projectRoot, fsImpl);
  const at = new Date().toISOString();
  let added = 0;
  for (const key of Object.keys(sprintStatuses)) {
    if (typeof key !== 'string' || !key) continue;
    const info = sprintStatuses[key];
    const status = String((info && info.status) || '').trim().toLowerCase();
    if (!terminalNonDone.has(status)) continue;
    if (Object.prototype.hasOwnProperty.call(map, key)) continue;
    map[key] = { reason: `observed_terminal_${status}`, recorded_at: at };
    added += 1;
  }
  if (added > 0) writeMap(projectRoot, map, fsImpl);
  return added;
}

module.exports = {
  excludedPath,
  readMap,
  readSet,
  isExcluded,
  recordExcluded,
  removeExcluded,
  reconcileFromSprintStatus,
};
