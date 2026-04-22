import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
    stories: Record<string, { first: number | null; last: number | null; phases: Record<string, number[]> }>;
    phaseAgg: Record<string, number[]>;
    onceCount: Record<string, number>;
    orphans: Array<{ story: string; phase: string }>;
  };
  aggregate: (paired: ReturnType<typeof pairEvents>) => {
    total_paired_ms: number;
    phases: Array<{ phase: string; count: number; sum_ms: number; p50_ms: number; p95_ms: number; max_ms: number; pct_of_total: number }>;
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
