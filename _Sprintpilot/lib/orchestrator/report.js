// report.js — session report markdown generator.
//
// Pure. Consumes a state snapshot + the action ledger and produces a
// human-readable markdown report. Used by `autopilot report` and as the
// handoff message when `session_story_limit` is hit.

'use strict';

const { STATES } = require('./state-machine');

function header(state) {
  return [
    '# Autopilot Session Report',
    '',
    `**Current story:** ${state.current_story || '(none)'}`,
    `**Current phase:** ${state.current_bmad_step || '(none)'}`,
    `**Sprint complete:** ${!!state.sprint_is_complete}`,
    `**Last updated:** ${state.last_updated || '(unknown)'}`,
  ].join('\n');
}

function ledgerSummary(entries) {
  const counts = Object.create(null);
  for (const e of entries) counts[e.kind] = (counts[e.kind] || 0) + 1;
  const lines = ['', '## Ledger summary', ''];
  for (const k of Object.keys(counts).sort()) {
    lines.push(`- ${k}: ${counts[k]}`);
  }
  return lines.join('\n');
}

function recentActions(entries, limit = 10) {
  const actionEntries = entries.filter((e) => e.kind === 'action_emitted').slice(-limit);
  const lines = ['', `## Last ${actionEntries.length} actions`, ''];
  for (const e of actionEntries) {
    const a = e.action || {};
    const summary =
      a.type === 'invoke_skill'
        ? `invoke_skill ${a.skill}`
        : a.type === 'run_script'
          ? `run_script ${a.command ? a.command[0] : '?'}`
          : a.type === 'git_op'
            ? `git_op ${a.op}`
            : a.type;
    lines.push(`- [${e.ts}] ${e.phase} → ${summary}`);
  }
  return lines.join('\n');
}

function recentDecisions(entries, limit = 5) {
  const dec = entries.filter((e) => e.kind === 'decisions_appended').slice(-limit);
  if (dec.length === 0) return '';
  const lines = ['', `## Recent decisions (${dec.length})`, ''];
  for (const e of dec) {
    lines.push(`- [${e.ts}] story=${e.story} phase=${e.phase} ids=${(e.ids || []).join(',')}`);
  }
  return lines.join('\n');
}

function blockers(entries) {
  const halts = entries.filter((e) => e.kind === 'halt').slice(-3);
  if (halts.length === 0) return '';
  const lines = ['', '## Recent halts', ''];
  for (const e of halts) {
    lines.push(`- [${e.ts}] phase=${e.phase} reason=${e.reason || '(none)'}`);
  }
  return lines.join('\n');
}

// fastLaneSummary(entries) → a metrics block for the quick-dev fast lane, or
// '' when the lane never fired this sprint (the ledger is append-only and
// sprint-lifetime, not reset per session). Counts routing decisions
// (fast_lane_decision) and how many fast-laned stories bounced back to the
// full cycle (profile_escalated from='fast_lane'), so the value/cost of the
// fast lane is visible at a glance.
function fastLaneSummary(entries) {
  const decisions = entries.filter((e) => e.kind === 'fast_lane_decision');
  if (decisions.length === 0) return '';
  // A story counts as "fast-laned" if it was EVER routed fast (it ran
  // quick-dev), independent of a later forced-full flip. "Kept full" means it
  // was never fast-laned. This avoids mislabeling an escalated story — which
  // did run quick-dev — as if it stayed on the full cycle the whole time.
  const everFast = new Set();
  const seen = new Set();
  for (const e of decisions) {
    const k = e.story_key || '(unknown)';
    seen.add(k);
    if (e.decision === 'fast') everFast.add(k);
  }
  const keptFull = [...seen].filter((k) => !everFast.has(k)).length;
  const escalatedKeys = new Set(
    entries
      .filter((e) => e.kind === 'profile_escalated' && e.from === 'fast_lane')
      .map((e) => e.story_key || '(unknown)'),
  );
  const lines = [
    '',
    '## Fast lane',
    '',
    `- Stories fast-laned (ran quick-dev one-shot): ${everFast.size}`,
    `- Stories kept on the full cycle: ${keptFull}`,
    `- Fast-laned stories escalated back to full: ${escalatedKeys.size}`,
  ];
  if (escalatedKeys.size > 0) {
    lines.push(`  - ${Array.from(escalatedKeys).join(', ')}`);
  }
  return lines.join('\n');
}

function nextActionHint(state, profile) {
  const phase = state.current_bmad_step;
  if (state.sprint_is_complete && phase !== STATES.SPRINT_FINALIZE_PENDING) {
    return '\n## Next action\n\nSprint is complete. Next `autopilot start` will run finalize in a fresh context.';
  }
  if (phase === STATES.SPRINT_FINALIZE_PENDING) {
    return '\n## Next action\n\nFinalize step pending. Run `/sprint-autopilot-on` in a fresh session to complete.';
  }
  return `\n## Next action\n\nRun \`autopilot next\` to emit the action for phase=${phase} on profile=${profile?.name ?? '?'}.`;
}

function render(state, entries, profile) {
  const safeEntries = Array.isArray(entries) ? entries : [];
  return [
    header(state || {}),
    ledgerSummary(safeEntries),
    fastLaneSummary(safeEntries),
    recentActions(safeEntries),
    recentDecisions(safeEntries),
    blockers(safeEntries),
    nextActionHint(state || {}, profile || {}),
  ]
    .filter(Boolean)
    .join('\n');
}

module.exports = {
  render,
  header,
  ledgerSummary,
  fastLaneSummary,
  recentActions,
  recentDecisions,
  blockers,
  nextActionHint,
};
