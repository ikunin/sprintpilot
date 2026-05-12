/**
 * Phase 3 — Signal-State Cross-Product Harness (primary determinism gate)
 *
 * For every reachable state in the BMad state machine, this harness
 * scripts a fake LLM through every signal kind × variant and asserts the
 * orchestrator's response against the documented adaptation table.
 *
 * If any row fails, the orchestrator is non-deterministic — which would
 * break the entire LLM-as-peer contract. Fail loudly.
 */

import { describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import adapt from '../../_Sprintpilot/lib/orchestrator/adapt.js';
// @ts-expect-error — CommonJS module
import profileRules from '../../_Sprintpilot/lib/orchestrator/profile-rules.js';
// @ts-expect-error — CommonJS module
import sm from '../../_Sprintpilot/lib/orchestrator/state-machine.js';

type Verdict = 'advanced' | 'retry' | 'prompted' | 'halt';
type Result = {
  newState: Record<string, unknown>;
  newProfile: Record<string, unknown>;
  nextAction: Record<string, unknown>;
  sideEffects: Record<string, unknown>[];
  verdict: Verdict;
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

const MEDIUM = () => flatToProfile({}, 'medium');
const NANO = () =>
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

const FULL_FLOW_PHASES = [
  STATES.CREATE_STORY,
  STATES.CHECK_READINESS,
  STATES.DEV_RED,
  STATES.DEV_GREEN,
  STATES.CODE_REVIEW,
  STATES.PATCH_APPLY,
  STATES.PATCH_RETEST,
  STATES.STORY_DONE,
  STATES.EPIC_BOUNDARY_CHECK,
  STATES.RETROSPECTIVE,
];

// ---------------------------------------------------------------- success rows

describe('success × full-flow phases — clean success advances state', () => {
  // CODE_REVIEW requires findings[] for the state machine to choose a
  // successor; STORY_DONE goes to EPIC_BOUNDARY_CHECK.
  type Row = { from: string; out?: Record<string, unknown>; expectedPhase: string };
  const rows: Row[] = [
    { from: STATES.CREATE_STORY, expectedPhase: STATES.CHECK_READINESS },
    { from: STATES.CHECK_READINESS, expectedPhase: STATES.DEV_RED },
    { from: STATES.DEV_RED, expectedPhase: STATES.DEV_GREEN },
    { from: STATES.DEV_GREEN, expectedPhase: STATES.CODE_REVIEW },
    {
      from: STATES.CODE_REVIEW,
      out: { findings: [{ id: 'F1', action: 'defer', rationale: 'minor' }] },
      expectedPhase: STATES.STORY_DONE,
    },
    {
      from: STATES.CODE_REVIEW,
      out: { findings: [{ id: 'F1', action: 'patch', rationale: 'fix' }] },
      expectedPhase: STATES.PATCH_APPLY,
    },
    { from: STATES.PATCH_APPLY, expectedPhase: STATES.PATCH_RETEST },
    {
      from: STATES.PATCH_RETEST,
      out: { remaining_findings: [] },
      expectedPhase: STATES.STORY_DONE,
    },
    {
      from: STATES.PATCH_RETEST,
      out: { remaining_findings: [{ action: 'block' }] },
      expectedPhase: STATES.CODE_REVIEW,
    },
    { from: STATES.STORY_DONE, expectedPhase: STATES.EPIC_BOUNDARY_CHECK },
    { from: STATES.EPIC_BOUNDARY_CHECK, expectedPhase: STATES.RETROSPECTIVE },
    {
      from: STATES.EPIC_BOUNDARY_CHECK,
      out: { remaining_stories_in_epic: 0 } /* sprint not complete */,
      expectedPhase: STATES.RETROSPECTIVE,
    },
  ];

  for (const row of rows) {
    it(`${row.from} → ${row.expectedPhase}${row.out ? ` (with output ${JSON.stringify(row.out)})` : ''}`, () => {
      const r = interpretSignal(
        st(row.from),
        { status: 'success', output: row.out || {} },
        MEDIUM(),
      );
      expect(r.verdict).toBe('advanced');
      expect(r.newState.phase).toBe(row.expectedPhase);
    });
  }
});

describe('success — sprint completion routes to SPRINT_FINALIZE_PENDING', () => {
  it('RETROSPECTIVE with sprint_is_complete=true halts to finalize-pending', () => {
    const r = interpretSignal(
      st(STATES.RETROSPECTIVE, { sprint_is_complete: true }),
      { status: 'success' },
      MEDIUM(),
    );
    expect(r.newState.phase).toBe(STATES.SPRINT_FINALIZE_PENDING);
    expect(r.verdict).toBe('halt');
  });

  it('EPIC_BOUNDARY_CHECK with mode=skip + sprint_complete → finalize-pending', () => {
    const profile = { ...MEDIUM(), retrospective_mode: 'skip' };
    const r = interpretSignal(
      st(STATES.EPIC_BOUNDARY_CHECK, { sprint_is_complete: true }),
      { status: 'success' },
      profile,
    );
    expect(r.newState.phase).toBe(STATES.SPRINT_FINALIZE_PENDING);
  });
});

// ---------------------------------------------------------------- verify trust boundary

describe('success × verify.js rejection', () => {
  for (const phase of FULL_FLOW_PHASES) {
    if (phase === STATES.EPIC_BOUNDARY_CHECK) continue; // no verifier
    it(`${phase}: verify.ok=false within budget → retry`, () => {
      const r = interpretSignal(st(phase), { status: 'success' }, MEDIUM(), {
        ok: false,
        issues: ['something'],
      });
      expect(r.verdict).toBe('retry');
      expect(r.newState.phase).toBe(phase);
      expect(r.newState.verify_reject_count).toBe(1);
    });

    it(`${phase}: verify.ok=false at budget → prompted`, () => {
      const state = st(phase, { verify_reject_count: 2 }); // medium budget=3
      const r = interpretSignal(state, { status: 'success' }, MEDIUM(), {
        ok: false,
        issues: ['boom'],
      });
      expect(r.verdict).toBe('prompted');
      expect((r.nextAction as Record<string, unknown>).reason).toBe(
        'verify_reject_budget_exceeded',
      );
    });
  }
});

// ---------------------------------------------------------------- failure rows

describe('failure × phases × budgets', () => {
  for (const phase of FULL_FLOW_PHASES) {
    if (phase === STATES.EPIC_BOUNDARY_CHECK) continue;
    it(`${phase}: failure(recoverable=true) within budget → retry + carries diagnosis`, () => {
      const r = interpretSignal(
        st(phase),
        { status: 'failure', reason: 'x', diagnosis: 'y', recoverable: true },
        MEDIUM(),
      );
      expect(r.verdict).toBe('retry');
      expect(r.newState.prior_diagnosis).toBe('y');
      expect(r.newState.retry_count_this_phase).toBe(1);
    });

    it(`${phase}: failure(recoverable=false) → immediate user_prompt`, () => {
      const r = interpretSignal(
        st(phase),
        { status: 'failure', reason: 'x', diagnosis: 'y', recoverable: false },
        MEDIUM(),
      );
      expect(r.verdict).toBe('prompted');
    });

    it(`${phase}: failure at budget exhausted → user_prompt`, () => {
      const state = st(phase, { retry_count_this_phase: 2 });
      const r = interpretSignal(
        state,
        { status: 'failure', reason: 'x', diagnosis: 'y', recoverable: true },
        MEDIUM(),
      );
      expect(r.verdict).toBe('prompted');
      expect((r.nextAction as Record<string, unknown>).reason).toBe('retry_budget_exhausted');
    });
  }
});

// ---------------------------------------------------------------- blocker matrix

describe('blocked × TRUE BLOCKER kinds × phases', () => {
  const TRUE_BLOCKERS = [
    'creative_user_input_required',
    'new_external_dependency',
    'security_architectural_decision',
    'contradictory_acceptance_criteria',
  ];

  for (const phase of [STATES.DEV_RED, STATES.DEV_GREEN, STATES.CODE_REVIEW]) {
    for (const kind of TRUE_BLOCKERS) {
      it(`${phase}: blocked(${kind}) → user_prompt regardless of user_input_needed`, () => {
        const r = interpretSignal(
          st(phase),
          { status: 'blocked', blocker_kind: kind, user_input_needed: false, details: 'd' },
          MEDIUM(),
        );
        expect(r.verdict).toBe('prompted');
        expect((r.nextAction as Record<string, unknown>).reason).toBe(kind);
      });
    }
  }
});

describe('blocked × consecutive_test_failures counting', () => {
  for (let count = 1; count <= CONSECUTIVE_TEST_FAILURE_THRESHOLD + 1; count += 1) {
    const expected = count >= CONSECUTIVE_TEST_FAILURE_THRESHOLD ? 'prompted' : 'retry';
    it(`count=${count} → ${expected}`, () => {
      const r = interpretSignal(
        st(STATES.DEV_GREEN, { consecutive_test_failures: count - 1 }),
        {
          status: 'blocked',
          blocker_kind: 'consecutive_test_failures',
          consecutive_count: count,
        },
        MEDIUM(),
      );
      expect(r.verdict).toBe(expected);
    });
  }

  it('orchestrator tracks count independently — LLM under-reporting still triggers', () => {
    // Orchestrator has 2; LLM says 1; tracked = max(1, 2+1) = 3 → prompted.
    const r = interpretSignal(
      st(STATES.DEV_GREEN, { consecutive_test_failures: 2 }),
      { status: 'blocked', blocker_kind: 'consecutive_test_failures', consecutive_count: 1 },
      MEDIUM(),
    );
    expect(r.verdict).toBe('prompted');
  });
});

describe('blocked × recoverable kinds', () => {
  it('missing_dependency → run_script + retry', () => {
    const r = interpretSignal(
      st(STATES.DEV_GREEN),
      { status: 'blocked', blocker_kind: 'missing_dependency', user_input_needed: false },
      MEDIUM(),
    );
    expect(r.verdict).toBe('retry');
    expect((r.nextAction as Record<string, unknown>).type).toBe('run_script');
  });

  it('user_input_needed=true on ANY kind → user_prompt', () => {
    const r = interpretSignal(
      st(STATES.DEV_RED),
      {
        status: 'blocked',
        blocker_kind: 'unknown',
        user_input_needed: true,
        details: 'help me',
      },
      MEDIUM(),
    );
    expect(r.verdict).toBe('prompted');
  });

  it('failed_invariant → user_prompt (no automatic recovery)', () => {
    const r = interpretSignal(
      st(STATES.DEV_GREEN),
      {
        status: 'blocked',
        blocker_kind: 'failed_invariant',
        user_input_needed: false,
        details: 'invariant X failed',
      },
      MEDIUM(),
    );
    expect(r.verdict).toBe('prompted');
  });
});

// ---------------------------------------------------------------- propose_alternative matrix

describe('propose_alternative × impact classification', () => {
  it('whitelist-only arg diff → low → auto-accept', () => {
    const r = interpretSignal(
      st(STATES.DEV_GREEN),
      {
        status: 'propose_alternative',
        reason: 'tweak retry',
        alternative: {
          type: 'invoke_skill',
          skill: 'bmad-dev-story',
          args: { retry_budget: 5, action_id: 'a-2' },
        },
      },
      MEDIUM(),
    );
    expect(r.verdict).toBe('advanced');
    expect((r.nextAction as Record<string, unknown>)._impact).toBe('low');
  });

  it('non-whitelist arg diff → medium → user_prompt', () => {
    const r = interpretSignal(
      st(STATES.DEV_GREEN),
      {
        status: 'propose_alternative',
        reason: 'switch framework',
        alternative: {
          type: 'invoke_skill',
          skill: 'bmad-dev-story',
          args: { test_framework: 'vitest' },
        },
      },
      MEDIUM(),
    );
    expect(r.verdict).toBe('prompted');
    expect((r.nextAction as Record<string, unknown>).impact).toBe('medium');
  });

  it('different action type → high → user_prompt', () => {
    const r = interpretSignal(
      st(STATES.DEV_GREEN),
      {
        status: 'propose_alternative',
        reason: 'switch to script',
        alternative: { type: 'run_script', command: ['node', 'foo.js'] },
      },
      MEDIUM(),
    );
    expect(r.verdict).toBe('prompted');
    expect((r.nextAction as Record<string, unknown>).impact).toBe('high');
  });

  it('urgency_hint can raise low → high', () => {
    const r = interpretSignal(
      st(STATES.DEV_GREEN),
      {
        status: 'propose_alternative',
        reason: 'urgent',
        urgency_hint: 'high',
        alternative: {
          type: 'invoke_skill',
          skill: 'bmad-dev-story',
          args: { retry_budget: 5 },
        },
      },
      MEDIUM(),
    );
    expect(r.verdict).toBe('prompted');
    expect((r.nextAction as Record<string, unknown>).impact).toBe('high');
  });

  it('urgency_hint cannot lower high', () => {
    const r = interpretSignal(
      st(STATES.DEV_GREEN),
      {
        status: 'propose_alternative',
        reason: 'tweak',
        urgency_hint: 'low',
        alternative: { type: 'run_script', command: ['node'] },
      },
      MEDIUM(),
    );
    expect(r.verdict).toBe('prompted');
    expect((r.nextAction as Record<string, unknown>).impact).toBe('high');
  });
});

// ---------------------------------------------------------------- verify_override

describe('verify_override boundary', () => {
  it('augmented verify ok=true → accepted as success → advances', () => {
    const r = interpretSignal(
      st(STATES.DEV_RED),
      {
        status: 'verify_override',
        evidence: { decision_log_ref: 'DEC-007', explanation: 'renamed' },
      },
      MEDIUM(),
      { ok: true },
    );
    expect(r.verdict).toBe('advanced');
    expect(r.newState.phase).toBe(STATES.DEV_GREEN);
  });

  it('augmented verify ok=false → falls back to failure(recoverable=true)', () => {
    const r = interpretSignal(
      st(STATES.DEV_RED),
      { status: 'verify_override', evidence: { explanation: 'no good reason' } },
      MEDIUM(),
      { ok: false, issues: ['still bad'] },
    );
    expect(r.verdict).toBe('retry');
    expect(r.newState.prior_diagnosis).toBe('augmented verify.js still failed');
  });
});

// ---------------------------------------------------------------- user_input

describe('user_input × command kinds', () => {
  const commandSet = [
    [{ kind: 'skip_story', story_key: 'S1' }],
    [{ kind: 'abort_sprint' }],
    [{ kind: 'force_continue', reason: 'I know what I want' }],
    [{ kind: 'change_profile', profile: 'medium' }],
    [{ kind: 'pause' }],
    [{ kind: 'override_decision', decision_id: 'DEC-007', new_value: 'use vitest' }],
  ];
  for (const commands of commandSet) {
    it(`emits apply_user_commands sideEffect for kind=${commands[0].kind}`, () => {
      const r = interpretSignal(st(STATES.DEV_RED), { status: 'user_input', commands }, MEDIUM());
      expect(r.sideEffects.some((e) => e.kind === 'apply_user_commands')).toBe(true);
    });
  }
});

// ---------------------------------------------------------------- nano escalation

describe('nano profile escalation', () => {
  it('NANO_QUICK_DEV success with tests_failed>0 → escalate to small', () => {
    const r = interpretSignal(
      st(STATES.NANO_QUICK_DEV),
      { status: 'success', output: { tests_failed: 1 } },
      NANO(),
    );
    expect(r.newProfile.name).toBe('small');
    expect(r.newProfile.escalated_from).toBe('nano');
    expect(r.newProfile.implementation_flow).toBe('full');
  });

  it('NANO_QUICK_DEV success with severity=high → escalate', () => {
    const r = interpretSignal(
      st(STATES.NANO_QUICK_DEV),
      { status: 'success', output: { severity: 'high' } },
      NANO(),
    );
    expect(r.newProfile.escalation_reason).toBe('high_severity');
  });

  it('NANO_QUICK_DEV success with tests_failed=0 + severity=low → no escalation', () => {
    const r = interpretSignal(
      st(STATES.NANO_QUICK_DEV),
      { status: 'success', output: { tests_failed: 0, severity: 'low' } },
      NANO(),
    );
    expect(r.newProfile.name).toBe('nano');
  });

  it('non-nano profile is untouched by escalation logic', () => {
    const r = interpretSignal(
      st(STATES.DEV_GREEN),
      { status: 'success', output: { tests_failed: 5, severity: 'high' } },
      MEDIUM(),
    );
    expect(r.newProfile.name).toBe('medium');
  });
});

// ---------------------------------------------------------------- decisions[] audit channel

describe('decisions[] audit channel — appends as a sideEffect on every status', () => {
  const decision = {
    category: 'test-strategy',
    impact: 'low',
    phase: 'dev-story:RED',
    decision: 'use vitest',
    rationale: 'matches repo',
  };
  const statuses = [
    { status: 'success' },
    { status: 'failure', reason: 'x', diagnosis: 'y', recoverable: true },
    { status: 'blocked', blocker_kind: 'unknown', user_input_needed: true, details: 'd' },
    {
      status: 'propose_alternative',
      reason: 'r',
      alternative: { type: 'invoke_skill', skill: 'x' },
    },
    { status: 'user_input', commands: [{ kind: 'pause' }] },
  ];

  for (const s of statuses) {
    it(`status=${s.status} with decisions[] → append_decisions sideEffect emitted`, () => {
      const r = interpretSignal(st(STATES.DEV_RED), { ...s, decisions: [decision] }, MEDIUM());
      expect(r.sideEffects.some((e) => e.kind === 'append_decisions')).toBe(true);
    });
  }
});

// ---------------------------------------------------------------- adversarial: hint tiebreaker

describe('next_skill_hint tiebreaker — adversarial', () => {
  it('fabricated hint pointing at a non-valid successor → ignored', () => {
    const r = interpretSignal(
      st(STATES.DEV_GREEN),
      { status: 'success', next_skill_hint: 'bmad-quick-dev' },
      MEDIUM(),
    );
    expect(r.newState.phase).toBe(STATES.CODE_REVIEW);
  });

  it('valid hint at a multi-successor state → honored', () => {
    const r = interpretSignal(
      st(STATES.CODE_REVIEW),
      {
        status: 'success',
        output: { findings: [] },
        next_skill_hint: 'bmad-dev-story:patch',
      },
      MEDIUM(),
    );
    expect(r.newState.phase).toBe(STATES.PATCH_APPLY);
  });

  it('hint NOT consulted when single successor (DEV_RED → DEV_GREEN)', () => {
    const r = interpretSignal(
      st(STATES.DEV_RED),
      { status: 'success', next_skill_hint: 'bmad-code-review' },
      MEDIUM(),
    );
    expect(r.newState.phase).toBe(STATES.DEV_GREEN);
  });
});

// ---------------------------------------------------------------- adversarial: invalid signals

describe('input validation — adversarial', () => {
  it('throws on missing signal.status', () => {
    expect(() =>
      interpretSignal(st(STATES.DEV_RED), {} as Record<string, unknown>, MEDIUM()),
    ).toThrow();
  });

  it('throws on unknown signal status', () => {
    expect(() => interpretSignal(st(STATES.DEV_RED), { status: 'mystery' }, MEDIUM())).toThrow();
  });
});

// ---------------------------------------------------------------- adversarial: state machine completeness

describe('every reachable phase has a deterministic transition for a clean success', () => {
  // EPIC_BOUNDARY_CHECK is a router state — exercise both branches.
  it('every phase from FULL_FLOW_PHASES yields a verdict (no silent drops)', () => {
    for (const phase of FULL_FLOW_PHASES) {
      const out: Record<string, unknown> = {};
      if (phase === STATES.CODE_REVIEW) out.findings = [];
      if (phase === STATES.PATCH_RETEST) out.remaining_findings = [];
      const r = interpretSignal(st(phase), { status: 'success', output: out }, MEDIUM());
      expect(['advanced', 'retry', 'prompted', 'halt']).toContain(r.verdict);
    }
  });
});

// ---------------------------------------------------------------- code_review blocking exit

describe('code_review blocking findings — bypasses successor', () => {
  it('any block finding → user_prompt with the blocking findings attached', () => {
    const r = interpretSignal(
      st(STATES.CODE_REVIEW),
      {
        status: 'success',
        output: {
          findings: [
            { id: 'B1', action: 'block', rationale: 'arch decision needed' },
            { id: 'F2', action: 'patch', rationale: 'minor' },
          ],
        },
      },
      MEDIUM(),
    );
    expect(r.verdict).toBe('prompted');
    expect((r.nextAction as Record<string, unknown>).reason).toBe('code_review_blocking_findings');
    expect((r.nextAction as Record<string, unknown>).findings).toHaveLength(1);
  });
});
