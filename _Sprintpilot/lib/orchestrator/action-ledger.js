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
  // v2.3.0 — sprint-plan.yaml lifecycle + queue events. Emitted from
  // cmdStart (migration trigger, refresh, queue hydration, auto-derive
  // gate, exhaustion) and cmdRecord (story-done sync to plan).
  'plan_migrated',
  'plan_migration_failed',
  'plan_refreshed',
  'plan_refresh_failed',
  'plan_queue_loaded',
  'plan_queue_failed',
  'plan_exhausted',
  'plan_archive_failed',
  'auto_derive_emitted',
  'plan_story_done',
  'plan_story_done_failed',
  'replan_requested_consumed',
  // v2.3.0 — mid-flight plan mutations applied via applySideEffects.
  'plan_reordered',
  'plan_reorder_rejected',
  'plan_reorder_failed',
  'plan_stories_added',
  'plan_add_stories_failed',
  'plan_stories_removed',
  'plan_remove_stories_failed',
  // v2.3.0 — planning skill outcomes (emitted by /sprintpilot-plan-sprint
  // via the orchestrator after the skill completes).
  'plan_built',
  'cross_epic_edge_rejected',
  'issue_id_set',
  'dag_rendered',
  // v2.3.0 — streaming progress (Phase 4.5). Sub-step granularity within
  // a single story so `autopilot progress` can render live status.
  'story_step_started',
  'story_step_progress',
  'story_step_completed',
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

// readSince — return entries with seq strictly greater than `afterSeq`.
// Used by the tail iterator and one-shot consumers that want incremental
// reads without re-parsing the whole file.
function readSince(context, afterSeq) {
  const entries = read(context);
  if (typeof afterSeq !== 'number') return entries;
  return entries.filter((e) => typeof e.seq === 'number' && e.seq > afterSeq);
}

