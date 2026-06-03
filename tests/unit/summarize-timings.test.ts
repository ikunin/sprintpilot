import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import summarizeMod from '../../_Sprintpilot/scripts/summarize-timings.js';

const {
  HOTSPOT_THRESHOLD,
  timingsDir,
  readShards,
  pairEvents,
  aggregate,
  percentile,
  renderText,
  renderMarkdown,
  artifactPath,
} = summarizeMod as {
  HOTSPOT_THRESHOLD: number;
  timingsDir: (root: string) => string;
  readShards: (root: string) => Array<Record<string, unknown>>;
  pairEvents: (events: unknown[]) => {
    stories: Record<
      string,
      { first: number | null; last: number | null; phases: Record<string, number[]> }
    >;
    phaseAgg: Record<string, number[]>;
    onceCount: Record<string, number>;
    orphans: Array<{ story: string; phase: string }>;
  };
  aggregate: (paired: ReturnType<typeof pairEvents>) => {
    total_paired_ms: number;
    phases: Array<{
      phase: string;
      count: number;
      sum_ms: number;
      p50_ms: number;
      p95_ms: number;
      max_ms: number;
      pct_of_total: number;
    }>;
    hotspots: Array<{ phase: string; pct_of_total: number }>;
    stories: Array<{ story: string; wall_ms: number }>;
    once_markers: Record<string, number>;
    orphans: unknown[];
  };
  percentile: (sorted: number[], p: number) => number;
  renderText: (report: unknown) => string;
  renderMarkdown: (report: unknown) => string;
  artifactPath: (root: string, sessionOnly?: boolean) => string;
};

let tmpRoot = '';

function seedShard(root: string, story: string, lines: Array<Record<string, unknown>>) {
  const dir = timingsDir(root);
  mkdirSync(dir, { recursive: true });
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  writeFileSync(join(dir, `${story}.jsonl`), body);
}

beforeEach(() => {
  tmpRoot = '';
});
afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe('percentile', () => {
  it('returns 0 on empty input', () => {
    expect(percentile([], 50)).toBe(0);
  });
  it('returns the single value when N=1', () => {
    expect(percentile([42], 95)).toBe(42);
  });
  it('picks nearest-rank', () => {
    // 10 values; p95 → index 9 → 100.
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 95)).toBe(100);
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 50)).toBe(50);
  });
});

