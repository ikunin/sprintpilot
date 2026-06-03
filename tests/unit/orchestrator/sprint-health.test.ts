import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import sprintHealth from '../../../_Sprintpilot/lib/orchestrator/sprint-health.js';

type LedgerEntry = Record<string, unknown>;
type Metrics = Record<string, unknown>;

const {
  computeMetrics,
  renderMetricsMarkdown,
  appendMetricsSection,
  sliceEpicWindow,
  SECTION_TAG_OPEN,
  SECTION_TAG_CLOSE,
} = sprintHealth as {
  computeMetrics: (entries: LedgerEntry[], opts?: { epicKey?: string }) => Metrics;
  renderMetricsMarkdown: (metrics: Metrics) => string;
  appendMetricsSection: (
    retroPath: string,
    metrics: Metrics,
  ) => { written: true; mode: 'append' | 'replace' | 'create' };
  sliceEpicWindow: (entries: LedgerEntry[], epicKey: string | null) => LedgerEntry[];
  SECTION_TAG_OPEN: string;
  SECTION_TAG_CLOSE: string;
};

let tmpRoot = '';
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-health-'));
});
afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const minutesBefore = (ts: string, n: number) =>
  new Date(Date.parse(ts) - n * 60_000).toISOString();

const T_NOW = '2026-06-01T12:00:00.000Z';

