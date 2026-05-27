import { describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import resumeContext from '../../../_Sprintpilot/lib/orchestrator/resume-context.js';
// @ts-expect-error — CommonJS module
import sm from '../../../_Sprintpilot/lib/orchestrator/state-machine.js';

type LedgerEntry = Record<string, unknown>;
type State = Record<string, unknown>;
type Detection = {
  resuming: boolean;
  phase?: string;
  story_key?: string | null;
  reason?: string;
  evidence?: {
    last_action_emitted_at: string | null;
    last_signal_at: string | null;
    last_checkpoint: LedgerEntry | null;
  };
};
type Hint = Record<string, unknown> | null;

const {
  RESUMABLE_PHASES,
  RICH_HINT_PHASES,
  TERMINAL_KINDS,
  detect,
  build,
  normaliseCheckpoint,
  parseAcceptanceCriteria,
  lastTestResultFromLedger,
  elapsedMinutes,
} = resumeContext as {
  RESUMABLE_PHASES: Set<string>;
  RICH_HINT_PHASES: Set<string>;
  TERMINAL_KINDS: Set<string>;
  detect: (
    state: State,
    ledger: LedgerEntry[],
    options?: { force?: boolean },
  ) => Detection;
  build: (detection: Detection, world: Record<string, unknown>) => Hint;
  normaliseCheckpoint: (raw: unknown) => Record<string, unknown> | null;
  parseAcceptanceCriteria: (md: string) => { completed: string[]; total: number };
  lastTestResultFromLedger: (
    ledger: LedgerEntry[],
    phase: string,
  ) => { ok: boolean; summary: string } | null;
  elapsedMinutes: (startedAt: string | null, now: string) => number | null;
};

const { STATES } = sm as { STATES: Record<string, string> };

const T0 = '2026-05-27T10:00:00.000Z';
const T1 = '2026-05-27T10:00:01.000Z';
const T2 = '2026-05-27T10:00:02.000Z';
const T3 = '2026-05-27T10:00:03.000Z';
const T4 = '2026-05-27T10:30:00.000Z';

function actionEmitted(phase: string, ts = T1, skill = 'bmad-dev-story'): LedgerEntry {
  return {
    seq: 1,
    ts,
    kind: 'action_emitted',
    phase,
    action: { type: 'invoke_skill', skill, phase },
  };
}
function signalRecorded(phase: string, status = 'success', ts = T2): LedgerEntry {
  return { seq: 2, ts, kind: 'signal_recorded', phase, status };
}
function checkpoint(phase: string, payload: Record<string, unknown>, ts = T2): LedgerEntry {
  return { seq: 3, ts, kind: 'skill_checkpoint', phase, checkpoint: payload };
}
function verifyResult(phase: string, ok: boolean, issues: string[] = [], ts = T2): LedgerEntry {
  return { seq: 4, ts, kind: 'verify_result', phase, ok, issues };
}

describe('RESUMABLE_PHASES / RICH_HINT_PHASES / TERMINAL_KINDS', () => {
  it('declares all invoke_skill phases as resumable', () => {
    expect(RESUMABLE_PHASES.has(STATES.CREATE_STORY)).toBe(true);
    expect(RESUMABLE_PHASES.has(STATES.CHECK_READINESS)).toBe(true);
    expect(RESUMABLE_PHASES.has(STATES.DEV_RED)).toBe(true);
    expect(RESUMABLE_PHASES.has(STATES.DEV_GREEN)).toBe(true);
    expect(RESUMABLE_PHASES.has(STATES.CODE_REVIEW)).toBe(true);
    expect(RESUMABLE_PHASES.has(STATES.PATCH_APPLY)).toBe(true);
    expect(RESUMABLE_PHASES.has(STATES.PATCH_RETEST)).toBe(true);
    expect(RESUMABLE_PHASES.has(STATES.RETROSPECTIVE)).toBe(true);
    expect(RESUMABLE_PHASES.has(STATES.NANO_QUICK_DEV)).toBe(true);
  });

  it('does NOT mark git_op / routing phases as resumable', () => {
    expect(RESUMABLE_PHASES.has(STATES.PREPARE_STORY_BRANCH)).toBe(false);
    expect(RESUMABLE_PHASES.has(STATES.STORY_DONE)).toBe(false);
    expect(RESUMABLE_PHASES.has(STATES.STORY_LAND)).toBe(false);
    expect(RESUMABLE_PHASES.has(STATES.MERGE_EPIC)).toBe(false);
    expect(RESUMABLE_PHASES.has(STATES.EPIC_BOUNDARY_CHECK)).toBe(false);
    expect(RESUMABLE_PHASES.has(STATES.SPRINT_FINALIZE_PENDING)).toBe(false);
  });

  it('only rich-hint phases get the full evidence bundle', () => {
    expect(RICH_HINT_PHASES.has(STATES.DEV_GREEN)).toBe(true);
    expect(RICH_HINT_PHASES.has(STATES.NANO_QUICK_DEV)).toBe(true);
    expect(RICH_HINT_PHASES.has(STATES.CODE_REVIEW)).toBe(false);
    expect(RICH_HINT_PHASES.has(STATES.RETROSPECTIVE)).toBe(false);
  });

  it('lists signal_recorded / halt / phase_resumed as terminal', () => {
    expect(TERMINAL_KINDS.has('signal_recorded')).toBe(true);
    expect(TERMINAL_KINDS.has('halt')).toBe(true);
    expect(TERMINAL_KINDS.has('phase_resumed')).toBe(true);
    expect(TERMINAL_KINDS.has('skill_checkpoint')).toBe(false);
  });
});

describe('detect — happy paths and short-circuits', () => {
  it('returns resuming: false when state has no phase', () => {
    expect(detect({}, [])).toEqual({ resuming: false });
  });

  it('returns resuming: false when phase is not in RESUMABLE_PHASES', () => {
    const out = detect({ phase: STATES.STORY_DONE }, [actionEmitted(STATES.STORY_DONE)]);
    expect(out.resuming).toBe(false);
  });

  it('returns resuming: false when ledger has no invoke_skill for the current phase', () => {
    const ledger: LedgerEntry[] = [
      { seq: 1, ts: T0, kind: 'action_emitted', phase: STATES.PREPARE_STORY_BRANCH, action: { type: 'git_op', phase: STATES.PREPARE_STORY_BRANCH } },
    ];
    const out = detect({ phase: STATES.DEV_GREEN }, ledger);
    expect(out.resuming).toBe(false);
  });

  it('returns resuming: true when action_emitted has no subsequent signal_recorded', () => {
    const ledger = [actionEmitted(STATES.DEV_GREEN)];
    const out = detect({ phase: STATES.DEV_GREEN, current_story: 'S1.2' }, ledger);
    expect(out.resuming).toBe(true);
    expect(out.phase).toBe(STATES.DEV_GREEN);
    expect(out.story_key).toBe('S1.2');
    expect(out.reason).toBe('skill_interrupted');
    expect(out.evidence?.last_action_emitted_at).toBe(T1);
  });

  it('returns resuming: false when signal_recorded follows action_emitted for same phase', () => {
    const ledger = [actionEmitted(STATES.DEV_GREEN), signalRecorded(STATES.DEV_GREEN)];
    const out = detect({ phase: STATES.DEV_GREEN }, ledger);
    expect(out.resuming).toBe(false);
  });

  it('treats halt as terminal', () => {
    const ledger = [
      actionEmitted(STATES.DEV_GREEN),
      { seq: 2, ts: T2, kind: 'halt', phase: STATES.DEV_GREEN },
    ];
    const out = detect({ phase: STATES.DEV_GREEN }, ledger);
    expect(out.resuming).toBe(false);
  });

  it('treats phase_resumed as terminal (avoids double-resume loop)', () => {
    const ledger = [
      actionEmitted(STATES.DEV_GREEN),
      { seq: 2, ts: T2, kind: 'phase_resumed', phase: STATES.DEV_GREEN, reason: 'skill_interrupted', hint: { phase: STATES.DEV_GREEN } },
    ];
    const out = detect({ phase: STATES.DEV_GREEN }, ledger);
    expect(out.resuming).toBe(false);
  });

  it('ignores signal_recorded for a DIFFERENT phase', () => {
    const ledger = [
      actionEmitted(STATES.DEV_GREEN),
      { seq: 2, ts: T2, kind: 'signal_recorded', phase: STATES.DEV_RED, status: 'success' },
    ];
    const out = detect({ phase: STATES.DEV_GREEN }, ledger);
    expect(out.resuming).toBe(true);
  });

  it('picks the MOST RECENT action_emitted for the phase', () => {
    const ledger = [
      actionEmitted(STATES.DEV_GREEN, T0),
      signalRecorded(STATES.DEV_GREEN, 'failure', T1),
      actionEmitted(STATES.DEV_GREEN, T2), // retry
      // no signal after T2 → resuming
    ];
    const out = detect({ phase: STATES.DEV_GREEN }, ledger);
    expect(out.resuming).toBe(true);
    expect(out.evidence?.last_action_emitted_at).toBe(T2);
  });

  it('captures the most recent skill_checkpoint as evidence', () => {
    const cp = checkpoint(STATES.DEV_GREEN, { summary: 'AC1 done' }, T2);
    const ledger = [actionEmitted(STATES.DEV_GREEN), cp];
    const out = detect({ phase: STATES.DEV_GREEN }, ledger);
    expect(out.resuming).toBe(true);
    expect(out.evidence?.last_checkpoint).toBe(cp);
  });
});

describe('detect — force / manual_resume', () => {
  it('forces manual_resume when no invoke_skill exists yet', () => {
    const out = detect({ phase: STATES.DEV_GREEN, current_story: 'S2' }, [], { force: true });
    expect(out.resuming).toBe(true);
    expect(out.reason).toBe('manual_resume');
    expect(out.story_key).toBe('S2');
  });

  it('forces manual_resume even when a signal_recorded terminal exists', () => {
    const ledger = [actionEmitted(STATES.DEV_GREEN), signalRecorded(STATES.DEV_GREEN)];
    const out = detect({ phase: STATES.DEV_GREEN, current_story: 'S2' }, ledger, { force: true });
    expect(out.resuming).toBe(true);
    expect(out.reason).toBe('manual_resume');
  });
});

describe('build — hint shape per phase', () => {
  const detection: Detection = {
    resuming: true,
    phase: STATES.DEV_GREEN,
    story_key: 'S1.2',
    reason: 'skill_interrupted',
    evidence: {
      last_action_emitted_at: T1,
      last_signal_at: null,
      last_checkpoint: checkpoint(STATES.DEV_GREEN, {
        summary: 'AC1-3 implemented',
        ac_done: ['AC1', 'AC2', 'AC3'],
        tests_passing: ['t1', 't2'],
        tests_failing: ['t3'],
        files_touched: ['src/a.ts'],
        next_step: 'wire AC4',
      }),
    },
  };
  const world = {
    now: T4,
    phase_started_at: T0,
    changed_files: ['src/a.ts', 'tests/a.test.ts'],
    ac_completed: ['Login AC1', 'Login AC2'],
    ac_total: 4,
    last_test_result: { ok: false, summary: 'verify_failed' },
    patches_landed: ['abc123'],
  };

  it('returns null when detection is not resuming', () => {
    expect(build({ resuming: false }, world)).toBeNull();
  });

  it('rich-hint phase gets every evidence field populated', () => {
    const hint = build(detection, world);
    expect(hint).not.toBeNull();
    expect(hint!.phase).toBe(STATES.DEV_GREEN);
    expect(hint!.story_key).toBe('S1.2');
    expect(hint!.reason).toBe('skill_interrupted');
    expect(hint!.interrupted_at).toBe(T1);
    expect(hint!.phase_started_at).toBe(T0);
    expect(hint!.elapsed_minutes).toBe(30);
    expect(hint!.changed_files).toEqual(['src/a.ts', 'tests/a.test.ts']);
    expect(hint!.ac_completed).toEqual(['Login AC1', 'Login AC2']);
    expect(hint!.ac_total).toBe(4);
    expect(hint!.last_test_result).toEqual({ ok: false, summary: 'verify_failed' });
    expect(hint!.checkpoint).not.toBeNull();
    expect((hint!.checkpoint as Record<string, unknown>).summary).toBe('AC1-3 implemented');
    expect((hint!.checkpoint as Record<string, unknown>).ac_done).toEqual(['AC1', 'AC2', 'AC3']);
  });

  it('PATCH_RETEST hint includes patches_landed; non-patch phases get null', () => {
    const patchDetection = { ...detection, phase: STATES.PATCH_RETEST };
    const hint = build(patchDetection, world);
    expect(hint!.patches_landed).toEqual(['abc123']);

    const devHint = build(detection, world);
    expect(devHint!.patches_landed).toBeNull();
  });

  it('non-rich phases (CODE_REVIEW, CREATE_STORY) get stub evidence — no changed_files / ac', () => {
    const stub = build({ ...detection, phase: STATES.CODE_REVIEW }, world);
    expect(stub!.changed_files).toBeNull();
    expect(stub!.ac_completed).toBeNull();
    expect(stub!.ac_total).toBeNull();
    expect(stub!.last_test_result).toBeNull();
    expect(stub!.patches_landed).toBeNull();
    expect(stub!.checkpoint).not.toBeNull();
  });

  it('caps changed_files / ac_completed at 50 entries', () => {
    const big = {
      ...world,
      changed_files: Array.from({ length: 100 }, (_, i) => `f${i}.ts`),
      ac_completed: Array.from({ length: 100 }, (_, i) => `AC${i}`),
    };
    const hint = build(detection, big);
    expect((hint!.changed_files as string[]).length).toBe(50);
    expect((hint!.ac_completed as string[]).length).toBe(50);
  });

  it('summary includes elapsed, AC count, file count, checkpoint summary', () => {
    const hint = build(detection, world);
    expect(hint!.summary).toMatch(/phase dev_green was interrupted/);
    expect(hint!.summary).toMatch(/30m elapsed/);
    expect(hint!.summary).toMatch(/2\/4 AC already checked off/);
    expect(hint!.summary).toMatch(/2 file\(s\) modified/);
    expect(hint!.summary).toMatch(/AC1-3 implemented/);
  });
});

describe('normaliseCheckpoint', () => {
  it('rejects non-object input', () => {
    expect(normaliseCheckpoint(null)).toBeNull();
    expect(normaliseCheckpoint('string')).toBeNull();
    expect(normaliseCheckpoint([])).toBeNull();
  });

  it('rejects empty payload', () => {
    expect(normaliseCheckpoint({})).toBeNull();
    expect(
      normaliseCheckpoint({ ac_done: [], tests_passing: [], tests_failing: [] }),
    ).toBeNull();
  });

  it('accepts a payload with only a summary', () => {
    const cp = normaliseCheckpoint({ summary: 'hello' });
    expect(cp).not.toBeNull();
    expect(cp!.summary).toBe('hello');
    expect(cp!.ac_done).toEqual([]);
  });

  it('strips non-string entries from string arrays', () => {
    const cp = normaliseCheckpoint({
      ac_done: ['AC1', 42, null, 'AC2'],
      tests_passing: ['t1', { bad: 1 }],
    });
    expect(cp!.ac_done).toEqual(['AC1', 'AC2']);
    expect(cp!.tests_passing).toEqual(['t1']);
  });

  it('truncates oversize string fields', () => {
    const huge = 'x'.repeat(2_000);
    const cp = normaliseCheckpoint({ summary: huge, next_step: huge });
    expect((cp!.summary as string).length).toBe(500);
    expect((cp!.next_step as string).length).toBe(500);
  });

  it('caps each array at 50 items', () => {
    const cp = normaliseCheckpoint({
      ac_done: Array.from({ length: 100 }, (_, i) => `AC${i}`),
    });
    expect((cp!.ac_done as string[]).length).toBe(50);
  });

  it('ignores undocumented fields (no smuggling)', () => {
    const cp = normaliseCheckpoint({ summary: 'ok', secret_token: 'leak' });
    expect(cp).not.toBeNull();
    expect(Object.keys(cp!)).not.toContain('secret_token');
  });
});

describe('parseAcceptanceCriteria', () => {
  it('returns empty on non-string input', () => {
    expect(parseAcceptanceCriteria('' as unknown as string)).toEqual({ completed: [], total: 0 });
  });

  it('parses a typical BMad story file', () => {
    const md = [
      '# Story S1.2 — Login button accessible label',
      '',
      '## Acceptance Criteria',
      '',
      '- [x] AC1: button has aria-label',
      '- [x] AC2: focus ring visible',
      '- [ ] AC3: screen reader announces button',
      '- [ ] AC4: works in Safari + Firefox',
      '',
      '## Tasks',
      '- [ ] Not an AC',
    ].join('\n');
    const out = parseAcceptanceCriteria(md);
    expect(out.total).toBe(4);
    expect(out.completed).toEqual([
      'AC1: button has aria-label',
      'AC2: focus ring visible',
    ]);
  });

  it('handles uppercase [X]', () => {
    const out = parseAcceptanceCriteria('## Acceptance Criteria\n- [X] AC1\n- [ ] AC2');
    expect(out.completed).toEqual(['AC1']);
    expect(out.total).toBe(2);
  });

  it('does not include items outside the Acceptance section', () => {
    const md = [
      '## Tasks',
      '- [x] some task',
      '## Acceptance Criteria',
      '- [x] AC1',
      '## Notes',
      '- [x] note',
    ].join('\n');
    const out = parseAcceptanceCriteria(md);
    expect(out.completed).toEqual(['AC1']);
    expect(out.total).toBe(1);
  });

  it('ignores items inside fenced code blocks', () => {
    const md = [
      '## Acceptance Criteria',
      '- [x] AC1',
      '```',
      '- [x] not-an-ac',
      '```',
      '- [ ] AC2',
    ].join('\n');
    const out = parseAcceptanceCriteria(md);
    expect(out.completed).toEqual(['AC1']);
    expect(out.total).toBe(2);
  });
});

describe('lastTestResultFromLedger', () => {
  it('returns null for empty ledger / missing phase', () => {
    expect(lastTestResultFromLedger([], STATES.DEV_GREEN)).toBeNull();
    expect(lastTestResultFromLedger([verifyResult(STATES.DEV_RED, true)], '')).toBeNull();
  });

  it('returns the most recent verify_result for the phase', () => {
    const ledger = [
      verifyResult(STATES.DEV_GREEN, false, ['broken thing'], T1),
      verifyResult(STATES.DEV_GREEN, true, [], T2),
    ];
    const out = lastTestResultFromLedger(ledger, STATES.DEV_GREEN);
    expect(out).toEqual({ ok: true, summary: 'verify_ok' });
  });

  it('summarises with the first 3 issues on failure', () => {
    const ledger = [verifyResult(STATES.DEV_GREEN, false, ['a', 'b', 'c', 'd'], T1)];
    const out = lastTestResultFromLedger(ledger, STATES.DEV_GREEN);
    expect(out!.ok).toBe(false);
    expect(out!.summary).toBe('failed: a; b; c');
  });

  it('skips verify_results for other phases', () => {
    const ledger = [
      verifyResult(STATES.DEV_RED, true, [], T1),
      verifyResult(STATES.CODE_REVIEW, false, ['x'], T2),
    ];
    expect(lastTestResultFromLedger(ledger, STATES.DEV_GREEN)).toBeNull();
  });
});

describe('elapsedMinutes', () => {
  it('returns null on missing / unparseable input', () => {
    expect(elapsedMinutes(null as unknown as string, T1)).toBeNull();
    expect(elapsedMinutes('not-a-date', T1)).toBeNull();
  });

  it('rounds to one decimal place', () => {
    const out = elapsedMinutes(T0, '2026-05-27T10:01:09.000Z'); // 1.15min
    expect(out).toBe(1.2);
  });
});
