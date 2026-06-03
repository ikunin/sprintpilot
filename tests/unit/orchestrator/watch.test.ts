import { describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import autopilot from '../../../_Sprintpilot/bin/autopilot.js';

const { formatWatchEventLine } = autopilot as {
  formatWatchEventLine: (e: Record<string, unknown>, opts?: { tty?: boolean }) => string;
};

describe('formatWatchEventLine (v2.5.0)', () => {
  it('formats a state_transition with from→to + verdict', () => {
    const line = formatWatchEventLine({
      seq: 12,
      ts: '2026-06-01T12:34:56.000Z',
      kind: 'state_transition',
      from: 'dev_red',
      to: 'dev_green',
      verdict: 'advanced',
    });
    expect(line).toContain('12:34:56');
    expect(line).toContain('#12');
    expect(line).toContain('state_transition');
    expect(line).toContain('dev_red→dev_green');
    expect(line).toContain('advanced');
  });

  it('formats an action_emitted with skill/op detail', () => {
    const line = formatWatchEventLine({
      seq: 5,
      ts: '2026-06-01T10:00:00.000Z',
      kind: 'action_emitted',
      action: { type: 'invoke_skill', skill: 'bmad-dev-story', phase: 'dev_green' },
    });
    expect(line).toContain('action_emitted');
    expect(line).toContain('bmad-dev-story');
    expect(line).toContain('[dev_green]');
  });

  it('formats a halt with reason', () => {
    const line = formatWatchEventLine({
      seq: 99,
      ts: '2026-06-01T10:00:00.000Z',
      kind: 'halt',
      phase: 'dev_green',
      reason: 'phase_timeout_exceeded',
    });
    expect(line).toContain('halt');
    expect(line).toContain('reason=phase_timeout_exceeded');
  });

  it('formats a test_scope_decision with adapter + scope', () => {
    const line = formatWatchEventLine({
      seq: 30,
      ts: '2026-06-01T10:00:00.000Z',
      kind: 'test_scope_decision',
      phase: 'dev_green',
      detail: { scope: 'affected', adapter: 'vitest' },
    });
    expect(line).toContain('test_scope_decision');
    expect(line).toContain('affected');
    expect(line).toContain('vitest');
  });

  it('formats a review_depth_decision with size + reviewer count', () => {
    const line = formatWatchEventLine({
      seq: 31,
      ts: '2026-06-01T10:00:00.000Z',
      kind: 'review_depth_decision',
      detail: { size: 'trivial', reviewer_count: 1 },
    });
    expect(line).toContain('trivial');
    expect(line).toContain('reviewers=1');
  });

  it('plain mode (default) emits no ANSI escapes', () => {
    const line = formatWatchEventLine({
      seq: 1,
      ts: '2026-06-01T10:00:00.000Z',
      kind: 'halt',
      reason: 'r',
    });
    // No ESC (0x1b) bytes.
    expect(line.includes('\x1b')).toBe(false);
  });

  it('tty mode emits ANSI escape codes', () => {
    const line = formatWatchEventLine(
      {
        seq: 1,
        ts: '2026-06-01T10:00:00.000Z',
        kind: 'halt',
        reason: 'r',
      },
      { tty: true },
    );
    expect(line.includes('\x1b[')).toBe(true);
  });

  it('returns empty string for null event', () => {
    expect(formatWatchEventLine(null as unknown as Record<string, unknown>)).toBe('');
  });
});