describe('computeMetrics', () => {
  it('returns zeros for an empty ledger', () => {
    const m = computeMetrics([]);
    expect(m).toMatchObject({
      stories_completed: 0,
      total_actions: 0,
      total_halts: 0,
      total_verify_rejections: 0,
      total_retries: 0,
    });
  });

  it('counts actions, halts, retries, story completions', () => {
    const entries: LedgerEntry[] = [
      {
        seq: 1,
        ts: minutesBefore(T_NOW, 60),
        kind: 'action_emitted',
        action: { type: 'invoke_skill', skill: 'bmad-dev-story' },
      },
      {
        seq: 2,
        ts: minutesBefore(T_NOW, 50),
        kind: 'state_transition',
        from: 'dev_green',
        to: 'code_review',
        verdict: 'advanced',
      },
      {
        seq: 3,
        ts: minutesBefore(T_NOW, 45),
        kind: 'state_transition',
        from: 'code_review',
        to: 'code_review',
        verdict: 'retry',
      },
      {
        seq: 4,
        ts: minutesBefore(T_NOW, 30),
        kind: 'state_transition',
        from: 'story_done',
        to: 'epic_boundary_check',
        verdict: 'advanced',
      },
      {
        seq: 5,
        ts: minutesBefore(T_NOW, 20),
        kind: 'halt',
        phase: 'dev_green',
        reason: 'phase_timeout_exceeded',
      },
      { seq: 6, ts: minutesBefore(T_NOW, 10), kind: 'verify_rejected', phase: 'dev_green' },
    ];
    const m = computeMetrics(entries);
    expect(m.total_actions).toBe(1);
    expect(m.stories_completed).toBe(1);
    expect(m.total_retries).toBe(1);
    expect(m.total_halts).toBe(1);
    expect(m.total_verify_rejections).toBe(1);
  });

  it('counts review_depth_decision into distribution', () => {
    const entries: LedgerEntry[] = [
      { seq: 1, ts: T_NOW, kind: 'review_depth_decision', detail: { size: 'trivial' } },
      { seq: 2, ts: T_NOW, kind: 'review_depth_decision', detail: { size: 'normal' } },
      { seq: 3, ts: T_NOW, kind: 'review_depth_decision', detail: { size: 'normal' } },
      { seq: 4, ts: T_NOW, kind: 'review_depth_decision', detail: { size: 'structural' } },
    ];
    const m = computeMetrics(entries) as { review_depth_distribution: Record<string, number> };
    expect(m.review_depth_distribution).toEqual({ trivial: 1, normal: 2, structural: 1 });
  });

  it('counts flaky-tests recorded and quarantined from state_transition details', () => {
    const entries: LedgerEntry[] = [
      {
        seq: 1,
        ts: T_NOW,
        kind: 'state_transition',
        detail: { flaky_recorded: ['a', 'b'], newly_quarantined: [] },
      },
      {
        seq: 2,
        ts: T_NOW,
        kind: 'state_transition',
        detail: { flaky_recorded: ['c'], newly_quarantined: ['c'] },
      },
    ];
    const m = computeMetrics(entries) as {
      flaky_tests_recorded: number;
      flaky_tests_quarantined: number;
    };
    expect(m.flaky_tests_recorded).toBe(3);
    expect(m.flaky_tests_quarantined).toBe(1);
  });

  it('computes average phase duration from successive state_transitions', () => {
    const entries: LedgerEntry[] = [
      {
        seq: 1,
        ts: minutesBefore(T_NOW, 30),
        kind: 'state_transition',
        from: 'check_readiness',
        to: 'dev_red',
        verdict: 'advanced',
      },
      {
        seq: 2,
        ts: minutesBefore(T_NOW, 25),
        kind: 'state_transition',
        from: 'dev_red',
        to: 'dev_green',
        verdict: 'advanced',
      },
      {
        seq: 3,
        ts: minutesBefore(T_NOW, 15),
        kind: 'state_transition',
        from: 'dev_green',
        to: 'code_review',
        verdict: 'advanced',
      },
    ];
    const m = computeMetrics(entries) as { average_phase_minutes: Record<string, number> };
    // dev_red entered at T-30, dev_green entered at T-25 → 5 minute duration in dev_red
    expect(m.average_phase_minutes.dev_red).toBeCloseTo(5, 1);
    // dev_green entered at T-25, code_review at T-15 → 10 minute duration in dev_green
    expect(m.average_phase_minutes.dev_green).toBeCloseTo(10, 1);
  });

  it('retry_rate_per_story is null when no stories completed', () => {
    const entries: LedgerEntry[] = [
      { seq: 1, ts: T_NOW, kind: 'state_transition', from: 'x', to: 'y', verdict: 'retry' },
    ];
    const m = computeMetrics(entries) as { retry_rate_per_story: number | null };
    expect(m.retry_rate_per_story).toBeNull();
  });

  it('retry_rate_per_story computes when stories completed', () => {
    const entries: LedgerEntry[] = [
      { seq: 1, ts: T_NOW, kind: 'state_transition', from: 'x', to: 'y', verdict: 'retry' },
      { seq: 2, ts: T_NOW, kind: 'state_transition', from: 'x', to: 'y', verdict: 'retry' },
      {
        seq: 3,
        ts: T_NOW,
        kind: 'state_transition',
        from: 'story_done',
        to: 'epic_boundary_check',
        verdict: 'advanced',
      },
    ];
    const m = computeMetrics(entries) as { retry_rate_per_story: number };
    expect(m.retry_rate_per_story).toBe(2);
  });

  it('ignores impossibly long phase gaps (sanity cap)', () => {
    const entries: LedgerEntry[] = [
      {
        seq: 1,
        ts: '2026-06-01T12:00:00.000Z',
        kind: 'state_transition',
        from: '_',
        to: 'dev_red',
        verdict: 'advanced',
      },
      // 8 hours later — way beyond the 4h cap. Should be dropped.
      {
        seq: 2,
        ts: '2026-06-01T20:00:00.000Z',
        kind: 'state_transition',
        from: 'dev_red',
        to: 'dev_green',
        verdict: 'advanced',
      },
    ];
    const m = computeMetrics(entries) as { average_phase_minutes: Record<string, number> };
    expect(m.average_phase_minutes.dev_red).toBeUndefined();
  });
});

