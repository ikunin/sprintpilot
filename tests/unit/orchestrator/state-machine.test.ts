import { describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS module
import profileRules from '../../../_Sprintpilot/lib/orchestrator/profile-rules.js';
// @ts-expect-error — CommonJS module
import sm from '../../../_Sprintpilot/lib/orchestrator/state-machine.js';

type Profile = Record<string, unknown>;
type State = Record<string, unknown>;
type Action = Record<string, unknown>;

const {
  STATES,
  nextAction,
  nextStateAfterSuccess,
  nextStoryStart,
  HINT_TO_PHASE,
  checkPhaseTimeout,
  elapsedMinutesSince,
} = sm as {
  STATES: Record<string, string>;
  nextAction: (state: State, profile: Profile, now?: string | number) => Action;
  nextStateAfterSuccess: (
    state: State,
    profile: Profile,
    signal: Record<string, unknown>,
  ) => string | null;
  nextStoryStart: (profile: Profile) => string;
  HINT_TO_PHASE: Record<string, string>;
  checkPhaseTimeout: (
    state: State,
    profile: Profile,
    now?: string | number,
  ) => { budget_minutes: number; elapsed_minutes: number } | null;
  elapsedMinutesSince: (startedAt: string | null, now?: string | number) => number | null;
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

  it('PREPARE_STORY_BRANCH → git_op create_branch', () => {
    const a = nextAction(baseState(STATES.PREPARE_STORY_BRANCH), p);
    expect(a.type).toBe('git_op');
    expect(a.op).toBe('create_branch');
    expect(a.story_key).toBe('S1.2');
    expect(a.epic_key).toBe('E1');
  });

  it('PREPARE_STORY_BRANCH → user_prompt when story_key + current_epic are both null (safety net)', () => {
    // composeRuntimeState normally resolves story_key from sprint-status
    // before we get here. If it couldn't (e.g. pre-planning + the user
    // pointed cmdNext at PREPARE_STORY_BRANCH directly), emit a
    // user_prompt instead of a `branch: story/unknown` git_op.
    const a = nextAction(
      baseState(STATES.PREPARE_STORY_BRANCH, { story_key: null, current_epic: null }),
      p,
    );
    expect(a.type).toBe('user_prompt');
    expect(a.reason).toBe('prepare_story_branch_no_story_key');
  });

  it('PREPARE_STORY_BRANCH with granularity=epic + current_epic set → emits git_op even if story_key null', () => {
    const epicProfile = { ...medium(), granularity: 'epic' } as Profile;
    const a = nextAction(
      baseState(STATES.PREPARE_STORY_BRANCH, { story_key: null, current_epic: 'E2' }),
      epicProfile,
    );
    expect(a.type).toBe('git_op');
    expect(a.op).toBe('create_branch');
    expect(a.epic_key).toBe('E2');
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

  it('nextStoryStart routes through PREPARE_STORY_BRANCH (default: granularity=story, !reuse_user_branch)', () => {
    expect(nextStoryStart(nano())).toBe(STATES.PREPARE_STORY_BRANCH);
    expect(nextStoryStart(medium())).toBe(STATES.PREPARE_STORY_BRANCH);
  });

  it('nextStoryStart skips PREPARE_STORY_BRANCH when reuse_user_branch=true', () => {
    const fullReuse = { ...medium(), reuse_user_branch: true } as Profile;
    const nanoReuse = { ...nano(), reuse_user_branch: true } as Profile;
    expect(nextStoryStart(fullReuse)).toBe(STATES.CREATE_STORY);
    expect(nextStoryStart(nanoReuse)).toBe(STATES.NANO_QUICK_DEV);
  });

  it('nextStoryStart still routes through PREPARE_STORY_BRANCH under granularity=epic', () => {
    const epicProfile = { ...medium(), granularity: 'epic' } as Profile;
    expect(nextStoryStart(epicProfile)).toBe(STATES.PREPARE_STORY_BRANCH);
  });
});

describe('nextAction — sprint completion short-circuit', () => {
  it('emits halt with handoff when sprint_is_complete and not already finalize-pending', () => {
    const a = nextAction(baseState(STATES.CREATE_STORY, { sprint_is_complete: true }), medium());
    expect(a.type).toBe('halt');
    expect(a.handoff).toBe('sprint_finalize_pending');
  });
});

describe('nextAction — session_story_limit halt', () => {
  it('halts at EPIC_BOUNDARY_CHECK when counter >= limit', () => {
    const a = nextAction(
      baseState(STATES.EPIC_BOUNDARY_CHECK, { session_stories_completed: 3 }),
      medium(),
    );
    expect(a.type).toBe('halt');
    expect(a.reason).toBe('session_story_limit_reached');
    expect(a.session_stories_completed).toBe(3);
    expect(a.session_story_limit).toBe(3);
  });

  it('does not halt when counter < limit', () => {
    const a = nextAction(
      baseState(STATES.EPIC_BOUNDARY_CHECK, { session_stories_completed: 2 }),
      medium(),
    );
    expect(a.type).not.toBe('halt');
  });

  it('respects session_story_limit=0 as unlimited (never halts)', () => {
    const unlimited = { ...medium(), session_story_limit: 0 } as Profile;
    const a = nextAction(
      baseState(STATES.EPIC_BOUNDARY_CHECK, { session_stories_completed: 999 }),
      unlimited,
    );
    expect(a.type).not.toBe('halt');
  });

  it('fires at story-start phases (PREPARE_STORY_BRANCH, CREATE_STORY, NANO_QUICK_DEV, RETROSPECTIVE)', () => {
    for (const phase of [
      STATES.PREPARE_STORY_BRANCH,
      STATES.CREATE_STORY,
      STATES.NANO_QUICK_DEV,
      STATES.RETROSPECTIVE,
    ]) {
      const a = nextAction(
        baseState(phase, { session_stories_completed: 3, story_key: null }),
        medium(),
      );
      expect(a.type).toBe('halt');
      expect(a.reason).toBe('session_story_limit_reached');
    }
  });

  it('does NOT fire mid-story (e.g. DEV_RED, CODE_REVIEW) so an in-flight story finishes', () => {
    for (const phase of [STATES.DEV_RED, STATES.CODE_REVIEW, STATES.PATCH_APPLY]) {
      const a = nextAction(baseState(phase, { session_stories_completed: 5 }), medium());
      expect(a.type).not.toBe('halt');
    }
  });

  it('sprint_complete short-circuit takes precedence over session limit halt', () => {
    const a = nextAction(
      baseState(STATES.EPIC_BOUNDARY_CHECK, {
        session_stories_completed: 3,
        sprint_is_complete: true,
      }),
      medium(),
    );
    expect(a.type).toBe('halt');
    expect(a.handoff).toBe('sprint_finalize_pending');
  });

  it('respects a custom limit (e.g. 5 from nano.yaml override)', () => {
    const five = { ...medium(), session_story_limit: 5 } as Profile;
    const a4 = nextAction(
      baseState(STATES.EPIC_BOUNDARY_CHECK, { session_stories_completed: 4 }),
      five,
    );
    expect(a4.type).not.toBe('halt');
    const a5 = nextAction(
      baseState(STATES.EPIC_BOUNDARY_CHECK, { session_stories_completed: 5 }),
      five,
    );
    expect(a5.type).toBe('halt');
    expect(a5.session_story_limit).toBe(5);
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

  it('STORY_DONE → EPIC_BOUNDARY_CHECK (default stacked strategy)', () => {
    expect(nextStateAfterSuccess(baseState(STATES.STORY_DONE), p, { status: 'success' })).toBe(
      STATES.EPIC_BOUNDARY_CHECK,
    );
  });

  it('STORY_DONE → STORY_LAND when merge_strategy=land_as_you_go', () => {
    const landProfile = { ...p, merge_strategy: 'land_as_you_go' } as Profile;
    expect(
      nextStateAfterSuccess(baseState(STATES.STORY_DONE), landProfile, { status: 'success' }),
    ).toBe(STATES.STORY_LAND);
  });

  it('STORY_LAND → EPIC_BOUNDARY_CHECK', () => {
    expect(nextStateAfterSuccess(baseState(STATES.STORY_LAND), p, { status: 'success' })).toBe(
      STATES.EPIC_BOUNDARY_CHECK,
    );
  });

  it('STORY_LAND emits run_script action with land_when forwarded', () => {
    const landProfile = {
      ...p,
      merge_strategy: 'land_as_you_go',
      land_when: 'no_wait',
      land_wait_minutes: 10,
    } as Profile;
    const action = nextAction(baseState(STATES.STORY_LAND), landProfile);
    expect(action.type).toBe('run_script');
    expect(action.op).toBe('land_story');
    expect(action.land_when).toBe('no_wait');
    expect(action.land_wait_minutes).toBe(10);
    expect(action.helper).toBe('lib/orchestrator/land.js');
  });

  it('EPIC_BOUNDARY_CHECK end-of-epic → RETROSPECTIVE (mode auto)', () => {
    expect(
      nextStateAfterSuccess(baseState(STATES.EPIC_BOUNDARY_CHECK), p, { status: 'success' }),
    ).toBe(STATES.RETROSPECTIVE);
  });

  it('EPIC_BOUNDARY_CHECK end-of-epic, mode=skip, sprint not complete → next story start (full → PREPARE_STORY_BRANCH)', () => {
    const sp = { ...medium(), retrospective_mode: 'skip' } as Profile;
    expect(
      nextStateAfterSuccess(baseState(STATES.EPIC_BOUNDARY_CHECK), sp, { status: 'success' }),
    ).toBe(STATES.PREPARE_STORY_BRANCH);
  });

  it('EPIC_BOUNDARY_CHECK end-of-epic, mode=skip, reuse_user_branch=true → CREATE_STORY directly', () => {
    const sp = { ...medium(), retrospective_mode: 'skip', reuse_user_branch: true } as Profile;
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

  it('EPIC_BOUNDARY_CHECK with more stories in epic → PREPARE_STORY_BRANCH (default settings)', () => {
    expect(
      nextStateAfterSuccess(
        baseState(STATES.EPIC_BOUNDARY_CHECK, { remaining_stories_in_epic: 2 }),
        p,
        { status: 'success' },
      ),
    ).toBe(STATES.PREPARE_STORY_BRANCH);
  });

  it('RETROSPECTIVE → next story start (PREPARE_STORY_BRANCH) when sprint not complete', () => {
    expect(nextStateAfterSuccess(baseState(STATES.RETROSPECTIVE), p, { status: 'success' })).toBe(
      STATES.PREPARE_STORY_BRANCH,
    );
  });

  it('PREPARE_STORY_BRANCH → CREATE_STORY (full flow)', () => {
    expect(
      nextStateAfterSuccess(baseState(STATES.PREPARE_STORY_BRANCH), p, { status: 'success' }),
    ).toBe(STATES.CREATE_STORY);
  });

  it('EPIC_BOUNDARY_CHECK end-of-epic + granularity=epic + stacked + autopush → MERGE_EPIC', () => {
    const epicProfile = { ...medium(), granularity: 'epic' } as Profile;
    expect(
      nextStateAfterSuccess(
        baseState(STATES.EPIC_BOUNDARY_CHECK, { remaining_stories_in_epic: 0 }),
        epicProfile,
        { status: 'success' },
      ),
    ).toBe(STATES.MERGE_EPIC);
  });

  it('EPIC_BOUNDARY_CHECK end-of-epic + granularity=epic + reuse_user_branch=true → skip MERGE_EPIC', () => {
    const epicProfile = { ...medium(), granularity: 'epic', reuse_user_branch: true } as Profile;
    expect(
      nextStateAfterSuccess(
        baseState(STATES.EPIC_BOUNDARY_CHECK, { remaining_stories_in_epic: 0 }),
        epicProfile,
        { status: 'success' },
      ),
    ).toBe(STATES.RETROSPECTIVE);
  });

  it('EPIC_BOUNDARY_CHECK end-of-epic + granularity=epic + push_auto=false → skip MERGE_EPIC', () => {
    const epicProfile = { ...medium(), granularity: 'epic', push_auto: false } as Profile;
    expect(
      nextStateAfterSuccess(
        baseState(STATES.EPIC_BOUNDARY_CHECK, { remaining_stories_in_epic: 0 }),
        epicProfile,
        { status: 'success' },
      ),
    ).toBe(STATES.RETROSPECTIVE);
  });

  it('EPIC_BOUNDARY_CHECK end-of-epic + granularity=story → no MERGE_EPIC (per-story flow)', () => {
    expect(
      nextStateAfterSuccess(
        baseState(STATES.EPIC_BOUNDARY_CHECK, { remaining_stories_in_epic: 0 }),
        p,
        { status: 'success' },
      ),
    ).toBe(STATES.RETROSPECTIVE);
  });

  it('MERGE_EPIC → RETROSPECTIVE (mode auto, sprint not done)', () => {
    const epicProfile = { ...medium(), granularity: 'epic' } as Profile;
    expect(
      nextStateAfterSuccess(baseState(STATES.MERGE_EPIC), epicProfile, { status: 'success' }),
    ).toBe(STATES.RETROSPECTIVE);
  });

  it('MERGE_EPIC → SPRINT_FINALIZE_PENDING when retro=skip + sprint done', () => {
    const epicProfile = {
      ...medium(),
      granularity: 'epic',
      retrospective_mode: 'skip',
    } as Profile;
    expect(
      nextStateAfterSuccess(
        baseState(STATES.MERGE_EPIC, { sprint_is_complete: true }),
        epicProfile,
        { status: 'success' },
      ),
    ).toBe(STATES.SPRINT_FINALIZE_PENDING);
  });

  it('nextAction(MERGE_EPIC) emits git_op merge_epic', () => {
    const epicProfile = { ...medium(), granularity: 'epic' } as Profile;
    const a = nextAction(baseState(STATES.MERGE_EPIC), epicProfile);
    expect(a.type).toBe('git_op');
    expect(a.op).toBe('merge_epic');
    expect(a.epic_key).toBe('E1');
  });

  it('PREPARE_STORY_BRANCH → NANO_QUICK_DEV (quick flow)', () => {
    expect(
      nextStateAfterSuccess(baseState(STATES.PREPARE_STORY_BRANCH), np, { status: 'success' }),
    ).toBe(STATES.NANO_QUICK_DEV);
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

describe('per-phase wall-clock budget — v2.4.0', () => {
  // Fixed "now" that's far enough from any test's phase_started_at to drive
  // deterministic minute math. All timestamps are explicit so the assertions
  // don't drift with the real clock.
  const T_NOW = '2026-06-01T12:00:00.000Z';
  const at = (minutesAgo: number) =>
    new Date(Date.parse(T_NOW) - minutesAgo * 60_000).toISOString();

  describe('elapsedMinutesSince', () => {
    it('computes positive elapsed minutes', () => {
      expect(elapsedMinutesSince(at(5), T_NOW)).toBeCloseTo(5, 5);
      expect(elapsedMinutesSince(at(60), T_NOW)).toBeCloseTo(60, 5);
    });
    it('returns null for missing / invalid timestamps', () => {
      expect(elapsedMinutesSince(null as unknown as string, T_NOW)).toBeNull();
      expect(elapsedMinutesSince('', T_NOW)).toBeNull();
      expect(elapsedMinutesSince('not-a-date', T_NOW)).toBeNull();
    });
  });

  describe('checkPhaseTimeout', () => {
    it('returns null when phase_started_at is missing', () => {
      const state = baseState(STATES.DEV_GREEN);
      expect(checkPhaseTimeout(state, medium(), T_NOW)).toBeNull();
    });
    it('returns null when profile has no phase_timeout_minutes map', () => {
      const state = baseState(STATES.DEV_GREEN, { phase_started_at: at(60) });
      const legacy = flatToProfile({}, 'legacy'); // legacy disables timeouts
      expect(checkPhaseTimeout(state, legacy, T_NOW)).toBeNull();
    });
    it('returns null when the phase is not in the budget map', () => {
      const state = baseState(STATES.STORY_DONE, { phase_started_at: at(120) });
      // story_done is intentionally unbudgeted (routing state).
      expect(checkPhaseTimeout(state, medium(), T_NOW)).toBeNull();
    });
    it('returns null when elapsed is within budget', () => {
      // medium dev_green budget = 30min.
      const state = baseState(STATES.DEV_GREEN, { phase_started_at: at(25) });
      expect(checkPhaseTimeout(state, medium(), T_NOW)).toBeNull();
    });
    it('returns budget + elapsed when exceeded', () => {
      const state = baseState(STATES.DEV_GREEN, { phase_started_at: at(45) });
      const r = checkPhaseTimeout(state, medium(), T_NOW);
      expect(r).not.toBeNull();
      expect(r!.budget_minutes).toBe(30);
      expect(r!.elapsed_minutes).toBeCloseTo(45, 1);
    });
    it('user override null disables a single phase', () => {
      const profile = flatToProfile(
        { autopilot: { phase_timeout_minutes: { dev_green: null } } },
        'medium',
      );
      const state = baseState(STATES.DEV_GREEN, { phase_started_at: at(120) });
      expect(checkPhaseTimeout(state, profile, T_NOW)).toBeNull();
    });
    it('user override null at root disables all phases', () => {
      const profile = flatToProfile({ autopilot: { phase_timeout_minutes: null } }, 'medium');
      const state = baseState(STATES.DEV_GREEN, { phase_started_at: at(120) });
      expect(checkPhaseTimeout(state, profile, T_NOW)).toBeNull();
    });
    it('user override raises a single phase budget', () => {
      const profile = flatToProfile(
        { autopilot: { phase_timeout_minutes: { dev_green: 60 } } },
        'medium',
      );
      const state = baseState(STATES.DEV_GREEN, { phase_started_at: at(45) });
      expect(checkPhaseTimeout(state, profile, T_NOW)).toBeNull(); // within 60
    });
  });

  describe('nextAction phase_timeout_exceeded halt', () => {
    it('emits user_prompt with structured fields when exceeded', () => {
      const state = baseState(STATES.DEV_GREEN, { phase_started_at: at(45) });
      const a = nextAction(state, medium(), T_NOW);
      expect(a.type).toBe('user_prompt');
      expect(a.reason).toBe('phase_timeout_exceeded');
      expect(a.budget_minutes).toBe(30);
      expect(a.elapsed_minutes).toBeCloseTo(45, 1);
      expect(a.phase).toBe(STATES.DEV_GREEN);
      expect(a.phase_started_at).toBe(at(45));
    });
    it('falls through to the normal action when within budget', () => {
      const state = baseState(STATES.DEV_GREEN, { phase_started_at: at(10) });
      const a = nextAction(state, medium(), T_NOW);
      expect(a.type).toBe('invoke_skill');
      expect(a.skill).toBe('bmad-dev-story');
    });
    it('does not fire on routing states even when stamped long ago', () => {
      // story_done is unbudgeted (routing state); it should emit its git_op.
      const state = baseState(STATES.STORY_DONE, { phase_started_at: at(180) });
      const a = nextAction(state, medium(), T_NOW);
      expect(a.type).toBe('git_op');
      expect(a.op).toBe('commit_and_push_story');
    });
    it('legacy profile does not budget any phase', () => {
      const state = baseState(STATES.DEV_GREEN, { phase_started_at: at(600) });
      const a = nextAction(state, flatToProfile({}, 'legacy'), T_NOW);
      expect(a.reason).not.toBe('phase_timeout_exceeded');
    });
    it('nano profile budgets nano_quick_dev', () => {
      const state = baseState(STATES.NANO_QUICK_DEV, { phase_started_at: at(20) });
      // nano nano_quick_dev budget = 15min, elapsed 20min → halt.
      const a = nextAction(state, nano(), T_NOW);
      expect(a.reason).toBe('phase_timeout_exceeded');
      expect(a.budget_minutes).toBe(15);
    });
  });
});
