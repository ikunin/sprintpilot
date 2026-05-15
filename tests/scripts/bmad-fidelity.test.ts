/**
 * Phase 7 — BMad fidelity gate.
 *
 * Asserts the orchestrator preserves every load-bearing BMad behavior
 * documented in AGENTS.md and workflow.md. These tests are scripted
 * (no live LLM) — they drive interpretSignal directly through specific
 * scenarios and assert state transitions + side effects.
 *
 * Scenarios:
 *   1. Step-6 patch loop (CODE_REVIEW → PATCH_APPLY → PATCH_RETEST → STORY_DONE)
 *   2. Step-6 block path (CODE_REVIEW with block finding → user_prompt)
 *   3. Step-6 re-review loop (patch_retest with remaining blocking → back to CODE_REVIEW)
 *   4. Nano session-scoped escalation on tests_failed > 0
 *   5. Nano session-scoped escalation on severity=high (recorded as escalation_reason)
 *   6. Sprint completion → SPRINT_FINALIZE_PENDING (fresh-context handoff)
 *   7. 3 consecutive test failures → user_prompt
 *   8. Per-epic retrospective boundary detection
 *   9. retrospective_mode: stop → user_prompt at boundary
 *  10. retrospective_mode: skip + sprint_complete → straight to finalize-pending
 */

import { describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import adapt from '../../_Sprintpilot/lib/orchestrator/adapt.js';
// @ts-expect-error — CommonJS module
import profileRules from '../../_Sprintpilot/lib/orchestrator/profile-rules.js';
// @ts-expect-error — CommonJS module
import sm from '../../_Sprintpilot/lib/orchestrator/state-machine.js';

const { interpretSignal } = adapt as {
  interpretSignal: (
    state: Record<string, unknown>,
    signal: Record<string, unknown>,
    profile: Record<string, unknown>,
    verifyResult?: { ok: boolean; issues?: string[] },
  ) => {
    newState: Record<string, unknown>;
    newProfile: Record<string, unknown>;
    nextAction: Record<string, unknown>;
    sideEffects: Record<string, unknown>[];
    verdict: 'advanced' | 'retry' | 'prompted' | 'halt';
  };
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
    story_file_path: '/r/S1.md',
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

describe('BMad step-6 patch loop is enforced (not folded into bmad-code-review)', () => {
  it('CODE_REVIEW with patch findings → PATCH_APPLY (step 6a)', () => {
    const r = interpretSignal(
      st(STATES.CODE_REVIEW),
      {
        status: 'success',
        output: {
          findings: [
            { id: 'F1', action: 'patch', rationale: 'lint' },
            { id: 'F2', action: 'defer', rationale: 'minor' },
          ],
        },
      },
      MEDIUM(),
    );
    expect(r.newState.phase).toBe(STATES.PATCH_APPLY);
    // Only the patch finding carries forward — defer is dropped.
    expect(r.newState.patch_findings).toEqual([{ id: 'F1', action: 'patch', rationale: 'lint' }]);
  });

  it('PATCH_APPLY → PATCH_RETEST unconditionally (step 6b is mandatory)', () => {
    const r = interpretSignal(
      st(STATES.PATCH_APPLY, { patch_findings: [{ id: 'F1', action: 'patch' }] }),
      { status: 'success', output: {} },
      MEDIUM(),
    );
    expect(r.newState.phase).toBe(STATES.PATCH_RETEST);
  });

  it('PATCH_RETEST clean → STORY_DONE (step 7)', () => {
    const r = interpretSignal(
      st(STATES.PATCH_RETEST),
      { status: 'success', output: { remaining_findings: [] } },
      MEDIUM(),
    );
    expect(r.newState.phase).toBe(STATES.STORY_DONE);
  });

  it('PATCH_RETEST with remaining block → loops back to CODE_REVIEW', () => {
    const r = interpretSignal(
      st(STATES.PATCH_RETEST),
      {
        status: 'success',
        output: { remaining_findings: [{ id: 'B1', action: 'block', rationale: 'arch' }] },
      },
      MEDIUM(),
    );
    expect(r.newState.phase).toBe(STATES.CODE_REVIEW);
  });

  it('step 6 is NOT skipped — clean review (no patch findings) goes STORY_DONE directly', () => {
    const r = interpretSignal(
      st(STATES.CODE_REVIEW),
      { status: 'success', output: { findings: [{ id: 'F1', action: 'defer' }] } },
      MEDIUM(),
    );
    expect(r.newState.phase).toBe(STATES.STORY_DONE);
  });
});

describe('CODE_REVIEW block path: user-prompted, never auto-skipped', () => {
  it('any block finding pauses for user; PATCH_APPLY is NOT entered', () => {
    const r = interpretSignal(
      st(STATES.CODE_REVIEW),
      {
        status: 'success',
        output: {
          findings: [
            { id: 'B1', action: 'block', rationale: 'arch decision needed' },
            { id: 'F2', action: 'patch', rationale: 'unrelated' },
          ],
        },
      },
      MEDIUM(),
    );
    expect(r.verdict).toBe('prompted');
    expect(r.newState.phase).toBe(STATES.CODE_REVIEW); // not advanced
    expect((r.nextAction as Record<string, unknown>).reason).toBe('code_review_blocking_findings');
  });
});

describe('Nano profile session-scoped escalation', () => {
  it('tests_failed > 0 → escalates to small in-session', () => {
    const r = interpretSignal(
      st(STATES.NANO_QUICK_DEV),
      { status: 'success', output: { tests_failed: 1 } },
      NANO(),
    );
    expect(r.newProfile.name).toBe('small');
    expect(r.newProfile.escalated_from).toBe('nano');
    expect(r.newProfile.implementation_flow).toBe('full');
    // The original profile object is unchanged (no mutation).
    const original = NANO();
    expect(original.name).toBe('nano');
  });

  it('severity=high → records escalation_reason=high_severity', () => {
    const r = interpretSignal(
      st(STATES.NANO_QUICK_DEV),
      { status: 'success', output: { severity: 'high' } },
      NANO(),
    );
    expect(r.newProfile.escalation_reason).toBe('high_severity');
  });

  it('escalation produces a profile_escalated sideEffect for the ledger', () => {
    const r = interpretSignal(
      st(STATES.NANO_QUICK_DEV),
      { status: 'success', output: { tests_failed: 3 } },
      NANO(),
    );
    expect(r.sideEffects).toContainEqual(
      expect.objectContaining({ kind: 'profile_escalated', from: 'nano', to: 'small' }),
    );
  });
});

describe('Sprint finalize-pending handoff (fresh-context guarantee)', () => {
  it('RETROSPECTIVE with sprint_is_complete=true → halts to finalize-pending', () => {
    const r = interpretSignal(
      st(STATES.RETROSPECTIVE, { sprint_is_complete: true }),
      { status: 'success' },
      MEDIUM(),
    );
    expect(r.newState.phase).toBe(STATES.SPRINT_FINALIZE_PENDING);
    expect(r.verdict).toBe('halt');
  });

  it('EPIC_BOUNDARY_CHECK with retro=skip + sprint_complete → halts to finalize-pending', () => {
    const profile = { ...MEDIUM(), retrospective_mode: 'skip' };
    const r = interpretSignal(
      st(STATES.EPIC_BOUNDARY_CHECK, { sprint_is_complete: true }),
      { status: 'success' },
      profile,
    );
    expect(r.newState.phase).toBe(STATES.SPRINT_FINALIZE_PENDING);
  });
});

describe('Three-consecutive-test-failures TRUE BLOCKER', () => {
  it('count=2 → retry (orchestrator increments tracked count)', () => {
    const r = interpretSignal(
      st(STATES.DEV_GREEN, { consecutive_test_failures: 1 }),
      { status: 'blocked', blocker_kind: 'consecutive_test_failures', consecutive_count: 2 },
      MEDIUM(),
    );
    expect(r.verdict).toBe('retry');
    expect(r.newState.consecutive_test_failures).toBe(2);
  });

  it('count=3 → user_prompt with documented reason', () => {
    const r = interpretSignal(
      st(STATES.DEV_GREEN, { consecutive_test_failures: 2 }),
      { status: 'blocked', blocker_kind: 'consecutive_test_failures', consecutive_count: 3 },
      MEDIUM(),
    );
    expect(r.verdict).toBe('prompted');
    expect((r.nextAction as Record<string, unknown>).reason).toBe(
      'consecutive_test_failures_threshold',
    );
  });

  it('LLM-side under-reporting still triggers (orchestrator tracks independently)', () => {
    const r = interpretSignal(
      st(STATES.DEV_GREEN, { consecutive_test_failures: 2 }),
      { status: 'blocked', blocker_kind: 'consecutive_test_failures', consecutive_count: 1 },
      MEDIUM(),
    );
    expect(r.verdict).toBe('prompted');
  });
});

describe('Per-epic retrospective boundary', () => {
  it('mid-epic STORY_DONE → next story (PREPARE_STORY_BRANCH under default git settings)', () => {
    // STORY_DONE → EPIC_BOUNDARY_CHECK → PREPARE_STORY_BRANCH
    // (default profile: granularity=story, reuse_user_branch=false).
    // PREPARE_STORY_BRANCH then advances to CREATE_STORY once the branch
    // exists — that transition is covered in state-machine.test.ts.
    const afterStoryDone = interpretSignal(st(STATES.STORY_DONE), { status: 'success' }, MEDIUM());
    expect(afterStoryDone.newState.phase).toBe(STATES.EPIC_BOUNDARY_CHECK);

    const afterEpicCheck = interpretSignal(
      st(STATES.EPIC_BOUNDARY_CHECK, { remaining_stories_in_epic: 2 }),
      { status: 'success' },
      MEDIUM(),
    );
    expect(afterEpicCheck.newState.phase).toBe(STATES.PREPARE_STORY_BRANCH);
  });

  it('end-of-epic EPIC_BOUNDARY_CHECK → RETROSPECTIVE (retro=auto)', () => {
    const r = interpretSignal(
      st(STATES.EPIC_BOUNDARY_CHECK, { remaining_stories_in_epic: 0 }),
      { status: 'success' },
      MEDIUM(),
    );
    expect(r.newState.phase).toBe(STATES.RETROSPECTIVE);
  });

  it('retrospective_mode=skip + mid-sprint → next story (PREPARE_STORY_BRANCH)', () => {
    // Same routing rationale as mid-epic STORY_DONE: under default git
    // settings the next-story start phase is PREPARE_STORY_BRANCH, which
    // then advances to CREATE_STORY.
    const profile = { ...MEDIUM(), retrospective_mode: 'skip' };
    const r = interpretSignal(
      st(STATES.EPIC_BOUNDARY_CHECK, {
        remaining_stories_in_epic: 0,
        sprint_is_complete: false,
      }),
      { status: 'success' },
      profile,
    );
    expect(r.newState.phase).toBe(STATES.PREPARE_STORY_BRANCH);
  });
});

describe('All 5 documented TRUE BLOCKERS map to user_prompt', () => {
  const TRUE_BLOCKERS = [
    'creative_user_input_required', // workflow.md:79
    'new_external_dependency', // workflow.md:80
    'consecutive_test_failures', // workflow.md:81 (counting, but at threshold)
    'security_architectural_decision', // workflow.md:82
    'contradictory_acceptance_criteria', // workflow.md:83
  ];
  for (const kind of TRUE_BLOCKERS) {
    it(`blocker_kind=${kind} pauses for user`, () => {
      const signal: Record<string, unknown> = {
        status: 'blocked',
        blocker_kind: kind,
        user_input_needed: false,
        details: 'd',
      };
      if (kind === 'consecutive_test_failures') signal.consecutive_count = 3;
      const r = interpretSignal(
        st(
          STATES.DEV_GREEN,
          kind === 'consecutive_test_failures' ? { consecutive_test_failures: 2 } : {},
        ),
        signal,
        MEDIUM(),
      );
      expect(r.verdict).toBe('prompted');
    });
  }
});

describe('Decision-log audit channel is honored across the full BMad cycle', () => {
  it('decisions[] appended at every BMad phase', () => {
    const phases = [
      STATES.CREATE_STORY,
      STATES.DEV_RED,
      STATES.DEV_GREEN,
      STATES.CODE_REVIEW,
      STATES.PATCH_APPLY,
      STATES.PATCH_RETEST,
      STATES.STORY_DONE,
      STATES.RETROSPECTIVE,
    ];
    for (const phase of phases) {
      const r = interpretSignal(
        st(phase, { patch_findings: phase === STATES.PATCH_APPLY ? [{ id: 'F1' }] : null }),
        {
          status: 'success',
          output:
            phase === STATES.CODE_REVIEW
              ? { findings: [] }
              : phase === STATES.PATCH_RETEST
                ? { remaining_findings: [] }
                : {},
          decisions: [
            {
              category: 'test-strategy',
              impact: 'low',
              phase: `${phase}:audit`,
              decision: `at ${phase}`,
              rationale: 'phase coverage',
            },
          ],
        },
        MEDIUM(),
      );
      expect(r.sideEffects.some((e) => e.kind === 'append_decisions')).toBe(true);
    }
  });
});

describe('Land-as-you-go: BMad-faithful merge integration', () => {
  const LAND_PROFILE = () => ({ ...MEDIUM(), merge_strategy: 'land_as_you_go' });

  it('default (stacked) does NOT enter STORY_LAND', () => {
    const r = interpretSignal(st(STATES.STORY_DONE), { status: 'success' }, MEDIUM());
    expect(r.newState.phase).toBe(STATES.EPIC_BOUNDARY_CHECK);
  });

  it('land_as_you_go threads STORY_DONE → STORY_LAND → EPIC_BOUNDARY_CHECK', () => {
    const r1 = interpretSignal(st(STATES.STORY_DONE), { status: 'success' }, LAND_PROFILE());
    expect(r1.newState.phase).toBe(STATES.STORY_LAND);
    const r2 = interpretSignal(st(STATES.STORY_LAND), { status: 'success' }, LAND_PROFILE());
    expect(r2.newState.phase).toBe(STATES.EPIC_BOUNDARY_CHECK);
  });

  it('rebase-conflict halt: failure(recoverable=true) past budget → user_prompt', () => {
    const r = interpretSignal(
      st(STATES.STORY_LAND, { retry_count_this_phase: 99 }),
      {
        status: 'failure',
        reason: 'rebase_conflict',
        diagnosis: 'CONFLICT (content): src/app.ts',
        recoverable: true,
      },
      LAND_PROFILE(),
    );
    expect(r.verdict).toBe('prompted');
    expect(r.newState.prior_diagnosis).toContain('CONFLICT');
  });

  it('rebase-conflict halt is resumable: subsequent success advances to EPIC_BOUNDARY_CHECK', () => {
    // After user resolves, autopilot resumes STORY_LAND with a fresh success.
    const r = interpretSignal(st(STATES.STORY_LAND), { status: 'success' }, LAND_PROFILE());
    expect(r.newState.phase).toBe(STATES.EPIC_BOUNDARY_CHECK);
    expect(r.verdict).toBe('advanced');
  });
});
