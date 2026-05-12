import { describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS module
import profileRules from '../../../_Sprintpilot/lib/orchestrator/profile-rules.js';
// @ts-expect-error — CommonJS module
import sm from '../../../_Sprintpilot/lib/orchestrator/state-machine.js';

type Profile = Record<string, unknown>;
type State = Record<string, unknown>;
type Action = Record<string, unknown>;

const { STATES, nextAction, nextStateAfterSuccess, nextStoryStart, HINT_TO_PHASE } = sm as {
  STATES: Record<string, string>;
  nextAction: (state: State, profile: Profile) => Action;
  nextStateAfterSuccess: (
    state: State,
    profile: Profile,
    signal: Record<string, unknown>,
  ) => string | null;
  nextStoryStart: (profile: Profile) => string;
  HINT_TO_PHASE: Record<string, string>;
};

const { flatToProfile } = profileRules as {
  flatToProfile: (resolved: unknown, name: string) => Profile;
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

function baseState(phase: string, extra: Partial<State> = {}): State {
  return {
    phase,
    story_key: 'S1.2',
    story_file_path: '/repo/_bmad-output/stories/S1.2.md',
    current_epic: 'E1',
    ac_summary: 'Login button reads accessible label',
    prior_diagnosis: null,
    relevant_decisions: [],
    prior_signals_summary: null,
    patch_findings: null,
    tests_to_rerun: null,
    remaining_stories_in_epic: 0,
    sprint_is_complete: false,
    ...extra,
  };
}

describe('nextAction — emits the canonical action per state (full flow)', () => {
  const p = medium();
  it('CREATE_STORY → invoke_skill bmad-create-story', () => {
    const a = nextAction(baseState(STATES.CREATE_STORY), p);
    expect(a.type).toBe('invoke_skill');
    expect(a.skill).toBe('bmad-create-story');
    expect(a.template_slots).toMatchObject({ story_key: 'S1.2', profile_name: 'medium' });
  });

  it('CHECK_READINESS → invoke_skill bmad-check-implementation-readiness', () => {
    const a = nextAction(baseState(STATES.CHECK_READINESS), p);
    expect(a.skill).toBe('bmad-check-implementation-readiness');
  });

  it('DEV_RED uses red template', () => {
    const a = nextAction(baseState(STATES.DEV_RED), p);
    expect(a.skill).toBe('bmad-dev-story');
    expect(a.template).toContain('red');
  });

  it('DEV_GREEN uses green template', () => {
    const a = nextAction(baseState(STATES.DEV_GREEN), p);
    expect(a.template).toContain('green');
  });

  it('CODE_REVIEW → bmad-code-review', () => {
    const a = nextAction(baseState(STATES.CODE_REVIEW), p);
    expect(a.skill).toBe('bmad-code-review');
  });

  it('PATCH_APPLY → bmad-dev-story with patch phase', () => {
    const a = nextAction(baseState(STATES.PATCH_APPLY), p);
    expect(a.skill).toBe('bmad-dev-story');
    expect(a.template).toContain('patch');
  });

  it('PATCH_RETEST → bmad-dev-story with rereview phase', () => {
    const a = nextAction(baseState(STATES.PATCH_RETEST), p);
    expect(a.skill).toBe('bmad-dev-story');
    expect(a.template).toContain('rereview');
  });

  it('STORY_DONE → git_op commit_and_push_story', () => {
    const a = nextAction(baseState(STATES.STORY_DONE), p);
    expect(a.type).toBe('git_op');
    expect(a.op).toBe('commit_and_push_story');
  });

  it('EPIC_BOUNDARY_CHECK emits noop (orchestrator advances state machine)', () => {
    const a = nextAction(baseState(STATES.EPIC_BOUNDARY_CHECK), p);
    expect(a.type).toBe('noop');
  });

  it('RETROSPECTIVE (mode=auto) → invoke_skill bmad-retrospective', () => {
    const a = nextAction(baseState(STATES.RETROSPECTIVE), p);
    expect(a.type).toBe('invoke_skill');
    expect(a.skill).toBe('bmad-retrospective');
  });

  it('RETROSPECTIVE (mode=stop) → user_prompt', () => {
    const stopProfile = { ...medium(), retrospective_mode: 'stop' } as Profile;
    const a = nextAction(baseState(STATES.RETROSPECTIVE), stopProfile);
    expect(a.type).toBe('user_prompt');
  });

  it('SPRINT_FINALIZE_PENDING → halt with handoff flag', () => {
    const a = nextAction(baseState(STATES.SPRINT_FINALIZE_PENDING), p);
    expect(a.type).toBe('halt');
    expect(a.handoff).toBe('sprint_finalize_pending');
  });
});

describe('nextAction — nano flow', () => {
  it('NANO_QUICK_DEV → invoke_skill bmad-quick-dev', () => {
    const a = nextAction(baseState(STATES.NANO_QUICK_DEV), nano());
    expect(a.skill).toBe('bmad-quick-dev');
  });

  it('nextStoryStart returns NANO_QUICK_DEV for quick flow', () => {
    expect(nextStoryStart(nano())).toBe(STATES.NANO_QUICK_DEV);
  });

  it('nextStoryStart returns CREATE_STORY for full flow', () => {
    expect(nextStoryStart(medium())).toBe(STATES.CREATE_STORY);
  });
});

describe('nextAction — sprint completion short-circuit', () => {
  it('emits halt with handoff when sprint_is_complete and not already finalize-pending', () => {
    const a = nextAction(baseState(STATES.CREATE_STORY, { sprint_is_complete: true }), medium());
    expect(a.type).toBe('halt');
    expect(a.handoff).toBe('sprint_finalize_pending');
  });
});

describe('nextStateAfterSuccess — deterministic transitions', () => {
  const p = medium();
  const np = nano();

  it('CREATE_STORY → CHECK_READINESS', () => {
    const next = nextStateAfterSuccess(baseState(STATES.CREATE_STORY), p, { status: 'success' });
    expect(next).toBe(STATES.CHECK_READINESS);
  });

  it('CHECK_READINESS → DEV_RED', () => {
    expect(nextStateAfterSuccess(baseState(STATES.CHECK_READINESS), p, { status: 'success' })).toBe(
      STATES.DEV_RED,
    );
  });

  it('DEV_RED → DEV_GREEN', () => {
    expect(nextStateAfterSuccess(baseState(STATES.DEV_RED), p, { status: 'success' })).toBe(
      STATES.DEV_GREEN,
    );
  });

  it('DEV_GREEN → CODE_REVIEW', () => {
    expect(nextStateAfterSuccess(baseState(STATES.DEV_GREEN), p, { status: 'success' })).toBe(
      STATES.CODE_REVIEW,
    );
  });

  it('CODE_REVIEW (no patch findings) → STORY_DONE', () => {
    expect(
      nextStateAfterSuccess(baseState(STATES.CODE_REVIEW), p, {
        status: 'success',
        output: { findings: [{ action: 'defer' }] },
      }),
    ).toBe(STATES.STORY_DONE);
  });

  it('CODE_REVIEW (with patch findings) → PATCH_APPLY', () => {
    expect(
      nextStateAfterSuccess(baseState(STATES.CODE_REVIEW), p, {
        status: 'success',
        output: { findings: [{ action: 'patch' }] },
      }),
    ).toBe(STATES.PATCH_APPLY);
  });

  it('CODE_REVIEW (with blocking findings) → null (pause for user_prompt)', () => {
    expect(
      nextStateAfterSuccess(baseState(STATES.CODE_REVIEW), p, {
        status: 'success',
        output: { findings: [{ action: 'block' }] },
      }),
    ).toBeNull();
  });

  it('PATCH_APPLY → PATCH_RETEST unconditionally', () => {
    expect(nextStateAfterSuccess(baseState(STATES.PATCH_APPLY), p, { status: 'success' })).toBe(
      STATES.PATCH_RETEST,
    );
  });

  it('PATCH_RETEST → STORY_DONE when no blocking remains', () => {
    expect(
      nextStateAfterSuccess(baseState(STATES.PATCH_RETEST), p, {
        status: 'success',
        output: { remaining_findings: [] },
      }),
    ).toBe(STATES.STORY_DONE);
  });

  it('PATCH_RETEST → CODE_REVIEW when blocking still remains', () => {
    expect(
      nextStateAfterSuccess(baseState(STATES.PATCH_RETEST), p, {
        status: 'success',
        output: { remaining_findings: [{ action: 'block' }] },
      }),
    ).toBe(STATES.CODE_REVIEW);
  });

  it('STORY_DONE → EPIC_BOUNDARY_CHECK', () => {
    expect(nextStateAfterSuccess(baseState(STATES.STORY_DONE), p, { status: 'success' })).toBe(
      STATES.EPIC_BOUNDARY_CHECK,
    );
  });

  it('EPIC_BOUNDARY_CHECK end-of-epic → RETROSPECTIVE (mode auto)', () => {
    expect(
      nextStateAfterSuccess(baseState(STATES.EPIC_BOUNDARY_CHECK), p, { status: 'success' }),
    ).toBe(STATES.RETROSPECTIVE);
  });

  it('EPIC_BOUNDARY_CHECK end-of-epic, mode=skip, sprint not complete → next story start (full)', () => {
    const sp = { ...medium(), retrospective_mode: 'skip' } as Profile;
    expect(
      nextStateAfterSuccess(baseState(STATES.EPIC_BOUNDARY_CHECK), sp, { status: 'success' }),
    ).toBe(STATES.CREATE_STORY);
  });

  it('EPIC_BOUNDARY_CHECK end-of-epic, mode=skip, sprint complete → SPRINT_FINALIZE_PENDING', () => {
    const sp = { ...medium(), retrospective_mode: 'skip' } as Profile;
    expect(
      nextStateAfterSuccess(
        baseState(STATES.EPIC_BOUNDARY_CHECK, { sprint_is_complete: true }),
        sp,
        { status: 'success' },
      ),
    ).toBe(STATES.SPRINT_FINALIZE_PENDING);
  });

  it('EPIC_BOUNDARY_CHECK with more stories in epic → next story start', () => {
    expect(
      nextStateAfterSuccess(
        baseState(STATES.EPIC_BOUNDARY_CHECK, { remaining_stories_in_epic: 2 }),
        p,
        { status: 'success' },
      ),
    ).toBe(STATES.CREATE_STORY);
  });

  it('RETROSPECTIVE → next story start when sprint not complete', () => {
    expect(nextStateAfterSuccess(baseState(STATES.RETROSPECTIVE), p, { status: 'success' })).toBe(
      STATES.CREATE_STORY,
    );
  });

  it('RETROSPECTIVE → SPRINT_FINALIZE_PENDING when sprint complete', () => {
    expect(
      nextStateAfterSuccess(baseState(STATES.RETROSPECTIVE, { sprint_is_complete: true }), p, {
        status: 'success',
      }),
    ).toBe(STATES.SPRINT_FINALIZE_PENDING);
  });

  it('NANO_QUICK_DEV → STORY_DONE', () => {
    expect(nextStateAfterSuccess(baseState(STATES.NANO_QUICK_DEV), np, { status: 'success' })).toBe(
      STATES.STORY_DONE,
    );
  });
});

describe('next_skill_hint tiebreaker', () => {
  const p = medium();

  it('honors a valid hint when state has multiple successors (CODE_REVIEW)', () => {
    // Deterministic answer (no findings) would be STORY_DONE. Hint says PATCH_APPLY,
    // which is structurally valid → hint wins.
    const next = nextStateAfterSuccess(baseState(STATES.CODE_REVIEW), p, {
      status: 'success',
      output: { findings: [] },
      next_skill_hint: 'bmad-dev-story:patch',
    });
    expect(next).toBe(STATES.PATCH_APPLY);
  });

  it('ignores an invalid hint and uses the deterministic answer', () => {
    const next = nextStateAfterSuccess(baseState(STATES.CODE_REVIEW), p, {
      status: 'success',
      output: { findings: [] },
      next_skill_hint: 'bmad-quick-dev', // not a valid successor of CODE_REVIEW
    });
    expect(next).toBe(STATES.STORY_DONE);
  });

  it('does NOT consult hint when there is only one structural successor', () => {
    const next = nextStateAfterSuccess(baseState(STATES.DEV_RED), p, {
      status: 'success',
      next_skill_hint: 'bmad-code-review',
    });
    expect(next).toBe(STATES.DEV_GREEN);
  });

  it('HINT_TO_PHASE exposes the documented mapping', () => {
    expect(HINT_TO_PHASE['bmad-create-story']).toBe(STATES.CREATE_STORY);
    expect(HINT_TO_PHASE['bmad-dev-story:red']).toBe(STATES.DEV_RED);
    expect(HINT_TO_PHASE['bmad-code-review']).toBe(STATES.CODE_REVIEW);
  });
});

describe('template slots — LLM intelligence channel', () => {
  it('passes prior_diagnosis and relevant_decisions through to template_slots', () => {
    const state = baseState(STATES.DEV_GREEN, {
      prior_diagnosis: 'test fixture missing',
      relevant_decisions: [{ id: 'DEC-007', decision: 'rename test file' }],
    });
    const a = nextAction(state, medium());
    expect(a.template_slots).toMatchObject({
      prior_diagnosis: 'test fixture missing',
      relevant_decisions: [{ id: 'DEC-007', decision: 'rename test file' }],
    });
  });

  it('passes patch_findings for step 6a', () => {
    const findings = [{ id: 'F1', action: 'patch' }];
    const state = baseState(STATES.PATCH_APPLY, { patch_findings: findings });
    const a = nextAction(state, medium());
    expect(a.template_slots).toMatchObject({ patch_findings: findings });
  });
});
