import { describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import report from '../../../_Sprintpilot/lib/orchestrator/report.js';

const { render, ledgerSummary, fastLaneSummary, recentActions, blockers, nextActionHint } =
  report as {
    render: (
      state: Record<string, unknown>,
      entries: Record<string, unknown>[],
      profile: Record<string, unknown>,
    ) => string;
    ledgerSummary: (entries: Record<string, unknown>[]) => string;
    fastLaneSummary: (entries: Record<string, unknown>[]) => string;
    recentActions: (entries: Record<string, unknown>[], limit?: number) => string;
    blockers: (entries: Record<string, unknown>[]) => string;
    nextActionHint: (state: Record<string, unknown>, profile: Record<string, unknown>) => string;
  };

const entry = (kind: string, extra: Record<string, unknown> = {}) => ({
  seq: 1,
  ts: '2026-05-12T10:00:00.000Z',
  kind,
  ...extra,
});

describe('fastLaneSummary', () => {
  it('returns empty when the fast lane never fired', () => {
    expect(fastLaneSummary([entry('action_emitted')])).toBe('');
  });

  it('counts a fast-then-escalated story as fast-laned, not kept-full', () => {
    const entries = [
      entry('fast_lane_decision', { story_key: '1-1', decision: 'fast' }),
      entry('fast_lane_decision', { story_key: '1-2', decision: 'full' }),
      entry('fast_lane_decision', { story_key: '1-3', decision: 'fast' }),
      // 1-3 later bounced to full → it STILL ran quick-dev, so it stays counted
      // as fast-laned AND is reported as escalated.
      entry('fast_lane_decision', { story_key: '1-3', decision: 'full' }),
      entry('profile_escalated', { from: 'fast_lane', story_key: '1-3' }),
    ];
    const out = fastLaneSummary(entries);
    expect(out).toContain('Stories fast-laned (ran quick-dev one-shot): 2'); // 1-1 + 1-3
    expect(out).toContain('Stories kept on the full cycle: 1'); // only 1-2
    expect(out).toContain('Fast-laned stories escalated back to full: 1'); // 1-3
    expect(out).toContain('1-3');
  });
});

describe('render', () => {
  it('renders header + ledger summary + recent actions', () => {
    const state = {
      current_story: 'S1',
      current_bmad_step: 'dev_red',
      sprint_is_complete: false,
    };
    const entries = [
      entry('action_emitted', {
        phase: 'dev_red',
        action: { type: 'invoke_skill', skill: 'bmad-dev-story' },
      }),
      entry('signal_recorded', { phase: 'dev_red', status: 'success' }),
    ];
    const out = render(state, entries, { name: 'medium' });
    expect(out).toContain('# Autopilot Session Report');
    expect(out).toContain('**Current story:** S1');
    expect(out).toContain('## Ledger summary');
    expect(out).toContain('action_emitted: 1');
    expect(out).toContain('signal_recorded: 1');
    expect(out).toContain('invoke_skill bmad-dev-story');
  });

  it('handles empty state and ledger', () => {
    const out = render({}, [], {});
    expect(out).toContain('# Autopilot Session Report');
    expect(out).toContain('**Current story:** (none)');
  });
});

describe('ledgerSummary', () => {
  it('groups counts by kind', () => {
    const text = ledgerSummary([
      entry('action_emitted'),
      entry('action_emitted'),
      entry('signal_recorded'),
    ]);
    expect(text).toContain('action_emitted: 2');
    expect(text).toContain('signal_recorded: 1');
  });
});

describe('recentActions', () => {
  it('limits to the most recent N actions', () => {
    const entries = Array.from({ length: 12 }, (_, i) =>
      entry('action_emitted', {
        phase: 'dev_red',
        action: { type: 'invoke_skill', skill: `skill-${i}` },
      }),
    );
    const text = recentActions(entries, 3);
    expect(text).toContain('Last 3 actions');
    expect(text).toContain('skill-11');
    expect(text).not.toContain('skill-0');
  });
});

describe('blockers', () => {
  it('shows recent halts only', () => {
    const entries = [
      entry('halt', { phase: 'dev_red', reason: 'user_pause' }),
      entry('halt', { phase: 'code_review', reason: 'sprint_complete' }),
      entry('action_emitted'),
    ];
    const text = blockers(entries);
    expect(text).toContain('user_pause');
    expect(text).toContain('sprint_complete');
  });

  it('returns empty string when no halts', () => {
    expect(blockers([entry('action_emitted')])).toBe('');
  });
});

describe('nextActionHint', () => {
  it('flags sprint-complete state', () => {
    const text = nextActionHint(
      { sprint_is_complete: true, current_bmad_step: 'retrospective' },
      {},
    );
    expect(text).toContain('Sprint is complete');
  });

  it('flags sprint-finalize-pending', () => {
    const text = nextActionHint({ current_bmad_step: 'sprint_finalize_pending' }, {});
    expect(text).toContain('Finalize step pending');
  });

  it('default points to autopilot next', () => {
    const text = nextActionHint({ current_bmad_step: 'dev_red' }, { name: 'medium' });
    expect(text).toContain('autopilot next');
    expect(text).toContain('phase=dev_red');
  });
});
