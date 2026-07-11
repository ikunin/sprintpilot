import { describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import adapt from '../../../_Sprintpilot/lib/orchestrator/adapt.js';
// @ts-expect-error — CommonJS module
import profileRules from '../../../_Sprintpilot/lib/orchestrator/profile-rules.js';
// @ts-expect-error — CommonJS module
import sm from '../../../_Sprintpilot/lib/orchestrator/state-machine.js';

type Result = {
  newState: Record<string, unknown>;
  newProfile: Record<string, unknown>;
  nextAction: Record<string, unknown>;
  sideEffects: Record<string, unknown>[];
  verdict: string;
};

const { interpretSignal } = adapt as {
  interpretSignal: (
    state: Record<string, unknown>,
    signal: Record<string, unknown>,
    profile: Record<string, unknown>,
    verifyResult?: { ok: boolean; issues?: string[] },
  ) => Result;
};
const { STATES } = sm as { STATES: Record<string, string> };
const { flatToProfile, escalateOnFailure } = profileRules as {
  flatToProfile: (resolved: unknown, name: string) => Record<string, unknown>;
  escalateOnFailure: (
    profile: Record<string, unknown>,
    output: Record<string, unknown>,
  ) => Record<string, unknown>;
};

// A medium profile with the fast lane active for the current story — mirrors
// what deriveEffectiveProfile produces in the CLI when the gate says `fast`.
const fastLaneMedium = () => ({
  ...flatToProfile({}, 'medium'),
  implementation_flow: 'quick',
  fast_lane_active: true,
});

function st(phase: string, extra: Record<string, unknown> = {}) {
  return {
    phase,
    story_key: '4-2-copy-tweak',
    story_file_path: '/r/_bmad-output/implementation-artifacts/4-2-copy-tweak.md',
    current_epic: '4',
    remaining_stories_in_epic: 1,
    sprint_is_complete: false,
    retry_count_this_phase: 0,
    verify_reject_count: 0,
    consecutive_test_failures: 0,
    ...extra,
  };
}

describe('escalateOnFailure — fast_lane origin', () => {
  it('bounces a fast-laned story to full on failing tests, keeping the profile name', () => {
    const p = fastLaneMedium();
    const out = escalateOnFailure(p, { tests_failed: 2 });
    expect(out).not.toBe(p);
    expect(out.name).toBe('medium'); // name preserved (already a full profile)
    expect(out.implementation_flow).toBe('full');
    expect(out.fast_lane_active).toBe(false);
    expect(out.escalated_from).toBe('fast_lane');
    expect(out.escalation_reason).toBe('tests_failed');
  });

  it('bounces on a high-severity finding', () => {
    const out = escalateOnFailure(fastLaneMedium(), { severity: 'high' });
    expect(out.implementation_flow).toBe('full');
    expect(out.escalation_reason).toBe('high_severity');
  });

  it('does not escalate a clean fast-laned success', () => {
    const p = fastLaneMedium();
    expect(escalateOnFailure(p, { tests_failed: 0, severity: 'low' })).toBe(p);
  });

  it('leaves a plain full profile (no fast_lane_active) untouched', () => {
    const p = flatToProfile({}, 'medium');
    expect(escalateOnFailure(p, { tests_failed: 3 })).toBe(p);
  });
});

describe('fast-lane routing — create-story runs first', () => {
  // The gate needs a real story file to enforce deny-globs / max_ac / tags, and
  // that file only exists after bmad-create-story. So a fast-laned story goes
  // PREPARE_STORY_BRANCH → CREATE_STORY → NANO_QUICK_DEV — NOT straight to
  // quick-dev. nano (whole-profile quick) still skips create-story.
  it('a fast-laned story branches PREPARE_STORY_BRANCH → CREATE_STORY (not NANO_QUICK_DEV)', () => {
    const r = interpretSignal(
      st(STATES.PREPARE_STORY_BRANCH),
      { status: 'success' },
      fastLaneMedium(),
    );
    expect(r.newState.phase).toBe(STATES.CREATE_STORY);
    expect(r.nextAction.skill).toBe('bmad-create-story');
  });

  it('a fast-laned story routes CREATE_STORY → NANO_QUICK_DEV (skips the 7-step cycle)', () => {
    const r = interpretSignal(
      st(STATES.CREATE_STORY),
      { status: 'success', output: { story_key: '4-2-copy-tweak' } },
      fastLaneMedium(),
    );
    expect(r.newState.phase).toBe(STATES.NANO_QUICK_DEV);
    expect(r.nextAction.skill).toBe('bmad-quick-dev');
  });

  it('nano (whole-profile quick, not fast_lane_active) still skips create-story', () => {
    const nano = { ...flatToProfile({}, 'medium'), implementation_flow: 'quick' };
    const r = interpretSignal(st(STATES.PREPARE_STORY_BRANCH), { status: 'success' }, nano);
    expect(r.newState.phase).toBe(STATES.NANO_QUICK_DEV);
  });

  it('a non-fast-laned full story routes CREATE_STORY → CHECK_READINESS as before', () => {
    const r = interpretSignal(
      st(STATES.CREATE_STORY),
      { status: 'success' },
      flatToProfile({}, 'medium'),
    );
    expect(r.newState.phase).toBe(STATES.CHECK_READINESS);
  });

  it('a bmad-quick-dev HINT cannot hijack a non-fast-laned CREATE_STORY into quick-dev', () => {
    // Safety: NANO_QUICK_DEV is not a structurally-valid CREATE_STORY successor
    // unless fast_lane_active, so the LLM hint tiebreaker can't push a deny-
    // glob'd / forced-full / plain-full story into unreviewed one-shot.
    const r = interpretSignal(
      st(STATES.CREATE_STORY),
      { status: 'success', next_skill_hint: 'bmad-quick-dev' },
      flatToProfile({}, 'medium'),
    );
    expect(r.newState.phase).toBe(STATES.CHECK_READINESS);
  });
});

describe('adapt routing — fast-lane re-run', () => {
  it('a success-but-flagged quick-dev routes to CODE_REVIEW (the review the fast lane skipped) and records forced-full', () => {
    // The SUCCESS path: quick-dev marked the story done (verify requires it)
    // but reported failing tests / high severity. Routing to CODE_REVIEW — not
    // CREATE_STORY — because composeRuntimeState skips the done-rejection at
    // CODE_REVIEW (a done story survives re-resolution and gets reviewed),
    // whereas CREATE_STORY would let the done story be skipped entirely.
    const r = interpretSignal(
      st(STATES.NANO_QUICK_DEV),
      { status: 'success', output: { tests_failed: 1, story_key: '4-2-copy-tweak' } },
      fastLaneMedium(),
    );
    expect(r.newState.phase).toBe(STATES.CODE_REVIEW);
    expect(r.newProfile.implementation_flow).toBe('full');
    expect(r.newState.fast_lane_forced_full).toContain('4-2-copy-tweak');
    const esc = r.sideEffects.find((e) => e.kind === 'profile_escalated');
    expect(esc).toMatchObject({ from: 'fast_lane', story_key: '4-2-copy-tweak' });
    // next action runs the adversarial review over the committed code
    expect(r.nextAction.skill).toBe('bmad-code-review');
    // the escalation context is surfaced as a review-pass note
    expect(r.newState.escalation_note).toMatch(/FAST-LANE ESCALATION/);
    expect(r.newState.escalation_note).toMatch(/CODE REVIEW/);
    const slots = r.nextAction.template_slots as Record<string, unknown>;
    expect(slots.profile_specific_notes).toBe(r.newState.escalation_note);
  });

  it('a clean fast-laned quick-dev advances to STORY_DONE (no escalation)', () => {
    const r = interpretSignal(
      st(STATES.NANO_QUICK_DEV),
      {
        status: 'success',
        output: { tests_failed: 0, commit_sha: 'abc', story_key: '4-2-copy-tweak' },
      },
      fastLaneMedium(),
    );
    expect(r.newState.phase).toBe(STATES.STORY_DONE);
    expect(r.newState.fast_lane_forced_full ?? []).not.toContain('4-2-copy-tweak');
  });

  it('does NOT mark the sprint complete after a clean fast-laned story (multi-story sprint)', () => {
    const r = interpretSignal(
      st(STATES.NANO_QUICK_DEV),
      {
        status: 'success',
        output: { tests_failed: 0, commit_sha: 'abc', story_key: '4-2-copy-tweak' },
      },
      fastLaneMedium(),
    );
    // The nano one-shot "sprint complete" shortcut must not fire for the
    // per-story fast lane — the medium sprint has more stories to run.
    expect(r.newState.sprint_is_complete).toBe(false);
  });

  it('unions repeated escalations without dropping earlier entries', () => {
    const r = interpretSignal(
      st(STATES.NANO_QUICK_DEV, { fast_lane_forced_full: ['1-1-prior'] }),
      { status: 'success', output: { severity: 'high', story_key: '4-2-copy-tweak' } },
      fastLaneMedium(),
    );
    expect(r.newState.fast_lane_forced_full).toEqual(
      expect.arrayContaining(['1-1-prior', '4-2-copy-tweak']),
    );
  });
});

describe('adapt routing — fast-lane hard failure', () => {
  it('a status:failure quick-dev bounces to the full cycle instead of retrying', () => {
    const r = interpretSignal(
      st(STATES.NANO_QUICK_DEV, { retry_count_this_phase: 0 }),
      { status: 'failure', recoverable: true, reason: 'impl broke', story_key: '4-2-copy-tweak' },
      fastLaneMedium(),
    );
    expect(r.verdict).toBe('advanced');
    expect(r.newState.phase).toBe(STATES.CREATE_STORY);
    expect(r.newProfile.implementation_flow).toBe('full');
    expect(r.newState.fast_lane_forced_full).toContain('4-2-copy-tweak');
    expect(r.nextAction.skill).toBe('bmad-create-story');
    expect(r.newState.escalation_note).toMatch(/FAST-LANE ESCALATION/);
    expect(r.newState.escalation_note).toMatch(/known-deficient/i);
    const esc = r.sideEffects.find((e) => e.kind === 'profile_escalated');
    expect(esc).toMatchObject({ from: 'fast_lane', reason: 'quick_dev_failure' });
  });

  it('a non-recoverable failure also bounces to full (the full cycle is the recovery)', () => {
    const r = interpretSignal(
      st(STATES.NANO_QUICK_DEV),
      { status: 'failure', recoverable: false, story_key: '4-2-copy-tweak' },
      fastLaneMedium(),
    );
    expect(r.newState.phase).toBe(STATES.CREATE_STORY);
    expect(r.newState.fast_lane_forced_full).toContain('4-2-copy-tweak');
  });

  it('a plain full-profile dev failure is unaffected (normal retry path)', () => {
    const r = interpretSignal(
      st(STATES.DEV_GREEN, { retry_count_this_phase: 0 }),
      { status: 'failure', recoverable: true },
      flatToProfile({}, 'medium'),
    );
    // No fast lane → normal retry, not a bounce.
    expect(r.verdict).toBe('retry');
    expect(r.newState.phase).toBe(STATES.DEV_GREEN);
  });

  it('the escalation note does not bleed into the NEXT story', () => {
    // A stale escalation_note on state must be cleared when a fresh story
    // starts (advanceState new-story reset), so story N+1 gets normal notes.
    const r = interpretSignal(
      st(STATES.RETROSPECTIVE, {
        escalation_note: 'stale note from a prior escalated story',
        remaining_stories_in_epic: 1,
        sprint_is_complete: false,
      }),
      { status: 'success' },
      flatToProfile({}, 'medium'),
    );
    // RETROSPECTIVE → next story start (PREPARE_STORY_BRANCH under a
    // branch-prep full profile) — the note clears at that boundary.
    expect(r.newState.phase).toBe(STATES.PREPARE_STORY_BRANCH);
    expect(r.newState.escalation_note).toBeNull();
  });
});

describe('nano_quick_dev phase timeout is budgeted under full profiles', () => {
  for (const [name, expected] of [
    ['small', 20],
    ['medium', 30],
    ['large', 60],
  ] as const) {
    it(`${name} budgets nano_quick_dev at ${expected}m (fast-lane hang protection)`, () => {
      const p = flatToProfile({}, name);
      expect((p.phase_timeout_minutes as Record<string, number>).nano_quick_dev).toBe(expected);
    });
  }
});