describe('pairEvents', () => {
  it('pairs start/end within the same story+phase', () => {
    const events = [
      { event: 'start', story: 'a', phase: 'p1', _ms: 1000 },
      { event: 'end', story: 'a', phase: 'p1', _ms: 1500 },
      { event: 'start', story: 'a', phase: 'p2', _ms: 1500 },
      { event: 'end', story: 'a', phase: 'p2', _ms: 2000 },
    ];
    const p = pairEvents(events);
    expect(p.phaseAgg.p1).toEqual([500]);
    expect(p.phaseAgg.p2).toEqual([500]);
    expect(p.stories.a.first).toBe(1000);
    expect(p.stories.a.last).toBe(2000);
  });

  it('keeps stories isolated', () => {
    const events = [
      { event: 'start', story: 'a', phase: 'p', _ms: 1000 },
      { event: 'start', story: 'b', phase: 'p', _ms: 1010 },
      { event: 'end', story: 'b', phase: 'p', _ms: 1030 },
      { event: 'end', story: 'a', phase: 'p', _ms: 1500 },
    ];
    const p = pairEvents(events);
    expect(p.phaseAgg.p).toEqual([20, 500]);
    expect(p.stories.a.phases.p).toEqual([500]);
    expect(p.stories.b.phases.p).toEqual([20]);
  });

  it('counts once-markers and flags orphaned starts', () => {
    const events = [
      { event: 'once', story: 'a', phase: 'marker', _ms: 100 },
      { event: 'once', story: 'a', phase: 'marker', _ms: 200 },
      { event: 'start', story: 'a', phase: 'never-ends', _ms: 300 },
    ];
    const p = pairEvents(events);
    expect(p.onceCount.marker).toBe(2);
    expect(p.orphans.length).toBe(1);
    expect(p.orphans[0].phase).toBe('never-ends');
  });

  it('drops negative or out-of-order pairs safely', () => {
    const events = [
      { event: 'end', story: 'a', phase: 'p', _ms: 1000 },
      { event: 'start', story: 'a', phase: 'p', _ms: 2000 },
      { event: 'end', story: 'a', phase: 'p', _ms: 2500 },
    ];
    const p = pairEvents(events);
    expect(p.phaseAgg.p).toEqual([500]);
  });

  it('ingests `duration` events from the mark API into phase aggregates', () => {
    // The `mark` API (log-timing.js markPhase) emits already-paired
    // duration records. Pre-2.0.8 these were silently dropped because
    // pairEvents only handled start/end/once — meaning the entire
    // mark-API output (workflow.md skill markers, auto-emit from
    // infer-deps / mark-done / inject-tasks) contributed zero to the
    // hotspot report. Now they're treated as a paired record.
    const events = [
      { event: 'duration', story: 's', phase: 'mark-phase', duration_ms: 1500, _ms: 1000 },
      { event: 'duration', story: 's', phase: 'mark-phase', duration_ms: 700, _ms: 2000 },
    ];
    const p = pairEvents(events);
    expect(p.phaseAgg['mark-phase']).toEqual([1500, 700]);
    expect(p.stories.s.phases['mark-phase']).toEqual([1500, 700]);
  });

  it('excludes anomaly records (clock_skew / over_threshold) from aggregates and counts them separately', () => {
    // Anomalous records pollute p50/p95/max if folded in — that's the
    // entire reason the flags exist. They are tracked in a parallel
    // map and surfaced in the report's anomalies section.
    const events = [
      { event: 'duration', story: 's', phase: 'p', duration_ms: 100, _ms: 1000 },
      { event: 'duration', story: 's', phase: 'p', duration_ms: 0, clock_skew: true, _ms: 2000 },
      {
        event: 'duration',
        story: 's',
        phase: 'p',
        duration_ms: 0,
        over_threshold: true,
        _ms: 3000,
      },
      { event: 'duration', story: 's', phase: 'p', duration_ms: 200, _ms: 4000 },
    ];
    const p = pairEvents(events);
    expect(p.phaseAgg.p).toEqual([100, 200]);
    expect(p.anomalies.p).toEqual({ clock_skew: 1, over_threshold: 1 });
  });

  it('rejects malformed `duration` records (non-finite, negative, missing duration_ms)', () => {
    const events = [
      { event: 'duration', story: 's', phase: 'p', duration_ms: -1, _ms: 1000 },
      { event: 'duration', story: 's', phase: 'p', duration_ms: 'not-a-number', _ms: 2000 },
      { event: 'duration', story: 's', phase: 'p', _ms: 3000 }, // missing duration_ms
      { event: 'duration', story: 's', phase: 'p', duration_ms: 100, _ms: 4000 }, // valid
    ];
    const p = pairEvents(events);
    expect(p.phaseAgg.p).toEqual([100]);
    expect(p.anomalies.p).toBeUndefined();
  });

  it('expands wall-clock backward for mark-API duration records (s.first uses ev._ms - duration_ms)', () => {
    // A story with only mark-API records should report a meaningful
    // wall_ms. Pre-fix: s.first = ev._ms (the emit time = phase end),
    // so wall_ms collapsed to (last_emit - first_emit), missing phase 1.
    // Now: ingesting a duration record expands s.first backward by
    // the duration so it reflects the actual phase start.
    const events = [
      // single duration record, phase ran 1s before being emitted at t=2000
      { event: 'duration', story: 's-mark-only', phase: 'p', duration_ms: 1000, _ms: 2000 },
    ];
    const p = pairEvents(events);
    // first = 2000 - 1000 = 1000; last = 2000; wall = 1000
    expect(p.stories['s-mark-only'].first).toBe(1000);
    expect(p.stories['s-mark-only'].last).toBe(2000);
  });

  it('hand-edited dual-flag record tallies clock_skew once (mutually exclusive — clock_skew wins)', () => {
    // The mark API NEVER emits both flags on one record (rawDelta can
    // be negative XOR over-ceiling, never both). But a hand-edited
    // shard could carry both — pairEvents must not double-tally the
    // same record across the two anomaly counters. clock_skew wins
    // ("the clock did something weird" subsumes "duration looked too
    // long").
    const events = [
      {
        event: 'duration',
        story: 's',
        phase: 'p',
        duration_ms: 0,
        clock_skew: true,
        over_threshold: true,
        _ms: 1000,
      },
    ];
    const p = pairEvents(events);
    expect(p.anomalies.p).toEqual({ clock_skew: 1, over_threshold: 0 });
  });

  it('accepts truthy non-boolean flag values from hand-edited shards (defense-in-depth)', () => {
    // YAML round-trips and copy-paste can turn `clock_skew: true` into
    // `1`, "true", or other truthy values. Those should still be
    // recognized as anomalies — symmetric with the rest of the
    // defensive validation. `=== true` strict comparison would silently
    // let the malformed record poison p50/p95/max.
    const events = [
      {
        event: 'duration',
        story: 's',
        phase: 'p',
        duration_ms: 9_999_999,
        clock_skew: 1,
        _ms: 1000,
      },
      {
        event: 'duration',
        story: 's',
        phase: 'p',
        duration_ms: 9_999_999,
        over_threshold: 'yes',
        _ms: 2000,
      },
      { event: 'duration', story: 's', phase: 'p', duration_ms: 100, _ms: 3000 }, // valid baseline
    ];
    const p = pairEvents(events);
    expect(p.phaseAgg.p).toEqual([100]); // anomalies excluded
    expect(p.anomalies.p).toEqual({ clock_skew: 1, over_threshold: 1 });
  });
});