describe('sliceEpicWindow', () => {
  it('returns all entries when epicKey is null', () => {
    const entries: LedgerEntry[] = [
      { seq: 1, ts: T_NOW, kind: 'state_transition' },
      { seq: 2, ts: T_NOW, kind: 'state_transition' },
    ];
    expect(sliceEpicWindow(entries, null)).toHaveLength(2);
  });

  it('slices entries between consecutive epic_boundary_check events', () => {
    const entries: LedgerEntry[] = [
      {
        seq: 1,
        ts: '2026-06-01T10:00:00.000Z',
        kind: 'state_transition',
        to: 'epic_boundary_check',
      },
      { seq: 2, ts: '2026-06-01T10:05:00.000Z', kind: 'action_emitted' },
      {
        seq: 3,
        ts: '2026-06-01T10:10:00.000Z',
        kind: 'state_transition',
        to: 'retrospective',
        detail: { epic_key: 'E1' },
      },
    ];
    const w = sliceEpicWindow(entries, 'E1');
    // Should include seq 2 and seq 3, but not seq 1 (that closed the prior epic).
    expect(w.map((e) => e.seq)).toEqual([2, 3]);
  });
});

describe('renderMetricsMarkdown', () => {
  it('emits the section tags so the writer can update in place', () => {
    const md = renderMetricsMarkdown({
      stories_completed: 3,
      total_actions: 50,
      total_halts: 0,
      total_verify_rejections: 0,
      total_retries: 1,
      retry_rate_per_story: 0.3,
      review_depth_distribution: {},
      average_phase_minutes: {},
      ledger_span_minutes: null,
    } as Metrics);
    expect(md).toContain(SECTION_TAG_OPEN);
    expect(md).toContain(SECTION_TAG_CLOSE);
    expect(md).toContain('## Sprint Health Metrics');
    expect(md).toContain('Stories completed | 3');
  });

  it('omits review-depth row when distribution is all zero', () => {
    const md = renderMetricsMarkdown({
      stories_completed: 1,
      total_actions: 0,
      total_halts: 0,
      total_verify_rejections: 0,
      total_retries: 0,
      retry_rate_per_story: null,
      review_depth_distribution: { trivial: 0, normal: 0, structural: 0 },
      average_phase_minutes: {},
      ledger_span_minutes: null,
    } as Metrics);
    expect(md).not.toContain('Code reviews');
  });
});

describe('appendMetricsSection', () => {
  const sampleMetrics: Metrics = {
    epic_key: 'E1',
    stories_completed: 2,
    total_actions: 10,
    total_halts: 1,
    total_verify_rejections: 0,
    total_retries: 0,
    retry_rate_per_story: 0,
    profile_escalations: 0,
    flaky_tests_recorded: 0,
    flaky_tests_quarantined: 0,
    review_depth_distribution: { trivial: 0, normal: 0, structural: 0 },
    background_suite_pass_rate: null,
    average_phase_minutes: {},
    ledger_span_minutes: 45,
  };

  it('creates the retro file if missing', () => {
    const retroPath = path.join(tmpRoot, 'E1.md');
    const r = appendMetricsSection(retroPath, sampleMetrics);
    expect(r.mode).toBe('create');
    const content = fs.readFileSync(retroPath, 'utf8');
    expect(content).toContain(SECTION_TAG_OPEN);
    expect(content).toContain('Stories completed | 2');
  });

  it('appends to an existing retro file', () => {
    const retroPath = path.join(tmpRoot, 'E1.md');
    fs.writeFileSync(retroPath, '# Retrospective for E1\n\nSome notes.\n', 'utf8');
    const r = appendMetricsSection(retroPath, sampleMetrics);
    expect(r.mode).toBe('append');
    const content = fs.readFileSync(retroPath, 'utf8');
    expect(content).toContain('# Retrospective for E1');
    expect(content).toContain(SECTION_TAG_OPEN);
    expect(content).toContain('Stories completed | 2');
  });

  it('replaces an existing metrics section idempotently', () => {
    const retroPath = path.join(tmpRoot, 'E1.md');
    appendMetricsSection(retroPath, sampleMetrics);
    const updated: Metrics = { ...sampleMetrics, stories_completed: 5 };
    const r = appendMetricsSection(retroPath, updated);
    expect(r.mode).toBe('replace');
    const content = fs.readFileSync(retroPath, 'utf8');
    // Only one BEGIN tag.
    const occurrences = content.split(SECTION_TAG_OPEN).length - 1;
    expect(occurrences).toBe(1);
    expect(content).toContain('Stories completed | 5');
    expect(content).not.toContain('Stories completed | 2');
  });
});
