import { describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import haltExplainer from '../../../_Sprintpilot/lib/orchestrator/halt-explainer.js';

type LedgerEntry = Record<string, unknown>;
type Action = Record<string, unknown>;
type EnrichedAction = Action & {
  context?: {
    recent_actions: Record<string, unknown>[];
    verifier_check: Record<string, unknown> | null;
    elapsed_in_phase: Record<string, unknown> | null;
    similar_halt: Record<string, unknown> | null;
  };
};

const { enrich, recentActions, lastFailedVerify, elapsedInPhase, similarPriorHalt } =
  haltExplainer as {
    enrich: (
      action: Action,
      ctx: { ledgerEntries: LedgerEntry[]; state: Record<string, unknown>; now?: string },
    ) => EnrichedAction;
    recentActions: (entries: LedgerEntry[], limit?: number) => Record<string, unknown>[];
    lastFailedVerify: (entries: LedgerEntry[]) => Record<string, unknown> | null;
    elapsedInPhase: (
      state: Record<string, unknown>,
      now?: string,
    ) => Record<string, unknown> | null;
    similarPriorHalt: (
      entries: LedgerEntry[],
      phase: string,
      reason: string,
    ) => Record<string, unknown> | null;
  };

const T_NOW = '2026-06-01T12:00:00.000Z';
const minutesBefore = (n: number) => new Date(Date.parse(T_NOW) - n * 60_000).toISOString();

describe('halt-explainer.recentActions', () => {
  it('returns the last 3 action_emitted entries with skill/op summaries', () => {
    const entries: LedgerEntry[] = [
      {
        seq: 1,
        ts: minutesBefore(20),
        kind: 'action_emitted',
        phase: 'dev_red',
        action: { type: 'invoke_skill', skill: 'bmad-dev-story', phase: 'dev_red' },
      },
      {
        seq: 2,
        ts: minutesBefore(15),
        kind: 'signal_recorded',
        signal: { status: 'success' },
      },
      {
        seq: 3,
        ts: minutesBefore(10),
        kind: 'action_emitted',
        phase: 'dev_green',
        action: { type: 'invoke_skill', skill: 'bmad-dev-story', phase: 'dev_green' },
      },
      {
        seq: 4,
        ts: minutesBefore(5),
        kind: 'action_emitted',
        phase: 'story_done',
        action: { type: 'git_op', op: 'commit_and_push_story', phase: 'story_done' },
      },
    ];
    const r = recentActions(entries);
    expect(r).toHaveLength(3); // 3 action_emitted with allowed types
    // Oldest-first.
    expect(r[0]).toMatchObject({ skill: 'bmad-dev-story', type: 'invoke_skill', phase: 'dev_red' });
    expect(r[1]).toMatchObject({
      skill: 'bmad-dev-story',
      type: 'invoke_skill',
      phase: 'dev_green',
    });
    expect(r[2]).toMatchObject({ op: 'commit_and_push_story', type: 'git_op' });
  });

  it('honors a custom limit', () => {
    const entries: LedgerEntry[] = Array.from({ length: 6 }).map((_, i) => ({
      seq: i + 1,
      ts: minutesBefore(60 - i * 5),
      kind: 'action_emitted',
      phase: 'dev_red',
      action: { type: 'invoke_skill', skill: 'bmad-dev-story', phase: 'dev_red' },
    }));
    expect(recentActions(entries, 2)).toHaveLength(2);
    expect(recentActions(entries, 5)).toHaveLength(5);
  });

  it('returns [] for empty input', () => {
    expect(recentActions([])).toEqual([]);
  });
});

describe('halt-explainer.lastFailedVerify', () => {
  it('returns the most recent verify_result with ok=false', () => {
    const entries: LedgerEntry[] = [
      {
        seq: 1,
        ts: minutesBefore(20),
        kind: 'verify_result',
        phase: 'dev_green',
        result: { ok: true, issues: [] },
      },
      {
        seq: 2,
        ts: minutesBefore(10),
        kind: 'verify_result',
        phase: 'dev_green',
        result: { ok: false, issues: ['no tests passed'] },
      },
      {
        seq: 3,
        ts: minutesBefore(5),
        kind: 'verify_result',
        phase: 'dev_green',
        result: { ok: false, issues: ['git_steps_completed must be true'] },
      },
    ];
    const r = lastFailedVerify(entries);
    expect(r).not.toBeNull();
    expect(r!.seq).toBe(3);
    expect(r!.issues).toContain('git_steps_completed must be true');
  });

  it('returns null when there are no failed verifies', () => {
    const entries: LedgerEntry[] = [
      {
        seq: 1,
        ts: minutesBefore(10),
        kind: 'verify_result',
        result: { ok: true, issues: [] },
      },
    ];
    expect(lastFailedVerify(entries)).toBeNull();
  });

  it('caps issues at 10 to keep the prompt compact', () => {
    const big = Array.from({ length: 30 }).map((_, i) => `issue-${i}`);
    const entries: LedgerEntry[] = [
      { seq: 1, ts: T_NOW, kind: 'verify_result', result: { ok: false, issues: big } },
    ];
    const r = lastFailedVerify(entries);
    expect((r!.issues as string[]).length).toBe(10);
  });
});

describe('halt-explainer.elapsedInPhase', () => {
  it('computes minutes since phase entry', () => {
    const r = elapsedInPhase({ phase: 'dev_green', phase_started_at: minutesBefore(42) }, T_NOW);
    expect(r).not.toBeNull();
    expect(r!.phase).toBe('dev_green');
    expect(r!.minutes).toBeCloseTo(42, 1);
  });

  it('returns null when phase_started_at is missing', () => {
    expect(elapsedInPhase({ phase: 'dev_green' }, T_NOW)).toBeNull();
  });

  it('returns null when phase is missing', () => {
    expect(elapsedInPhase({ phase_started_at: minutesBefore(5) }, T_NOW)).toBeNull();
  });
});

describe('halt-explainer.similarPriorHalt', () => {
  it('finds a prior halt with the same phase + reason from a prior session', () => {
    const entries: LedgerEntry[] = [
      // Prior session.
      { seq: 1, ts: minutesBefore(1440), kind: 'lock_acquired' },
      {
        seq: 2,
        ts: minutesBefore(1430),
        kind: 'halt',
        phase: 'dev_green',
        reason: 'phase_timeout_exceeded',
      },
      // Current session.
      { seq: 3, ts: minutesBefore(60), kind: 'lock_acquired' },
      {
        seq: 4,
        ts: minutesBefore(5),
        kind: 'action_emitted',
        phase: 'dev_green',
        action: {
          type: 'invoke_skill',
          skill: 'bmad-dev-story',
          phase: 'dev_green',
        },
      },
    ];
    const r = similarPriorHalt(entries, 'dev_green', 'phase_timeout_exceeded');
    expect(r).not.toBeNull();
    expect(r!.seq).toBe(2);
  });

  it('does not return intra-session halts as similar', () => {
    const entries: LedgerEntry[] = [
      { seq: 1, ts: minutesBefore(60), kind: 'lock_acquired' },
      {
        seq: 2,
        ts: minutesBefore(30),
        kind: 'halt',
        phase: 'dev_green',
        reason: 'phase_timeout_exceeded',
      },
    ];
    expect(similarPriorHalt(entries, 'dev_green', 'phase_timeout_exceeded')).toBeNull();
  });

  it('returns null when no prior matching halt exists', () => {
    expect(similarPriorHalt([], 'dev_green', 'phase_timeout_exceeded')).toBeNull();
  });

  it('finds prior user_prompt action_emitted as a similar halt', () => {
    const entries: LedgerEntry[] = [
      { seq: 1, ts: minutesBefore(1440), kind: 'lock_acquired' },
      {
        seq: 2,
        ts: minutesBefore(1430),
        kind: 'action_emitted',
        phase: 'dev_green',
        action: {
          type: 'user_prompt',
          phase: 'dev_green',
          reason: 'verify_reject_budget_exceeded',
        },
      },
      { seq: 3, ts: minutesBefore(60), kind: 'lock_acquired' },
    ];
    const r = similarPriorHalt(entries, 'dev_green', 'verify_reject_budget_exceeded');
    expect(r).not.toBeNull();
    expect(r!.seq).toBe(2);
  });
});

describe('halt-explainer.enrich', () => {
  it('returns the action unchanged for non-user_prompt actions', () => {
    const action = { type: 'invoke_skill', skill: 'bmad-dev-story' };
    const r = enrich(action, { ledgerEntries: [], state: {}, now: T_NOW });
    expect(r).toBe(action);
  });

  it('adds context with all four bundles for a user_prompt action', () => {
    const entries: LedgerEntry[] = [
      { seq: 1, ts: minutesBefore(120), kind: 'lock_acquired' },
      {
        seq: 2,
        ts: minutesBefore(60),
        kind: 'action_emitted',
        phase: 'dev_green',
        action: { type: 'invoke_skill', skill: 'bmad-dev-story', phase: 'dev_green' },
      },
      {
        seq: 3,
        ts: minutesBefore(45),
        kind: 'verify_result',
        phase: 'dev_green',
        result: { ok: false, issues: ['tests failed'] },
      },
    ];
    const action = {
      type: 'user_prompt',
      phase: 'dev_green',
      reason: 'verify_reject_budget_exceeded',
      prompt: 'too many rejections',
    };
    const state = { phase: 'dev_green', phase_started_at: minutesBefore(50) };
    const r = enrich(action, { ledgerEntries: entries, state, now: T_NOW });

    expect(r.context).toBeDefined();
    expect(r.context!.recent_actions).toHaveLength(1);
    expect(r.context!.verifier_check).toMatchObject({ issues: ['tests failed'] });
    expect(r.context!.elapsed_in_phase).toMatchObject({
      phase: 'dev_green',
      minutes: 50,
    });
    expect(r.context!.similar_halt).toBeNull();
  });

  it('omits verifier_check when reason is not verify-related', () => {
    const action = {
      type: 'user_prompt',
      phase: 'dev_green',
      reason: 'phase_timeout_exceeded',
    };
    const entries: LedgerEntry[] = [
      {
        seq: 1,
        ts: minutesBefore(45),
        kind: 'verify_result',
        result: { ok: false, issues: ['stale'] },
      },
    ];
    const r = enrich(action, { ledgerEntries: entries, state: {}, now: T_NOW });
    expect(r.context!.verifier_check).toBeNull();
  });

  it('preserves the original action fields', () => {
    const action = {
      type: 'user_prompt',
      phase: 'dev_green',
      reason: 'verify_reject_budget_exceeded',
      prompt: 'p',
      consecutive_identical: 3,
    };
    const r = enrich(action, { ledgerEntries: [], state: {}, now: T_NOW });
    expect(r.type).toBe('user_prompt');
    expect(r.prompt).toBe('p');
    expect(r.consecutive_identical).toBe(3);
  });
});
