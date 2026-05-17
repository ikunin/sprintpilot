#!/usr/bin/env node

// summarize-timings.js — merge .timings/<story>.jsonl shards into a report.
//
// Usage:
//   summarize-timings.js [--project-root <path>] [--format text|json|md]
//                        [--session-only] [--quiet]
//
// Behavior:
//   Reads every .jsonl file under _bmad-output/implementation-artifacts/
//   .timings/. Two event shapes contribute to phase aggregates:
//     - start/end pairs (matched LIFO by (story, phase))
//     - duration records emitted by the `mark` API (already-paired)
//   Records flagged with `clock_skew` or `over_threshold` are excluded
//   from p50/p95/max so anomalies don't poison the distribution; they
//   are counted separately in the anomalies section.
//   Computes:
//     - Wall-clock per story (min-start to max-end)
//     - Per-phase aggregates: count, sum_ms, p50, p95, max
//     - Hotspots: phases whose sum_ms consumes > 5% of total paired time
//     - Anomalies: per-phase clock_skew / over_threshold counts
//
// Output:
//   --format text (default) → stdout, human-readable table
//   --format json           → stdout, JSON dump
//   --format md             → markdown; also written to an artifact:
//       default:          .timings/summary-<YYYY-MM-DD>.md
//       --session-only:   .timings/summary-session-<ISO-ts>.md
//
// Hotspot threshold is fixed at 5% per the PR 2 contract.

const fs = require('node:fs');
const path = require('node:path');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');

const HOTSPOT_THRESHOLD = 0.05;

function help() {
  log.out(
    [
      'Usage:',
      '  summarize-timings.js [--project-root <path>] [--format text|json|md]',
      '                       [--session-only] [--quiet]',
      '',
      'Defaults: --format text, reads cwd.',
      '  --session-only   Writes artifact as summary-session-<ts>.md.',
      '  --quiet          Suppresses stdout for md format (still writes artifact).',
    ].join('\n'),
  );
}

function timingsDir(projectRoot) {
  return path.join(projectRoot, '_bmad-output', 'implementation-artifacts', '.timings');
}

function readShards(projectRoot) {
  const dir = timingsDir(projectRoot);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const events = [];
  for (const f of files) {
    const full = path.join(dir, f);
    const raw = fs.readFileSync(full, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue; // skip corrupt lines rather than abort the summary
      }
      if (!obj || typeof obj !== 'object') continue;
      if (!obj.event || !obj.story || !obj.phase || !obj.ts) continue;
      const ms = Date.parse(obj.ts);
      if (Number.isNaN(ms)) continue;
      events.push({ ...obj, _ms: ms });
    }
  }
  // Stable sort by timestamp so pairing is deterministic.
  events.sort((a, b) => a._ms - b._ms);
  return events;
}

