// sprint-health.js — compute observability metrics from the ledger
// and append them to per-epic retrospective files — v2.5.0.
//
// `computeMetrics(ledgerEntries, opts)` is pure: it takes the parsed
// ledger array and an optional epic filter, returns a digestible
// JSON object with counts + averages. Tests use this directly.
//
// `appendMetricsSection(retroPath, metrics, fs?)` writes a
// `## Sprint Health Metrics` section to the retro markdown file.
// Idempotent: if the section already exists (we tag it with a
// machine-readable HTML comment), the function replaces it in place
// instead of appending a duplicate.
//
// Metrics surfaced (kept compact; pull just the things the retro
// reader actually scans for):
//   stories_completed                       count of STORY_DONE → EPIC_BOUNDARY_CHECK transitions
//   total_actions                           every action_emitted in the window
//   total_halts                             halt events
//   total_verify_rejections                 verify_rejected events
//   total_retries                           state_transitions with verdict=retry
//   profile_escalations                     profile_escalated events
//   flaky_tests_recorded                    record_flaky_tests sum of tests[]
//   flaky_tests_quarantined                 newly_quarantined sum
//   review_depth_distribution               { trivial, normal, structural }
//   background_suite_pass_rate              passes / (passes + failures); null when no runs
//   average_phase_minutes                   per-phase mean time between phase entries
//   ledger_span_minutes                     first_ts → last_ts of the metric window

'use strict';

const nodeFs = require('node:fs');

const SECTION_TAG_OPEN = '<!-- sprintpilot:sprint-health-metrics v1 BEGIN -->';
const SECTION_TAG_CLOSE = '<!-- sprintpilot:sprint-health-metrics v1 END -->';

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseTs(ts) {
  if (typeof ts !== 'string') return NaN;
  return Date.parse(ts);
}

