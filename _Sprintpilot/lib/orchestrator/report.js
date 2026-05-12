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
    recentActions(safeEntries),
    recentDecisions(safeEntries),
    blockers(safeEntries),
    nextActionHint(state || {}, profile || {}),
  ]
    .filter(Boolean)
    .join('\n');
}

module.exports = { render, header, ledgerSummary, recentActions, recentDecisions, blockers, nextActionHint };
