// halt-explainer.js — enrich user_prompt actions with context — v2.4.0.
//
// Today's user_prompts surface a one-line reason ("verify_rejected: …")
// and let the user dig through the ledger to figure out what actually
// happened. This module reads the ledger and the current state to
// attach four context bundles to any user_prompt the orchestrator emits:
//
//   recent_actions    — last N (default 3) invoke_skill / git_op /
//                       run_script actions, oldest-first.
//   verifier_check    — when reason looks like a verify-rejection, the
//                       most recent verify_result with ok=false.
//   elapsed_in_phase  — { phase, minutes } when state.phase_started_at
//                       is present.
//   similar_halt      — pointer to a prior halt with the same phase +
//                       reason (seq + ts), or null.
//
// Pure-ish: takes ledger entries + state as inputs; no I/O. The CLI edge
// reads the ledger via action-ledger.js and hands the entries in.
//
// Trust & predictability bundle: roadmap v2.4.0 #2.

'use strict';

const RECENT_ACTION_KINDS = new Set(['action_emitted']);
const RECENT_ACTION_TYPES = new Set(['invoke_skill', 'git_op', 'run_script']);

const VERIFY_REJECT_REASONS = new Set([
  'verify_reject_budget_exceeded',
  'verify_rejected',
  'retry_budget_exhausted',
  'failure_not_recoverable',
  'consecutive_test_failures_threshold',
]);

// Build a 1-line digest of an action_emitted ledger entry. Drops template
// slots and step lists so the recent_actions array stays compact.
function summarizeAction(entry) {
  if (!entry || entry.kind !== 'action_emitted' || !entry.action) return null;
  const a = entry.action;
  if (!RECENT_ACTION_TYPES.has(a.type)) return null;
  const base = {
    seq: entry.seq,
    ts: entry.ts,
    phase: entry.phase || a.phase || null,
    type: a.type,
  };
  if (a.type === 'invoke_skill') base.skill = a.skill || null;
  if (a.type === 'git_op') base.op = a.op || null;
  if (a.type === 'run_script') base.op = a.op || null;
  return base;
}

// Pull the last N action_emitted entries that match RECENT_ACTION_TYPES,
// oldest-first. Excludes the current emission (caller hasn't appended it
// yet — but we filter by `seq < currentMaxSeq` defensively).
function recentActions(ledgerEntries, limit) {
  if (!Array.isArray(ledgerEntries)) return [];
  const n = typeof limit === 'number' && limit > 0 ? limit : 3;
  const found = [];
  for (let i = ledgerEntries.length - 1; i >= 0 && found.length < n; i -= 1) {
    const e = ledgerEntries[i];
    if (!e || !RECENT_ACTION_KINDS.has(e.kind)) continue;
    const summary = summarizeAction(e);
    if (summary) found.push(summary);
  }
  return found.reverse();
}

// Find the most recent verify_result with ok=false. Returns null when none.
function lastFailedVerify(ledgerEntries) {
  if (!Array.isArray(ledgerEntries)) return null;
  for (let i = ledgerEntries.length - 1; i >= 0; i -= 1) {
    const e = ledgerEntries[i];
    if (!e || e.kind !== 'verify_result') continue;
    if (e.result && e.result.ok === false) {
      return {
        seq: e.seq,
        ts: e.ts,
        phase: e.phase || null,
        issues: Array.isArray(e.result.issues) ? e.result.issues.slice(0, 10) : [],
        // Some verify hooks attach test_name / exit_code / command.
        // Surface them when present without inventing structure.
        test_name: e.result.test_name || null,
        exit_code: typeof e.result.exit_code === 'number' ? e.result.exit_code : null,
        command: typeof e.result.command === 'string' ? e.result.command : null,
      };
    }
  }
  return null;
}