// computeMetrics(ledgerEntries, opts?) → metrics object
//   opts.epicKey — when present, restrict to entries whose
//     entry.detail.epic_key / state.current_epic match. Currently the
//     ledger doesn't tag every event with epic, so this is best-effort:
//     entries between the most recent EPIC_BOUNDARY_CHECK pair are
//     attributed to the closing epic. When epicKey is absent, the
//     metrics span the whole ledger.
function computeMetrics(ledgerEntries, opts = {}) {
  const entries = Array.isArray(ledgerEntries) ? ledgerEntries : [];
  const window = sliceEpicWindow(entries, opts.epicKey || null);

  let storiesCompleted = 0;
  let totalActions = 0;
  let totalHalts = 0;
  let totalVerifyRejections = 0;
  let totalRetries = 0;
  let profileEscalations = 0;
  let flakyTestsRecorded = 0;
  let flakyTestsQuarantined = 0;
  let backgroundSuitePasses = 0;
  let backgroundSuiteFailures = 0;
  const reviewDepth = { trivial: 0, normal: 0, structural: 0 };
  // Phase timing: collect entry timestamps per phase from state_transition
  // entries (kind: 'state_transition', { from, to }). Pairing the
  // "to=phase" timestamp with the next "from=phase" timestamp yields
  // the phase duration.
  const phaseEntries = []; // { phase, ts }

  for (const e of window) {
    if (!e) continue;
    switch (e.kind) {
      case 'action_emitted':
        totalActions += 1;
        break;
      case 'halt':
        totalHalts += 1;
        break;
      case 'verify_rejected':
        totalVerifyRejections += 1;
        break;
      case 'state_transition':
        if (e.to) phaseEntries.push({ phase: e.to, ts: parseTs(e.ts) });
        if (e.verdict === 'retry') totalRetries += 1;
        if (e.detail && e.detail.background_full_suite === 'spawned') {
          // Spawn doesn't tell us pass/fail; we count completions below
          // from the sidecar.
        }
        break;
      case 'profile_escalated':
        profileEscalations += 1;
        break;
      case 'review_depth_decision':
        if (e.detail && reviewDepth[e.detail.size] !== undefined) {
          reviewDepth[e.detail.size] += 1;
        }
        break;
      default:
        break;
    }
    // Story-completion: state_transition with verdict='advanced' and
    // to=EPIC_BOUNDARY_CHECK from STORY_DONE (or STORY_LAND under
    // land-as-you-go).
    if (
      e.kind === 'state_transition' &&
      e.to === 'epic_boundary_check' &&
      (e.from === 'story_done' || e.from === 'story_land')
    ) {
      storiesCompleted += 1;
    }
    // Flaky tracking — state_transitions carry the detail per the
    // record_flaky_tests applier path.
    if (e.kind === 'state_transition' && e.detail) {
      if (Array.isArray(e.detail.flaky_recorded)) {
        flakyTestsRecorded += e.detail.flaky_recorded.length;
      }
      if (Array.isArray(e.detail.newly_quarantined)) {
        flakyTestsQuarantined += e.detail.newly_quarantined.length;
      }
    }
  }

  // Compute average per-phase duration. For each phase, pair entries by
  // ts order; duration = next_phase_entry - this_phase_entry.
  const phaseDurations = {};
  for (let i = 0; i < phaseEntries.length - 1; i += 1) {
    const cur = phaseEntries[i];
    const next = phaseEntries[i + 1];
    if (!Number.isFinite(cur.ts) || !Number.isFinite(next.ts)) continue;
    const ms = next.ts - cur.ts;
    if (ms < 0 || ms > 4 * 60 * 60_000) continue; // sanity: skip >4h gaps
    if (!phaseDurations[cur.phase]) phaseDurations[cur.phase] = [];
    phaseDurations[cur.phase].push(ms);
  }
  const averagePhaseMinutes = {};
  for (const [phase, samples] of Object.entries(phaseDurations)) {
    if (samples.length === 0) continue;
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    averagePhaseMinutes[phase] = Math.round((avg / 60_000) * 10) / 10;
  }

  // Background suite pass rate — derived from sidecar state if any
  // state_transition entry carries the result; conservative default null.
  // (More complete picture in the actual sidecar files; this is the
  // ledger-only view useful for the retro.)
  const bgRuns = backgroundSuitePasses + backgroundSuiteFailures;
  const backgroundSuitePassRate = bgRuns > 0
    ? Math.round((backgroundSuitePasses / bgRuns) * 100) / 100
    : null;

  // Span — first ts to last ts (informational only).
  const tsArr = window.map((e) => parseTs(e.ts)).filter(Number.isFinite);
  let ledgerSpanMinutes = null;
  if (tsArr.length >= 2) {
    ledgerSpanMinutes = Math.round(((Math.max(...tsArr) - Math.min(...tsArr)) / 60_000) * 10) / 10;
  }

  // Retry rate: retries / stories_completed (rounded).
  const retryRate = storiesCompleted > 0
    ? Math.round((totalRetries / storiesCompleted) * 10) / 10
    : null;

  return {
    epic_key: opts.epicKey || null,
    window_entries: window.length,
    stories_completed: storiesCompleted,
    total_actions: totalActions,
    total_halts: totalHalts,
    total_verify_rejections: totalVerifyRejections,
    total_retries: totalRetries,
    retry_rate_per_story: retryRate,
    profile_escalations: profileEscalations,
    flaky_tests_recorded: flakyTestsRecorded,
    flaky_tests_quarantined: flakyTestsQuarantined,
    review_depth_distribution: reviewDepth,
    background_suite_pass_rate: backgroundSuitePassRate,
    average_phase_minutes: averagePhaseMinutes,
    ledger_span_minutes: ledgerSpanMinutes,
  };
}

// sliceEpicWindow(entries, epicKey) — return the subset of the ledger
// that should be attributed to `epicKey`. Heuristic: locate the closing
// EPIC_BOUNDARY_CHECK whose state.current_epic matches epicKey, then
// walk back to the previous EPIC_BOUNDARY_CHECK (or ledger start). When
// epicKey is null, return all entries.
function sliceEpicWindow(entries, epicKey) {
  if (!epicKey) return entries;
  // Find the most recent state_transition into RETROSPECTIVE whose epic
  // matches. The ledger doesn't always carry epic_key explicitly; we
  // accept either entry.epic or entry.detail.epic_key.
  let endIdx = entries.length;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (!e) continue;
    if (e.kind === 'state_transition' && e.to === 'retrospective') {
      const detEpic = (e.detail && e.detail.epic_key) || e.epic;
      if (!detEpic || detEpic === epicKey) {
        endIdx = i + 1;
        break;
      }
    }
  }
  // Walk back to the previous epic_boundary_check (start of this epic),
  // skipping the closing one we just found.
  let startIdx = 0;
  for (let i = endIdx - 2; i >= 0; i -= 1) {
    const e = entries[i];
    if (!e) continue;
    if (e.kind === 'state_transition' && e.to === 'epic_boundary_check') {
      startIdx = i + 1;
      break;
    }
  }
  return entries.slice(startIdx, endIdx);
}

