// action-ledger.js — append-only JSONL ledger of orchestrator activity.
//
// Each line is a JSON object describing one event in the orchestrator's
// life: emitted action, recorded signal, side-effect, profile escalation,
// verify rejection, etc. The ledger is the single source of truth for
// resume detection (see divergence.js) and post-hoc audit.
//
// File layout: <projectRoot>/_bmad-output/implementation-artifacts/
//                ledger.jsonl
//
// Append-only by contract — no in-place edits. Atomic via fs.appendFileSync.
// JSON-per-line so partial writes are recoverable (a corrupt tail line can
// be skipped by the reader; previous lines remain valid).

'use strict';

const nodeFs = require('node:fs');
const path = require('node:path');

const LEDGER_FILENAME = 'ledger.jsonl';

const VALID_KINDS = [
  'action_emitted',
  'signal_recorded',
  'verify_result',
  'state_transition',
  'profile_escalated',
  'decisions_appended',
  'user_commands_applied',
  'alternative_proposed',
  'verify_override',
  'verify_rejected',
  'halt',
  'resume',
  'lock_acquired',
  'lock_released',
  'flush',
  // Explicit story queue installed via `autopilot start --stories` /
  // `--epic`. Logged once per start invocation so resume/audit can see
  // why a queue head differs from sprint-status's natural order.
  'story_queue_set',
  // Worktree health check result, logged once per cmdStart when
  // git.worktree.health_check_on_boot is true (the default). Detail
  // includes `summary` (counts) or `reason` ('disabled' / 'no_worktrees_dir'
  // / 'script_missing' / 'health_check_error' / 'worktrees_disabled').
  'worktree_health_check',
];

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function resolveLedgerPath(projectRoot) {
  return path.join(projectRoot, '_bmad-output', 'implementation-artifacts', LEDGER_FILENAME);
}

// append(entry, context)
//   entry: {
//     kind: one of VALID_KINDS,
//     ...kind-specific fields
//   }
//   context: { projectRoot, now?: () => Date, fs? }
//
// Returns the persisted entry with `ts` (ISO timestamp) and `seq` populated.
function append(entry, context) {
  if (!isPlainObject(entry)) throw new Error('append: entry must be an object');
  if (!entry.kind || !VALID_KINDS.includes(entry.kind)) {
    throw new Error(`append: entry.kind must be one of ${VALID_KINDS.join(',')}`);
  }
  if (!context || !context.projectRoot) throw new Error('append: context.projectRoot required');
  const fs = (context && context.fs) || nodeFs;
  const nowFn = (context && context.now) || (() => new Date());

  const filePath = resolveLedgerPath(context.projectRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const seq = nextSeq(fs, filePath);
  const stamped = {
    seq,
    ts: nowFn().toISOString(),
    ...entry,
  };
  fs.appendFileSync(filePath, `${JSON.stringify(stamped)}\n`, 'utf8');
  return stamped;
}

// read(context, options?) — read the full ledger, skipping corrupt tail lines.
//   options.limit: number — return only the last N entries
function read(context, options) {
  if (!context || !context.projectRoot) throw new Error('read: context.projectRoot required');
  const fs = (context && context.fs) || nodeFs;
  const filePath = resolveLedgerPath(context.projectRoot);

  let text = '';
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (_e) {
    return [];
  }
  const lines = text.split(/\n/).filter((l) => l.length > 0);
  const entries = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (isPlainObject(obj)) entries.push(obj);
    } catch (_e) {
      // Skip corrupt line (likely partial write). Read continues — append-only
      // semantics mean prior lines are still trustworthy.
    }
  }
  if (options && typeof options.limit === 'number' && options.limit > 0) {
    return entries.slice(-options.limit);
  }
  return entries;
}

// last(context, kind?) — return the most recent entry, optionally filtered by kind.
function last(context, kind) {
  const entries = read(context);
  if (!entries.length) return null;
  if (!kind) return entries[entries.length - 1];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].kind === kind) return entries[i];
  }
  return null;
}

// nextSeq — compute the next sequence number by inspecting the last line.
// Reading just the tail is cheap because we use append-only JSONL.
function nextSeq(fs, filePath) {
  let text = '';
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (_e) {
    return 1;
  }
  if (!text) return 1;
  const lines = text.split(/\n/).filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const obj = JSON.parse(lines[i]);
      if (typeof obj.seq === 'number') return obj.seq + 1;
    } catch (_e) {
      // Try the previous line.
    }
  }
  return 1;
}

module.exports = {
  VALID_KINDS,
  LEDGER_FILENAME,
  append,
  read,
  last,
  resolveLedgerPath,
};
