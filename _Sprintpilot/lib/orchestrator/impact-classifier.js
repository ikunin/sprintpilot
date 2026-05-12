// impact-classifier.js — classify the impact of a propose_alternative signal.
//
// The LLM proposes an alternative action. The orchestrator decides whether
// to auto-accept (low impact) or escalate to user_prompt (medium / high).
//
// Design (from the plan):
//   - Different action `type`               → high
//   - Same type, different skill / script   → medium
//   - Same skill, args differ:
//       * all differing args are in LOW_RISK_ARG_WHITELIST → low
//       * otherwise                                        → medium
//   - LLM-supplied `urgency_hint` can only RAISE the classification,
//     never lower it.
//
// Pure module. No I/O.

'use strict';

const LOW_RISK_ARG_WHITELIST = new Set([
  'retry_budget',
  'action_id',
  'rationale',
  'branch_name_suffix',
]);

const URGENCY_RANK = { low: 0, medium: 1, high: 2 };
const RANK_TO_URGENCY = ['low', 'medium', 'high'];

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function diffArgs(planned, alternative) {
  const a = isPlainObject(planned) ? planned : {};
  const b = isPlainObject(alternative) ? alternative : {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diffs = [];
  for (const k of keys) {
    if (!deepEqual(a[k], b[k])) diffs.push(k);
  }
  return diffs;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function bumpByUrgency(level, urgencyHint) {
  if (!urgencyHint || !(urgencyHint in URGENCY_RANK)) return level;
  const baseRank = URGENCY_RANK[level];
  const hintRank = URGENCY_RANK[urgencyHint];
  return RANK_TO_URGENCY[Math.max(baseRank, hintRank)];
}

// classifyImpact(planned, alternative, llmUrgencyHint?) → 'low' | 'medium' | 'high'
function classifyImpact(planned, alternative, llmUrgencyHint) {
  if (!isPlainObject(planned) || !isPlainObject(alternative)) {
    return bumpByUrgency('high', llmUrgencyHint);
  }
  if (planned.type !== alternative.type) {
    return bumpByUrgency('high', llmUrgencyHint);
  }

  // Same type. For invoke_skill we look at skill identity then args.
  // For run_script we look at command[0] then args. For git_op we look at
  // git subcommand.
  if (planned.type === 'invoke_skill') {
    if (planned.skill !== alternative.skill) return bumpByUrgency('medium', llmUrgencyHint);
  } else if (planned.type === 'run_script') {
    const pcmd = Array.isArray(planned.command) ? planned.command[0] : undefined;
    const acmd = Array.isArray(alternative.command) ? alternative.command[0] : undefined;
    if (pcmd !== acmd) return bumpByUrgency('medium', llmUrgencyHint);
  } else if (planned.type === 'git_op') {
    if (planned.op !== alternative.op) return bumpByUrgency('medium', llmUrgencyHint);
  }

  const argDiffs = diffArgs(planned.args, alternative.args);
  if (argDiffs.length === 0) {
    // No arg differences at all — only metadata changed; treat as low.
    return bumpByUrgency('low', llmUrgencyHint);
  }
  const allWhitelisted = argDiffs.every((k) => LOW_RISK_ARG_WHITELIST.has(k));
  return bumpByUrgency(allWhitelisted ? 'low' : 'medium', llmUrgencyHint);
}

module.exports = {
  classifyImpact,
  diffArgs,
  LOW_RISK_ARG_WHITELIST: Array.from(LOW_RISK_ARG_WHITELIST),
};
