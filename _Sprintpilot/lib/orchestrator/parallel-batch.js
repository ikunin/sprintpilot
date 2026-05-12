// parallel-batch.js — plan a parallel batch of child Actions.
//
// The orchestrator emits a `parallel_batch` action when (and only when):
//   - profile.parallel_stories === true
//   - host_supports_parallel === true
//   - There are independent stories ready (per the inferred DAG)
//
// This module is pure. It does NOT spawn subprocesses; it produces the
// batch structure the CLI/host dispatcher consumes.
//
// Shape returned:
//   {
//     type: 'parallel_batch',
//     concurrency: number,        // capped at profile.max_parallel_stories
//     children: ChildAction[],    // each a regular Action (invoke_skill, run_script, ...)
//     fallback: 'sequential',     // hosts without parallel support degrade to sequential
//   }

'use strict';

function planBatch(childActions, profile, hostSupportsParallel) {
  if (!Array.isArray(childActions)) {
    throw new Error('planBatch: childActions must be an array');
  }
  if (childActions.length === 0) {
    return { type: 'parallel_batch', concurrency: 0, children: [], fallback: 'sequential' };
  }

  const requested = childActions.length;
  const cap = Math.max(1, Math.min(profile?.max_parallel_stories ?? 2, requested));
  const allowed = !!(profile?.parallel_stories && hostSupportsParallel);

  if (!allowed) {
    // Degrade: emit the same children as a sequence (concurrency=1).
    return {
      type: 'parallel_batch',
      concurrency: 1,
      children: childActions,
      fallback: 'sequential',
      degraded: true,
      degraded_reason: !profile?.parallel_stories
        ? 'profile.parallel_stories=false'
        : 'host_supports_parallel=false',
    };
  }

  return {
    type: 'parallel_batch',
    concurrency: cap,
    children: childActions,
    fallback: 'sequential',
  };
}

// classifyResults — given the per-child results, compute an aggregate
// signal for the orchestrator to record at batch boundary.
//   children: { id, status, output?, reason? }[]
// Aggregate semantics:
//   - all success    → 'success'
//   - any block      → 'blocked' with kind unknown + user_input_needed=true
//   - any failure    → 'failure' (recoverable=true iff every failure was recoverable)
//   - else (mixed)   → 'failure' (recoverable=false) — surfaces to user
function classifyResults(children) {
  if (!Array.isArray(children) || children.length === 0) {
    return { status: 'success', count: 0 };
  }
  const statuses = children.map((c) => c.status);
  if (statuses.every((s) => s === 'success')) {
    return { status: 'success', count: statuses.length };
  }
  if (statuses.some((s) => s === 'blocked')) {
    return {
      status: 'blocked',
      blocker_kind: 'unknown',
      user_input_needed: true,
      details: 'parallel batch had a blocked child',
      children_blocked: children.filter((c) => c.status === 'blocked').map((c) => c.id),
    };
  }
  const failures = children.filter((c) => c.status === 'failure');
  if (failures.length > 0) {
    const allRecoverable = failures.every((c) => c.recoverable !== false);
    return {
      status: 'failure',
      reason: `${failures.length}/${children.length} children failed`,
      diagnosis: failures.map((c) => c.reason || 'unknown').join('; '),
      recoverable: allRecoverable,
    };
  }
  // Mixed (none of the above) — surface as non-recoverable for safety.
  return {
    status: 'failure',
    reason: `unexpected mixed statuses: ${statuses.join(',')}`,
    diagnosis: 'classifyResults could not aggregate',
    recoverable: false,
  };
}

module.exports = { planBatch, classifyResults };