function pairEvents(events) {
  // Returns { stories: { [story]: { first, last, phases: { [phase]: number[] } } },
  //           phaseAgg: { [phase]: number[] },
  //           onceCount: { [phase]: number },
  //           anomalies: { [phase]: { clock_skew: number, over_threshold: number } },
  //           orphans: [{story, phase, event, ts}] }
  const stories = {};
  const phaseAgg = {};
  const onceCount = {};
  const anomalies = {};
  const openByStoryPhase = {}; // key = story::phase → stack of start ms

  const ensureStory = (s) => {
    if (!stories[s]) stories[s] = { first: null, last: null, phases: {} };
    return stories[s];
  };
  const recordAnomaly = (phase, kind) => {
    if (!anomalies[phase]) anomalies[phase] = { clock_skew: 0, over_threshold: 0 };
    anomalies[phase][kind] += 1;
  };
  const recordDuration = (s, phase, duration) => {
    if (!s.phases[phase]) s.phases[phase] = [];
    s.phases[phase].push(duration);
    if (!phaseAgg[phase]) phaseAgg[phase] = [];
    phaseAgg[phase].push(duration);
  };

  for (const ev of events) {
    const s = ensureStory(ev.story);
    if (s.first === null || ev._ms < s.first) s.first = ev._ms;
    if (s.last === null || ev._ms > s.last) s.last = ev._ms;

    if (ev.event === 'once') {
      onceCount[ev.phase] = (onceCount[ev.phase] || 0) + 1;
      continue;
    }
    const key = `${ev.story}::${ev.phase}`;
    if (ev.event === 'start') {
      if (!openByStoryPhase[key]) openByStoryPhase[key] = [];
      openByStoryPhase[key].push(ev._ms);
      continue;
    }
    if (ev.event === 'end') {
      const stack = openByStoryPhase[key];
      if (!stack || stack.length === 0) continue; // orphan end — skip
      const startMs = stack.pop();
      const duration = ev._ms - startMs;
      if (duration < 0) continue;
      recordDuration(s, ev.phase, duration);
      continue;
    }
    if (ev.event === 'duration') {
      // mark-API records arrive already paired. Anomalous records
      // (clock_skew / over_threshold) are tallied separately and never
      // contribute to p50/p95/max — otherwise a single backstep or
      // stale marker would poison the aggregates. duration_ms must be
      // a finite non-negative number; defensive against hand-edited shards.
      //
      // Truthy comparison (not `=== true`) so a hand-edited shard with
      // `clock_skew: 1` or any other truthy value is still recognized
      // as an anomaly — symmetric with the defensive number check
      // below.
      //
      // Mutually exclusive tally: per markPhase's contract, one record
      // can only carry ONE flag (rawDelta is either negative OR exceeds
      // the ceiling, never both). If a hand-edited shard carries both,
      // we count clock_skew first since "the clock did something
      // weird" subsumes "duration looked too long".
      const skew = Boolean(ev.clock_skew);
      const over = Boolean(ev.over_threshold);
      if (skew) recordAnomaly(ev.phase, 'clock_skew');
      else if (over) recordAnomaly(ev.phase, 'over_threshold');
      if (skew || over) continue;
      const d = ev.duration_ms;
      if (typeof d !== 'number' || !Number.isFinite(d) || d < 0) continue;
      // Wall-clock attribution: a duration record's `_ms` is the time
      // the phase ENDED (when markPhase emitted the record). To make
      // per-story `wall_ms` meaningful for mark-only stories, expand
      // `s.first` backward by the recorded duration so `first` reflects
      // the actual phase start. Without this, a story with a single
      // mark record has `wall_ms = 0`.
      const phaseStart = ev._ms - d;
      if (s.first === null || phaseStart < s.first) s.first = phaseStart;
      recordDuration(s, ev.phase, d);
    }
  }

  const orphans = [];
  for (const key of Object.keys(openByStoryPhase)) {
    const [story, phase] = key.split('::');
    for (const startMs of openByStoryPhase[key]) {
      orphans.push({
        story,
        phase,
        event: 'start-without-end',
        ts: new Date(startMs).toISOString(),
      });
    }
  }

  return { stories, phaseAgg, onceCount, anomalies, orphans };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  // Nearest-rank; fine for our small N.
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function aggregate(paired) {
  const phases = Object.keys(paired.phaseAgg).sort();
  const rows = phases.map((phase) => {
    const durations = [...paired.phaseAgg[phase]].sort((a, b) => a - b);
    const sum = durations.reduce((acc, v) => acc + v, 0);
    return {
      phase,
      count: durations.length,
      sum_ms: sum,
      p50_ms: percentile(durations, 50),
      p95_ms: percentile(durations, 95),
      max_ms: durations[durations.length - 1],
    };
  });
  const totalPaired = rows.reduce((acc, r) => acc + r.sum_ms, 0);
  const withPct = rows.map((r) => ({
    ...r,
    pct_of_total: totalPaired > 0 ? r.sum_ms / totalPaired : 0,
  }));
  withPct.sort((a, b) => b.sum_ms - a.sum_ms);
  const hotspots = withPct.filter((r) => r.pct_of_total > HOTSPOT_THRESHOLD);

  const stories = Object.keys(paired.stories)
    .sort()
    .map((key) => {
      const s = paired.stories[key];
      const wall_ms = s.first !== null && s.last !== null ? s.last - s.first : 0;
      const phaseSum = Object.values(s.phases)
        .flat()
        .reduce((acc, v) => acc + v, 0);
      return {
        story: key,
        wall_ms,
        phase_sum_ms: phaseSum,
        phase_count: Object.keys(s.phases).length,
      };
    });

  return {
    total_paired_ms: totalPaired,
    phases: withPct,
    hotspots,
    stories,
    once_markers: paired.onceCount,
    anomalies: paired.anomalies,
    orphans: paired.orphans,
  };
}

function fmtMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function fmtPct(p) {
  return `${(p * 100).toFixed(1)}%`;
}

function renderText(report) {
  const lines = [];
  lines.push('Sprintpilot phase-timing summary');
  lines.push(`Total paired phase time: ${fmtMs(report.total_paired_ms)}`);
  lines.push('');
  lines.push('Per-story wall-clock:');
  if (report.stories.length === 0) {
    lines.push('  (no data)');
  } else {
    for (const s of report.stories) {
      lines.push(
        `  ${s.story}  wall=${fmtMs(s.wall_ms)}  phase-sum=${fmtMs(s.phase_sum_ms)}  phases=${s.phase_count}`,
      );
    }
  }
  lines.push('');
  lines.push('Phase aggregates (sorted by sum):');
  if (report.phases.length === 0) {
    lines.push('  (no paired start/end events)');
  } else {
    lines.push(
      '  phase                                    count    sum     p50     p95     max    %',
    );
    for (const r of report.phases) {
      lines.push(
        `  ${r.phase.padEnd(40)} ${String(r.count).padStart(5)}  ${fmtMs(r.sum_ms).padStart(6)}  ${fmtMs(r.p50_ms).padStart(6)}  ${fmtMs(r.p95_ms).padStart(6)}  ${fmtMs(r.max_ms).padStart(6)}  ${fmtPct(r.pct_of_total).padStart(6)}`,
      );
    }
  }
  lines.push('');
  if (report.hotspots.length > 0) {
    lines.push(`Hotspots (> ${HOTSPOT_THRESHOLD * 100}% of total):`);
    for (const h of report.hotspots) {
      lines.push(`  ${h.phase}  ${fmtPct(h.pct_of_total)}  ${fmtMs(h.sum_ms)}`);
    }
  } else {
    lines.push('Hotspots: none above threshold');
  }
  if (Object.keys(report.once_markers).length > 0) {
    lines.push('');
    lines.push('Once markers:');
    for (const [phase, count] of Object.entries(report.once_markers)) {
      lines.push(`  ${phase}  ×${count}`);
    }
  }
  const anomalyEntries = Object.entries(report.anomalies || {});
  if (anomalyEntries.length > 0) {
    lines.push('');
    lines.push('Anomalies (excluded from p50/p95/max):');
    for (const [phase, counts] of anomalyEntries) {
      const parts = [];
      if (counts.clock_skew > 0) parts.push(`clock_skew ×${counts.clock_skew}`);
      if (counts.over_threshold > 0) parts.push(`over_threshold ×${counts.over_threshold}`);
      lines.push(`  ${phase}  ${parts.join('  ')}`);
    }
  }
  if (report.orphans.length > 0) {
    lines.push('');
    lines.push(`Orphaned starts (no matching end): ${report.orphans.length}`);
  }
  return `${lines.join('\n')}\n`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Sprintpilot phase-timing summary');
  lines.push('');
  lines.push(`**Total paired phase time:** ${fmtMs(report.total_paired_ms)}`);
  lines.push('');
  lines.push('## Per-story wall-clock');
  lines.push('');
  if (report.stories.length === 0) {
    lines.push('_No data._');
  } else {
    lines.push('| Story | Wall | Phase sum | # phases |');
    lines.push('|---|---|---|---|');
    for (const s of report.stories) {
      lines.push(
        `| ${s.story} | ${fmtMs(s.wall_ms)} | ${fmtMs(s.phase_sum_ms)} | ${s.phase_count} |`,
      );
    }
  }
  lines.push('');
  lines.push('## Phase aggregates');
  lines.push('');
  if (report.phases.length === 0) {
    lines.push('_No paired start/end events._');
  } else {
    lines.push('| Phase | Count | Sum | p50 | p95 | Max | % total |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|');
    for (const r of report.phases) {
      lines.push(
        `| \`${r.phase}\` | ${r.count} | ${fmtMs(r.sum_ms)} | ${fmtMs(r.p50_ms)} | ${fmtMs(r.p95_ms)} | ${fmtMs(r.max_ms)} | ${fmtPct(r.pct_of_total)} |`,
      );
    }
  }
  lines.push('');
  lines.push(`## Hotspots (> ${HOTSPOT_THRESHOLD * 100}% of total)`);
  lines.push('');
  if (report.hotspots.length === 0) {
    lines.push('_None above threshold._');
  } else {
    for (const h of report.hotspots) {
      lines.push(`- \`${h.phase}\` — ${fmtPct(h.pct_of_total)} (${fmtMs(h.sum_ms)})`);
    }
  }
  if (Object.keys(report.once_markers).length > 0) {
    lines.push('');
    lines.push('## Once markers');
    lines.push('');
    for (const [phase, count] of Object.entries(report.once_markers)) {
      lines.push(`- \`${phase}\` ×${count}`);
    }
  }
  const mdAnomalyEntries = Object.entries(report.anomalies || {}).filter(
    ([, c]) => c.clock_skew > 0 || c.over_threshold > 0,
  );
  if (mdAnomalyEntries.length > 0) {
    lines.push('');
    lines.push('## Anomalies');
    lines.push('');
    lines.push(
      "_Excluded from p50/p95/max so a single skew/stale-marker doesn't poison aggregates._",
    );
    lines.push('');
    lines.push('| Phase | clock_skew | over_threshold |');
    lines.push('|---|---:|---:|');
    for (const [phase, counts] of mdAnomalyEntries) {
      lines.push(`| \`${phase}\` | ${counts.clock_skew} | ${counts.over_threshold} |`);
    }
  }
  if (report.orphans.length > 0) {
    lines.push('');
    lines.push(`_Orphaned starts (no matching end): ${report.orphans.length}_`);
  }
  return `${lines.join('\n')}\n`;
}

function artifactPath(projectRoot, sessionOnly) {
  const dir = timingsDir(projectRoot);
  if (sessionOnly) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(dir, `summary-session-${ts}.md`);
  }
  const date = new Date().toISOString().slice(0, 10);
  return path.join(dir, `summary-${date}.md`);
}

function main() {
  const { opts } = parseArgs(process.argv.slice(2), { booleanFlags: ['session-only', 'quiet'] });
  if (opts.help) {
    help();
    process.exit(0);
  }
  const projectRoot = opts['project-root'] || process.cwd();
  const format = opts.format || 'text';
  const sessionOnly = opts['session-only'] === true;
  const quiet = opts.quiet === true;

  const events = readShards(projectRoot);
  const paired = pairEvents(events);
  const report = aggregate(paired);

  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (format === 'md') {
    const body = renderMarkdown(report);
    const out = artifactPath(projectRoot, sessionOnly);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, body);
    if (!quiet) process.stdout.write(`${body}\nWrote: ${out}\n`);
    else process.stdout.write(`${out}\n`);
    return;
  }
  if (format === 'text') {
    process.stdout.write(renderText(report));
    return;
  }
  log.error(`unknown --format '${format}'. Valid: text, json, md`);
  process.exit(1);
}

module.exports = {
  HOTSPOT_THRESHOLD,
  timingsDir,
  readShards,
  pairEvents,
  aggregate,
  percentile,
  renderText,
  renderMarkdown,
  artifactPath,
  fmtMs,
  fmtPct,
};

if (require.main === module) {
  main();
}