// tail — async iterator yielding ledger entries as they're appended.
// Polls every `pollIntervalMs` (default 250ms). Terminates when
// `signal.aborted` is true OR when `maxIdleMs` elapses without new events
// (default Infinity).
//
// Usage:
//   const ctrl = new AbortController();
//   for await (const event of tail({ projectRoot, signal: ctrl.signal })) {
//     console.log(event.kind, event.seq);
//     if (event.kind === 'halt') ctrl.abort();
//   }
//
// CI-safe: no fs.watch (some filesystems don't support it; CI logs can
// be replayed via the underlying file). Pure polling with offset tracking
// for cheap incremental reads.
async function* tail(context, options) {
  if (!context || !context.projectRoot) throw new Error('tail: context.projectRoot required');
  const opts = options || {};
  const pollIntervalMs = typeof opts.pollIntervalMs === 'number' ? opts.pollIntervalMs : 250;
  const maxIdleMs = typeof opts.maxIdleMs === 'number' ? opts.maxIdleMs : Number.POSITIVE_INFINITY;
  const signal = opts.signal;
  let lastSeq = typeof opts.afterSeq === 'number' ? opts.afterSeq : 0;

  // v2.3.0 — track the ledger file's inode so we detect rotation /
  // truncation. If `> ledger.jsonl` or `mv ledger.jsonl ledger.jsonl.1`
  // happens, the inode changes (or stat throws) and we reset lastSeq
  // to 0 so the next poll picks up entries from the start of the new
  // file. Without this, tail() silently misses every event after a
  // rotation.
  const filePath = resolveLedgerPath(context.projectRoot);
  let lastInode = null;
  let lastSize = 0;
  const captureFileIdentity = () => {
    try {
      const st = nodeFs.lstatSync(filePath);
      lastInode = st.ino;
      lastSize = st.size;
    } catch {
      // File doesn't exist yet — that's fine; on first poll we'll
      // capture the identity when it appears.
      lastInode = null;
      lastSize = 0;
    }
  };
  captureFileIdentity();

  // If afterSeq isn't supplied, start from the current tail so we don't
  // dump the whole history on every call. Pass afterSeq=0 explicitly to
  // get everything.
  if (typeof opts.afterSeq !== 'number') {
    const existing = read(context);
    if (existing.length > 0) {
      const tailEntry = existing[existing.length - 1];
      if (typeof tailEntry.seq === 'number') lastSeq = tailEntry.seq;
    }
  }

  const sleep = (ms) => new Promise((resolve) => {
    if (!signal) {
      setTimeout(resolve, ms);
      return;
    }
    const t = setTimeout(resolve, ms);
    if (signal.aborted) {
      clearTimeout(t);
      resolve();
      return;
    }
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

  let idleAccumulatedMs = 0;
  while (!(signal && signal.aborted)) {
    // Rotation / truncation check before each poll. Three cases:
    //   - File didn't exist before, now does → capture identity, treat
    //     as fresh start; do NOT reset lastSeq (afterSeq semantics still
    //     apply).
    //   - File existed before, now doesn't → it was deleted; reset
    //     identity tracking, on next iteration we'll re-capture.
    //   - File exists with a different inode OR smaller size than last
    //     time → rotated/truncated; reset lastSeq=0 so we yield from
    //     the start of the new file.
    let currentInode = null;
    let currentSize = 0;
    try {
      const st = nodeFs.lstatSync(filePath);
      currentInode = st.ino;
      currentSize = st.size;
    } catch {
      // File missing — wait for it to appear.
    }
    if (lastInode !== null && currentInode !== null) {
      const inodeChanged = currentInode !== lastInode;
      const truncated = currentSize < lastSize;
      if (inodeChanged || truncated) {
        lastSeq = 0; // re-yield from the new file's start
        lastInode = currentInode;
        lastSize = currentSize;
      }
    } else if (currentInode !== null) {
      // File appeared (was missing, now exists).
      lastInode = currentInode;
      lastSize = currentSize;
    }

    const fresh = readSince(context, lastSeq);
    // v2.3.0 Round 2 — re-check inode AFTER readSince. The file could
    // rotate during the read; without this we'd yield entries from the
    // NEW file as if they were continuations of the old one (or skip
    // them if their seq < lastSeq from the rotated file).
    let postReadInode = null;
    let postReadSize = 0;
    try {
      const st = nodeFs.lstatSync(filePath);
      postReadInode = st.ino;
      postReadSize = st.size;
    } catch {
      /* file gone — handled next iteration */
    }
    if (
      lastInode !== null &&
      postReadInode !== null &&
      (postReadInode !== lastInode || postReadSize < lastSize)
    ) {
      // Rotation/truncation happened during the read. Discard the
      // fresh batch (might be from the OLD inode), reset lastSeq to 0,
      // and let the next iteration re-yield from the new file's start.
      lastSeq = 0;
      lastInode = postReadInode;
      lastSize = postReadSize;
      // Don't yield any of `fresh` since we can't trust which file
      // they came from after the rotation; the next iteration's
      // readSince(0) will pick up the new file's entries.
      await sleep(pollIntervalMs);
      continue;
    }
    if (fresh.length > 0) {
      idleAccumulatedMs = 0;
      for (const event of fresh) {
        if (signal && signal.aborted) return;
        if (typeof event.seq === 'number' && event.seq > lastSeq) {
          lastSeq = event.seq;
        }
        yield event;
      }
      // Refresh size after yielding so the next iteration's truncation
      // check uses the right baseline.
      try {
        lastSize = nodeFs.lstatSync(filePath).size;
      } catch {
        /* file disappeared between yield and stat — handle next loop */
      }
    } else {
      idleAccumulatedMs += pollIntervalMs;
      if (idleAccumulatedMs >= maxIdleMs) return;
    }
    await sleep(pollIntervalMs);
  }
}

module.exports = {
  VALID_KINDS,
  LEDGER_FILENAME,
  append,
  read,
  readSince,
  last,
  tail,
  resolveLedgerPath,
};