// renderMetricsMarkdown(metrics) — format the metrics object as a
// human-readable markdown block. The HTML comment tags are mandatory —
// they let appendMetricsSection() update in place idempotently.
function renderMetricsMarkdown(metrics) {
  const lines = [];
  lines.push(SECTION_TAG_OPEN);
  lines.push('## Sprint Health Metrics');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  if (metrics.epic_key) lines.push(`| Epic | \`${metrics.epic_key}\` |`);
  lines.push(`| Stories completed | ${metrics.stories_completed} |`);
  lines.push(`| Total actions emitted | ${metrics.total_actions} |`);
  lines.push(`| Halts | ${metrics.total_halts} |`);
  lines.push(`| Verify rejections | ${metrics.total_verify_rejections} |`);
  lines.push(`| Retries | ${metrics.total_retries}${metrics.retry_rate_per_story !== null ? ` (${metrics.retry_rate_per_story}/story)` : ''} |`);
  if (metrics.profile_escalations > 0) {
    lines.push(`| Profile escalations | ${metrics.profile_escalations} |`);
  }
  if (metrics.flaky_tests_recorded > 0 || metrics.flaky_tests_quarantined > 0) {
    lines.push(`| Flaky tests recorded | ${metrics.flaky_tests_recorded} |`);
    lines.push(`| Flaky tests auto-quarantined | ${metrics.flaky_tests_quarantined} |`);
  }
  const rd = metrics.review_depth_distribution || {};
  if ((rd.trivial || 0) + (rd.normal || 0) + (rd.structural || 0) > 0) {
    lines.push(`| Code reviews (trivial / normal / structural) | ${rd.trivial || 0} / ${rd.normal || 0} / ${rd.structural || 0} |`);
  }
  if (metrics.ledger_span_minutes !== null) {
    lines.push(`| Time window | ${metrics.ledger_span_minutes}m |`);
  }
  const avgKeys = Object.keys(metrics.average_phase_minutes || {});
  if (avgKeys.length > 0) {
    lines.push('');
    lines.push('### Average phase duration');
    lines.push('');
    lines.push('| Phase | Minutes |');
    lines.push('|---|---|');
    for (const k of avgKeys.sort()) {
      lines.push(`| ${k} | ${metrics.average_phase_minutes[k]} |`);
    }
  }
  lines.push('');
  lines.push('_Generated by Sprintpilot v2.5.0 from `_bmad-output/implementation-artifacts/ledger.jsonl`._');
  lines.push(SECTION_TAG_CLOSE);
  return lines.join('\n');
}

// appendMetricsSection(retroPath, metrics, fs?) — write the section
// idempotently. If the tagged block already exists, replace it.
// Otherwise append to EOF with a leading blank line for separation.
// Returns { written: true, mode: 'append' | 'replace' } on success.
function appendMetricsSection(retroPath, metrics, fs) {
  const f = fs || nodeFs;
  let existing = '';
  try {
    existing = f.readFileSync(retroPath, 'utf8');
  } catch (_e) {
    // No file → create with just the metrics block. The verify step
    // will catch a still-missing file via its existing artifact check.
    f.writeFileSync(retroPath, `${renderMetricsMarkdown(metrics)}\n`, 'utf8');
    return { written: true, mode: 'create' };
  }
  const openIdx = existing.indexOf(SECTION_TAG_OPEN);
  const closeIdx = existing.indexOf(SECTION_TAG_CLOSE);
  const rendered = renderMetricsMarkdown(metrics);
  if (openIdx >= 0 && closeIdx > openIdx) {
    const before = existing.slice(0, openIdx);
    const after = existing.slice(closeIdx + SECTION_TAG_CLOSE.length);
    const next = `${before}${rendered}${after}`;
    f.writeFileSync(retroPath, next, 'utf8');
    return { written: true, mode: 'replace' };
  }
  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  f.writeFileSync(retroPath, `${existing}${sep}${rendered}\n`, 'utf8');
  return { written: true, mode: 'append' };
}

module.exports = {
  computeMetrics,
  renderMetricsMarkdown,
  appendMetricsSection,
  sliceEpicWindow,
  SECTION_TAG_OPEN,
  SECTION_TAG_CLOSE,
};