describe('aggregate', () => {
  it('computes hotspots above the 5% threshold', () => {
    expect(HOTSPOT_THRESHOLD).toBe(0.05);
    const paired = pairEvents([
      // hot: 10s
      { event: 'start', story: 's', phase: 'hot', _ms: 0 },
      { event: 'end', story: 's', phase: 'hot', _ms: 10_000 },
      // cold: 100ms (< 5% of 10.1s total)
      { event: 'start', story: 's', phase: 'cold', _ms: 10_000 },
      { event: 'end', story: 's', phase: 'cold', _ms: 10_100 },
    ]);
    const r = aggregate(paired);
    expect(r.total_paired_ms).toBe(10_100);
    expect(r.hotspots.map((h) => h.phase)).toEqual(['hot']);
  });

  it('sorts phases by sum descending', () => {
    const paired = pairEvents([
      { event: 'start', story: 's', phase: 'b', _ms: 0 },
      { event: 'end', story: 's', phase: 'b', _ms: 1_000 },
      { event: 'start', story: 's', phase: 'a', _ms: 1_000 },
      { event: 'end', story: 's', phase: 'a', _ms: 5_000 },
    ]);
    const r = aggregate(paired);
    expect(r.phases[0].phase).toBe('a');
    expect(r.phases[1].phase).toBe('b');
  });

  it('handles zero paired events without dividing by zero', () => {
    const paired = pairEvents([]);
    const r = aggregate(paired);
    expect(r.total_paired_ms).toBe(0);
    expect(r.phases).toEqual([]);
    expect(r.hotspots).toEqual([]);
  });
});

describe('readShards', () => {
  it('returns [] when the .timings dir is absent', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sp-sum-empty-'));
    expect(readShards(tmpRoot)).toEqual([]);
  });

  it('reads, parses, and sorts events by timestamp', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sp-sum-'));
    seedShard(tmpRoot, 's1', [
      { event: 'start', story: 's1', phase: 'p', ts: '2026-04-23T00:00:02.000Z' },
      { event: 'end', story: 's1', phase: 'p', ts: '2026-04-23T00:00:01.000Z' }, // out of order
    ]);
    const evs = readShards(tmpRoot);
    expect(evs.length).toBe(2);
    expect((evs[0] as { event: string }).event).toBe('end'); // sorted by ts ascending
  });

  it('skips corrupt JSON lines without aborting', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sp-sum-corrupt-'));
    const dir = timingsDir(tmpRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 's.jsonl'),
      [
        '{not json',
        JSON.stringify({ event: 'start', story: 's', phase: 'p', ts: '2026-04-23T00:00:00.000Z' }),
      ].join('\n') + '\n',
    );
    const evs = readShards(tmpRoot);
    expect(evs.length).toBe(1);
  });
});

describe('renderers', () => {
  const paired = pairEvents([
    { event: 'start', story: 's', phase: 'p', _ms: 0 },
    { event: 'end', story: 's', phase: 'p', _ms: 1000 },
  ]);
  const report = aggregate(paired);

  it('renderText emits a readable summary', () => {
    const out = renderText(report);
    expect(out).toContain('Sprintpilot phase-timing summary');
    expect(out).toContain('p');
    expect(out).toContain('1.0s');
  });

  it('renderMarkdown emits a markdown document', () => {
    const out = renderMarkdown(report);
    expect(out).toMatch(/^# Sprintpilot phase-timing summary/);
    expect(out).toContain('| Phase |');
  });

  it('renders an anomalies section when clock_skew or over_threshold records are present', () => {
    const pairedAnomaly = pairEvents([
      { event: 'duration', story: 's', phase: 'p', duration_ms: 100, _ms: 1000 },
      { event: 'duration', story: 's', phase: 'p', duration_ms: 0, clock_skew: true, _ms: 2000 },
      {
        event: 'duration',
        story: 's',
        phase: 'p',
        duration_ms: 0,
        over_threshold: true,
        _ms: 3000,
      },
    ]);
    const reportAnomaly = aggregate(pairedAnomaly);
    const text = renderText(reportAnomaly);
    expect(text).toContain('Anomalies');
    expect(text).toContain('clock_skew ×1');
    expect(text).toContain('over_threshold ×1');
    const md = renderMarkdown(reportAnomaly);
    expect(md).toContain('## Anomalies');
    expect(md).toContain('| `p` | 1 | 1 |');
  });
});

describe('artifactPath', () => {
  it('uses date for full reports', () => {
    const p = artifactPath('/root', false);
    expect(p).toMatch(/summary-\d{4}-\d{2}-\d{2}\.md$/);
  });
  it('uses iso-ts for session-only reports', () => {
    const p = artifactPath('/root', true);
    expect(p).toMatch(/summary-session-.*\.md$/);
  });
});
