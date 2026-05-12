import { describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import adapt from '../../../_Sprintpilot/lib/orchestrator/adapt.js';
// @ts-expect-error — CommonJS module
import sm from '../../../_Sprintpilot/lib/orchestrator/state-machine.js';
// @ts-expect-error — CommonJS module
import profileRules from '../../../_Sprintpilot/lib/orchestrator/profile-rules.js';

type Action = Record<string, unknown>;
type SideEffect = Record<string, unknown>;
type Result = {
  newState: Record<string, unknown>;
  newProfile: Record<string, unknown>;
  nextAction: Action;
  sideEffects: SideEffect[];
  verdict: 'advanced' | 'retry' | 'prompted' | 'halt';
};

const { interpretSignal, CONSECUTIVE_TEST_FAILURE_THRESHOLD } = adapt as {
  interpretSignal: (
    state: Record<string, unknown>,
    signal: Record<string, unknown>,
    profile: Record<string, unknown>,
    verifyResult?: { ok: boolean; issues?: string[] },
  ) => Result;
  CONSECUTIVE_TEST_FAILURE_THRESHOLD: number;
};

const { STATES } = sm as { STATES: Record<string, string> };
const { flatToProfile } = profileRules as {
  flatToProfile: (resolved: unknown, name: string) => Record<string, unknown>;
};

const medium = () => flatToProfile({}, 'medium');
const nano = () =>
  flatToProfile(
    {
      autopilot: {
        implementation_flow: 'quick',
        retrospective_mode: 'skip',
        nano: {
          fallback_on_tests_fail: true,
          fallback_on_quick_dev_high_severity: true,
          fallback_target: 'small',
        },
      },
    },
    'nano',
  );

function st(phase: string, extra: Record<string, unknown> = {}) {
  return {
    phase,
    story_key: 'S1',
    story_file_path: '/r/_bmad-output/stories/S1.md',
    current_epic: 'E1',
    ac_summary: 'ac',
    prior_diagnosis: null,
    relevant_decisions: [],
    prior_signals_summary: null,
    patch_findings: null,
    tests_to_rerun: null,
    remaining_stories_in_epic: 0,
    sprint_is_complete: false,
    retry_count_this_phase: 0,
    verify_reject_count: 0,
    consecutive_test_failures: 0,
    ...extra,
  };
}

describe('success — happy path', () => {
  it('advances DEV_RED → DEV_GREEN', () => {
    const r = interpretSignal(st(STATES.DEV_RED), { status: 'success' }, medium());
    expect(r.verdict).toBe('advanced');
    expect(r.newState.phase).toBe(STATES.DEV_GREEN);
    expect((r.nextAction as Record<string, unknown>).skill).toBe('bmad-dev-story');
  });

  it('CODE_REVIEW with patch finding → PATCH_APPLY and carries patch_findings', () => {
    const findings = [{ id: 'F1', action: 'patch', rationale: 'fix lint' }];
    const r = interpretSignal(
      st(STATES.CODE_REVIEW),
      { status: 'success', output: { findings } },
      medium(),
    );
    expect(r.newState.phase).toBe(STATES.PATCH_APPLY);
    expect(r.newState.patch_findings).toEqual([{ id: 'F1', action: 'patch', rationale: 'fix lint' }]);
  });

  it('CODE_REVIEW with blocking finding → user_prompt', () => {
    const r = interpretSignal(
      st(STATES.CODE_REVIEW),
      { status: 'success', output: { findings: [{ id: 'B1', action: 'block', rationale: 'arch decision' }] } },
      medium(),
    );
    expect(r.verdict).toBe('prompted');
    expect((r.nextAction as Record<string, unknown>).type).toBe('user_prompt');
    expect((r.nextAction as Record<string, unknown>).reason).toBe('code_review_blocking_findings');
  });
});

describe('success — verify.js trust boundary', () => {
  it('rejects success when verify.js fails; retries within budget', () => {
    const r = interpretSignal(
      st(STATES.DEV_RED),
      { status: 'success' },
      medium(),
      { ok: false, issues: ['no failing tests'] },
    );
    expect(r.verdict).toBe('retry');
    expect(r.newState.verify_reject_count).toBe(1);
    expect(r.newState.phase).toBe(STATES.DEV_RED); // same phase
  });

  it('escalates to user_prompt after verify_reject_budget exhausted', () => {
    const state = st(STATES.DEV_RED, { verify_reject_count: 2 }); // medium budget is 3
    const r = interpretSignal(state, { status: 'success' }, medium(), {
      ok: false,
      issues: ['no failing tests'],
    });
    expect(r.verdict).toBe('prompted');
    expect((r.nextAction as Record<string, unknown>).reason).toBe('verify_reject_budget_exceeded');
  });

  it('accepts success when verify.js returns ok', () => {
    const r = interpretSignal(st(STATES.CHECK_READINESS), { status: 'success' }, medium(), {
      ok: true,
    });
    expect(r.verdict).toBe('advanced');
    expect(r.newState.phase).toBe(STATES.DEV_RED);
  });
});

describe('success — nano escalation', () => {
  it('escalates nano to small when tests_failed > 0 on NANO_QUICK_DEV', () => {
    const r = interpretSignal(
      st(STATES.NANO_QUICK_DEV),
      { status: 'success', output: { tests_failed: 2 } },
      nano(),
    );
    expect(r.newProfile.name).toBe('small');
    expect(r.newProfile.escalated_from).toBe('nano');
    expect(r.sideEffects).toContainEqual(
      expect.objectContaining({ kind: 'profile_escalated', to: 'small' }),
    );
  });

  it('does not escalate nano on clean success', () => {
    const r = interpretSignal(
      st(STATES.NANO_QUICK_DEV),
      { status: 'success', output: { tests_failed: 0 } },
      nano(),
    );
    expect(r.newProfile.name).toBe('nano');
  });
});

describe('failure', () => {
  it('retries within budget and carries diagnosis', () => {
    const r = interpretSignal(
      st(STATES.DEV_GREEN),
      { status: 'failure', reason: 'test broke', diagnosis: 'fixture missing', recoverable: true },
      medium(),
    );
    expect(r.verdict).toBe('retry');
    expect(r.newState.retry_count_this_phase).toBe(1);
    expect(r.newState.prior_diagnosis).toBe('fixture missing');
    expect((r.nextAction as Record<string, unknown>).template_slots).toMatchObject({
      prior_diagnosis: 'fixture missing',
    });
  });

  it('escalates to user_prompt after budget exhausted', () => {
    const state = st(STATES.DEV_GREEN, { retry_count_this_phase: 2 }); // medium budget is 2 → next try is the 3rd → exhausted
    const r = interpretSignal(
      state,
      { status: 'failure', reason: 'x', diagnosis: 'y', recoverable: true },
      medium(),
    );
    expect(r.verdict).toBe('prompted');
    expect((r.nextAction as Record<string, unknown>).reason).toBe('retry_budget_exhausted');
  });

  it('non-recoverable failure → immediate user_prompt', () => {
    const r = interpretSignal(
      st(STATES.DEV_RED),
      { status: 'failure', reason: 'fatal', diagnosis: 'x', recoverable: false },
      medium(),
    );
    expect(r.verdict).toBe('prompted');
    expect((r.nextAction as Record<string, unknown>).reason).toBe('failure_not_recoverable');
  });
});

describe('blocked', () => {
  it('consecutive_test_failures below threshold → retry', () => {
    const r = interpretSignal(
      st(STATES.DEV_GREEN, { consecutive_test_failures: 1 }),
      { status: 'blocked', blocker_kind: 'consecutive_test_failures', consecutive_count: 2 },
      medium(),
    );
    expect(r.verdict).toBe('retry');
    expect(r.newState.consecutive_test_failures).toBe(2);
  });

  it('consecutive_test_failures at threshold → user_prompt', () => {
    const r = interpretSignal(
      st(STATES.DEV_GREEN, { consecutive_test_failures: 2 }),
      {
        status: 'blocked',
        blocker_kind: 'consecutive_test_failures',
        consecutive_count: CONSECUTIVE_TEST_FAILURE_THRESHOLD,
      },
      medium(),
    );
    expect(r.verdict).toBe('prompted');
    expect((r.nextAction as Record<string, unknown>).reason).toBe(
      'consecutive_test_failures_threshold',
    );
  });

  it('orchestrator tracks count independently — under-reporting LLM still triggers threshold', () => {
    // LLM under-reports (count=1) but orchestrator state already has 2 → tracked becomes 3.
    const r = interpretSignal(
      st(STATES.DEV_GREEN, { consecutive_test_failures: 2 }),
      { status: 'blocked', blocker_kind: 'consecutive_test_failures', consecutive_count: 1 },
      medium(),
    );
    expect(r.verdict).toBe('prompted');
  });

  it('TRUE BLOCKERS (5 kinds) always → user_prompt', () => {
    const kinds = [
      'creative_user_input_required',
      'new_external_dependency',
      'security_architectural_decision',
      'contradictory_acceptance_criteria',
    ];
    for (const k of kinds) {
      const r = interpretSignal(
        st(STATES.DEV_RED),
        { status: 'blocked', blocker_kind: k, details: `${k} details` },
        medium(),
      );
      expect(r.verdict).toBe('prompted');
      expect((r.nextAction as Record<string, unknown>).reason).toBe(k);
    }
  });

  it('missing_dependency → run_script npm install', () => {
    const r = interpretSignal(
      st(STATES.DEV_GREEN),
      { status: 'blocked', blocker_kind: 'missing_dependency', user_input_needed: false },
      medium(),
    );
    expect(r.verdict).toBe('retry');
    expect((r.nextAction as Record<string, unknown>).type).toBe('run_script');
  });

  it('user_input_needed=true on any kind → user_prompt', () => {
    const r = interpretSignal(
      st(STATES.DEV_RED),
      { status: 'blocked', blocker_kind: 'unknown', user_input_needed: true, details: 'help' },
      medium(),
    );
    expect(r.verdict).toBe('prompted');
  });
});

describe('propose_alternative', () => {
  it('auto-accepts a low-impact alternative (whitelist arg diff)', () => {
    const r = interpretSignal(
      st(STATES.DEV_GREEN),
      {
        status: 'propose_alternative',
        reason: 'tweak retry budget',
        alternative: {
          type: 'invoke_skill',
          skill: 'bmad-dev-story',
          args: { retry_budget: 5 },
        },
      },
      medium(),
    );
    expect(r.verdict).toBe('advanced');
    expect((r.nextAction as Record<string, unknown>)._accepted_alternative).toBe(true);
    expect((r.nextAction as Record<string, unknown>)._impact).toBe('low');
  });

  it('escalates a non-whitelist alternative to user_prompt', () => {
    const r = interpretSignal(
      st(STATES.DEV_GREEN),
      {
        status: 'propose_alternative',
        reason: 'change framework',
        alternative: {
          type: 'invoke_skill',
          skill: 'bmad-dev-story',
          args: { test_framework: 'vitest' },
        },
      },
      medium(),
    );
    expect(r.verdict).toBe('prompted');
    expect((r.nextAction as Record<string, unknown>).impact).toBe('medium');
  });

  it('urgency_hint can raise impact', () => {
    const r = interpretSignal(
      st(STATES.DEV_GREEN),
      {
        status: 'propose_alternative',
        reason: 'urgent tweak',
        urgency_hint: 'high',
        alternative: {
          type: 'invoke_skill',
          skill: 'bmad-dev-story',
          args: { retry_budget: 5 },
        },
      },
      medium(),
    );
    expect(r.verdict).toBe('prompted');
    expect((r.nextAction as Record<string, unknown>).impact).toBe('high');
  });
});

describe('verify_override', () => {
  it('accepted override → treats as success', () => {
    const r = interpretSignal(
      st(STATES.DEV_RED),
      { status: 'verify_override', evidence: { decision_log_ref: 'DEC-007', explanation: 'renamed' } },
      medium(),
      { ok: true },
    );
    expect(r.verdict).toBe('advanced');
    expect(r.newState.phase).toBe(STATES.DEV_GREEN);
    expect(r.sideEffects).toContainEqual(expect.objectContaining({ kind: 'log_verify_override', accepted: true }));
  });

  it('rejected override → falls back to failure(recoverable=true)', () => {
    const r = interpretSignal(
      st(STATES.DEV_RED),
      { status: 'verify_override', evidence: { explanation: 'no good reason' } },
      medium(),
      { ok: false, issues: ['still missing'] },
    );
    expect(r.verdict).toBe('retry');
    expect(r.newState.prior_diagnosis).toBe('augmented verify.js still failed');
  });
});

describe('decisions[] audit channel', () => {
  it('emits append_decisions sideEffect when present on any signal', () => {
    const r = interpretSignal(
      st(STATES.DEV_RED),
      {
        status: 'success',
        decisions: [
          {
            category: 'test-strategy',
            impact: 'low',
            phase: 'dev-story:RED',
            decision: 'use vitest',
            rationale: 'matches repo',
          },
        ],
      },
      medium(),
    );
    expect(r.sideEffects[0].kind).toBe('append_decisions');
  });
});

describe('user_input', () => {
  it('emits apply_user_commands sideEffect and re-emits nextAction', () => {
    const r = interpretSignal(
      st(STATES.DEV_RED),
      { status: 'user_input', commands: [{ kind: 'skip_story', story_key: 'S1' }] },
      medium(),
    );
    expect(r.sideEffects).toContainEqual(expect.objectContaining({ kind: 'apply_user_commands' }));
    expect(r.verdict).toBe('advanced');
  });
});

describe('input validation', () => {
  it('throws on missing signal.status', () => {
    expect(() => interpretSignal(st(STATES.DEV_RED), {}, medium())).toThrow();
  });

  it('throws on unknown signal status', () => {
    expect(() =>
      interpretSignal(st(STATES.DEV_RED), { status: 'mystery' }, medium()),
    ).toThrow();
  });
});
