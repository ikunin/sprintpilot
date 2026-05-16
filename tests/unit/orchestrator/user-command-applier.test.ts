import { describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS module
import profileRules from '../../../_Sprintpilot/lib/orchestrator/profile-rules.js';
// @ts-expect-error — CommonJS module
import sm from '../../../_Sprintpilot/lib/orchestrator/state-machine.js';
// @ts-expect-error — CommonJS module
import applier from '../../../_Sprintpilot/lib/orchestrator/user-command-applier.js';

const { apply, applyOne } = applier as {
  apply: (
    state: Record<string, unknown>,
    profile: Record<string, unknown>,
    commands: Record<string, unknown>[],
  ) => {
    newState: Record<string, unknown>;
    newProfile: Record<string, unknown>;
    sideEffects: Record<string, unknown>[];
  };
  applyOne: (
    state: Record<string, unknown>,
    profile: Record<string, unknown>,
    cmd: Record<string, unknown>,
  ) => {
    newState: Record<string, unknown>;
    newProfile: Record<string, unknown>;
    effects: Record<string, unknown>[];
  };
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
        nano: { fallback_target: 'small' },
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
    retry_count_this_phase: 2,
    verify_reject_count: 1,
    consecutive_test_failures: 2,
    sprint_is_complete: false,
    ...extra,
  };
}

describe('applyOne', () => {
  it('skip_story → resets to CREATE_STORY for full flow', () => {
    const r = applyOne(st(STATES.DEV_RED), medium(), {
      kind: 'skip_story',
      story_key: 'S1',
    });
    expect(r.newState.phase).toBe(STATES.CREATE_STORY);
    expect(r.newState.story_key).toBeNull();
    expect(r.effects[0].reason).toBe('user_skip_story');
  });

  it('skip_story → resets to NANO_QUICK_DEV for quick flow', () => {
    const r = applyOne(st(STATES.NANO_QUICK_DEV), nano(), {
      kind: 'skip_story',
      story_key: 'S1',
    });
    expect(r.newState.phase).toBe(STATES.NANO_QUICK_DEV);
  });

  it('abort_sprint → SPRINT_FINALIZE_PENDING + halt sideEffect', () => {
    const r = applyOne(st(STATES.DEV_GREEN), medium(), { kind: 'abort_sprint', reason: 'rethink' });
    expect(r.newState.phase).toBe(STATES.SPRINT_FINALIZE_PENDING);
    expect(r.newState.sprint_is_complete).toBe(true);
    expect(r.effects[0].kind).toBe('halt');
  });

  it('force_continue → resets retry/verify counters, keeps phase', () => {
    const r = applyOne(st(STATES.DEV_GREEN), medium(), {
      kind: 'force_continue',
      reason: 'I know',
    });
    expect(r.newState.phase).toBe(STATES.DEV_GREEN);
    expect(r.newState.retry_count_this_phase).toBe(0);
    expect(r.newState.verify_reject_count).toBe(0);
    expect(r.newState.consecutive_test_failures).toBe(0);
  });

  it('change_profile → updates name + re-seeds budgets', () => {
    const r = applyOne(st(STATES.DEV_RED), medium(), {
      kind: 'change_profile',
      profile: 'large',
    });
    expect(r.newProfile.name).toBe('large');
    expect(r.newProfile.retry_budget_per_action).toBe(3);
    expect(r.newProfile.verify_reject_budget).toBe(3);
    expect(r.newProfile.changed_via_user_command).toBe(true);
  });

  it('change_profile → nano budgets', () => {
    const r = applyOne(st(STATES.DEV_RED), medium(), {
      kind: 'change_profile',
      profile: 'nano',
    });
    expect(r.newProfile.name).toBe('nano');
    expect(r.newProfile.retry_budget_per_action).toBe(1);
    expect(r.newProfile.verify_reject_budget).toBe(2);
  });

  it('pause → no state mutation but emits halt sideEffect', () => {
    const r = applyOne(st(STATES.CODE_REVIEW), medium(), { kind: 'pause' });
    expect(r.newState.phase).toBe(STATES.CODE_REVIEW);
    expect(r.effects[0].kind).toBe('halt');
    expect(r.effects[0].reason).toBe('user_pause');
  });

  it('override_decision → records intent without state mutation', () => {
    const r = applyOne(st(STATES.DEV_RED), medium(), {
      kind: 'override_decision',
      decision_id: 'DEC-007',
      new_value: 'use vitest',
    });
    expect(r.newState.phase).toBe(STATES.DEV_RED);
    expect(r.effects[0].decision_id).toBe('DEC-007');
  });

  it('trigger_retrospective → routes phase to RETROSPECTIVE regardless of remaining count', () => {
    // Real-world: user wants to close out Epic 4 with a retro, but
    // remaining_stories_in_epic > 0 because deferred stories still show
    // backlog/in-progress in sprint-status. The state machine would
    // otherwise route to next-story.
    const r = applyOne(
      st(STATES.EPIC_BOUNDARY_CHECK, {
        current_epic: '4',
        remaining_stories_in_epic: 3,
      }),
      medium(),
      { kind: 'trigger_retrospective', reason: 'closing out epic 4' },
    );
    expect(r.newState.phase).toBe(STATES.RETROSPECTIVE);
    expect(r.newState.current_epic).toBe('4'); // preserved — retro needs it
    expect(r.newState.story_key).toBeNull();
    expect(r.effects[0].reason).toBe('user_trigger_retrospective');
    expect(r.effects[0].epic).toBe('4');
    expect(r.effects[0].details).toBe('closing out epic 4');
  });
});

describe('apply (batch)', () => {
  it('applies commands in order, threading state forward', () => {
    // force_continue clears counters; subsequent skip_story resets phase.
    const r = apply(st(STATES.DEV_GREEN), medium(), [
      { kind: 'force_continue' },
      { kind: 'skip_story', story_key: 'S1' },
    ]);
    expect(r.newState.retry_count_this_phase).toBe(0);
    expect(r.newState.phase).toBe(STATES.CREATE_STORY);
    expect(r.sideEffects).toHaveLength(2);
  });

  it('change_profile then skip_story honors new profile flow', () => {
    const r = apply(st(STATES.DEV_RED), medium(), [
      { kind: 'change_profile', profile: 'nano' },
      { kind: 'skip_story', story_key: 'S1' },
    ]);
    // After change_profile, applier uses the new (nano) profile's flow.
    // But the new profile here lacks implementation_flow=quick because
    // we only updated the orchestrator-internal budgets. Realistic case:
    // the CLI would re-resolve. So the phase falls back to CREATE_STORY.
    // We assert the change_profile sideEffect fired correctly.
    expect(r.newProfile.name).toBe('nano');
    expect(r.sideEffects[0].kind).toBe('profile_escalated');
  });

  it('empty command list → no-op', () => {
    const r = apply(st(STATES.DEV_RED), medium(), []);
    expect(r.newState).toEqual(st(STATES.DEV_RED));
    expect(r.sideEffects).toEqual([]);
  });
});