// Compute elapsed minutes since the current phase started.
function elapsedInPhase(state, nowIso) {
  if (!state || !state.phase || !state.phase_started_at) return null;
  const started = Date.parse(state.phase_started_at);
  if (!Number.isFinite(started)) return null;
  const nowParsed = typeof nowIso === 'string' ? Date.parse(nowIso) : Number(nowIso);
  const now = Number.isFinite(nowParsed) ? nowParsed : Date.now();
  const minutes = (now - started) / 60_000;
  return {
    phase: state.phase,
    minutes: Math.round(minutes * 10) / 10,
    phase_started_at: state.phase_started_at,
  };
}

// Scan ledger entries for a prior halt with the same (phase, reason) and
// return a compact pointer. Excludes the current halt by requiring a
// non-null `phase` and `reason` to match — and skipping entries inside the
// most recent contiguous span (heuristic: we want a halt from BEFORE this
// session's hot loop, not a halt 2 seconds ago).
//
// "Most recent contiguous span" = anything since the last `lock_acquired`
// (start-of-session) event. Halts within the current session are NOT
// considered similar — they're the same event from the user's POV.
function similarPriorHalt(ledgerEntries, currentPhase, currentReason) {
  if (!Array.isArray(ledgerEntries) || !currentPhase || !currentReason) return null;
  // Find the seq of the most recent lock_acquired. Halts at or after that
  // seq are intra-session and skipped.
  let sessionStartSeq = 0;
  for (let i = ledgerEntries.length - 1; i >= 0; i -= 1) {
    const e = ledgerEntries[i];
    if (e && e.kind === 'lock_acquired') {
      sessionStartSeq = typeof e.seq === 'number' ? e.seq : 0;
      break;
    }
  }
  for (let i = ledgerEntries.length - 1; i >= 0; i -= 1) {
    const e = ledgerEntries[i];
    if (!e) continue;
    if (typeof e.seq === 'number' && e.seq >= sessionStartSeq && sessionStartSeq > 0) continue;
    // Match either kind:'halt' with .reason, or action_emitted of a
    // user_prompt with .reason.
    if (e.kind === 'halt' && e.phase === currentPhase && e.reason === currentReason) {
      return { seq: e.seq, ts: e.ts, phase: e.phase, reason: e.reason };
    }
    if (
      e.kind === 'action_emitted' &&
      e.action &&
      e.action.type === 'user_prompt' &&
      e.action.phase === currentPhase &&
      e.action.reason === currentReason
    ) {
      return { seq: e.seq, ts: e.ts, phase: e.action.phase, reason: e.action.reason };
    }
  }
  return null;
}

// enrich(action, ctx) → action
//   ctx: { ledgerEntries, state, now? }
//
// Adds `context` field to user_prompt actions. Returns the original
// action unmodified for non-user_prompt types so callers can pipe every
// action through this without conditionals.
function enrich(action, ctx) {
  if (!action || action.type !== 'user_prompt') return action;
  if (!ctx) return action;
  const { ledgerEntries, state } = ctx;
  const now = ctx.now || new Date().toISOString();

  const recent = recentActions(ledgerEntries, 3);
  const verifier = VERIFY_REJECT_REASONS.has(action.reason)
    ? lastFailedVerify(ledgerEntries)
    : null;
  const elapsed = elapsedInPhase(state, now);
  const similar = similarPriorHalt(ledgerEntries, action.phase, action.reason);

  // Preserve any context the action already carries (a few user_prompts
  // attach diagnosis / findings / planned/alternative directly — keep
  // them visible alongside the new fields).
  const context = {
    recent_actions: recent,
    verifier_check: verifier,
    elapsed_in_phase: elapsed,
    similar_halt: similar,
  };

  return { ...action, context };
}

module.exports = {
  enrich,
  recentActions,
  lastFailedVerify,
  elapsedInPhase,
  similarPriorHalt,
  summarizeAction,
  RECENT_ACTION_TYPES: Array.from(RECENT_ACTION_TYPES),
  VERIFY_REJECT_REASONS: Array.from(VERIFY_REJECT_REASONS),
};
