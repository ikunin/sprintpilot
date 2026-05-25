import { describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import adapt from '../../../_Sprintpilot/lib/orchestrator/adapt.js';
// @ts-expect-error — CommonJS module
import profileRules from '../../../_Sprintpilot/lib/orchestrator/profile-rules.js';
// @ts-expect-error — CommonJS module
import sm from '../../../_Sprintpilot/lib/orchestrator/state-machine.js';

type Action = Record<string, unknown>;
type SideEffect = Record<string, unknown>;
type Result = {
  newState: Record<string, unknown>;
  newProfile: Record<string, unknown>;
  nextAction: Action;
  sideEffects: SideEffect[];
  verdict: 'advanced' | 'retry' | 'prompted' | 'halt';
};

const { interpretSignal, CONSECUTIVE_TEST_FAILURE_THRESHOLD, verifyIssuesSignature } = adapt as {
  interpretSignal: (
    state: Record<string, unknown>,
    signal: Record<string, unknown>,
    profile: Record<string, unknown>,
    verifyResult?: { ok: boolean; issues?: string[] },
  ) => Result;
  CONSECUTIVE_TEST_FAILURE_THRESHOLD: number;
  verifyIssuesSignature: (issues: unknown) => string | null;
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
    expect(r.newState.patch_findings).toEqual([
      { id: 'F1', action: 'patch', rationale: 'fix lint' },
    ]);
  });

  it('CODE_REVIEW with blocking finding → user_prompt', () => {
    const r = interpretSignal(
      st(STATES.CODE_REVIEW),
      {
        status: 'success',
        output: { findings: [{ id: 'B1', action: 'block', rationale: 'arch decision' }] },
      },
      medium(),
    );
    expect(r.verdict).toBe('prompted');
    expect((r.nextAction as Record<string, unknown>).type).toBe('user_prompt');
    expect((r.nextAction as Record<string, unknown>).reason).toBe('code_review_blocking_findings');
  });

  it('propagates story_key + derives current_epic from signal.output', () => {
    // Regression: under nano, the orchestrator emits invoke_skill:
    // bmad-quick-dev with story_key=null (LLM picks the story). The
    // success signal carries story_key in output. Without this
    // propagation, the next git_op sees state.story_key=null and
    // computes branch=`story/unknown`, breaking epic granularity.
    const r = interpretSignal(
      st(STATES.NANO_QUICK_DEV),
      {
        status: 'success',
        output: {
          story_key: '1-1-game-engine',
          commit_sha: 'abc',
          branch: 'story/epic-1',
          git_steps_completed: true,
        },
      },
      medium(),
    );
    expect(r.newState.story_key).toBe('1-1-game-engine');
    expect(r.newState.current_epic).toBe('1');
  });

  it('honors explicit epic_key over derived', () => {
    const r = interpretSignal(
      st(STATES.NANO_QUICK_DEV),
      {
        status: 'success',
        output: {
          story_key: '1-1-game-engine',
          epic_key: 'epic-alpha',
          git_steps_completed: true,
        },
      },
      medium(),
    );
    expect(r.newState.current_epic).toBe('epic-alpha');
  });

  it('NANO_QUICK_DEV success under quick flow marks sprint complete', () => {
    // BMad's bmad-quick-dev is one-shot (step-oneshot.md): a single
    // intent → single commit, no iteration. Without auto-completing the
    // sprint after the first successful NANO_QUICK_DEV, the orchestrator
    // loops EPIC_BOUNDARY_CHECK → NANO_QUICK_DEV forever because
    // remaining_stories_in_epic stays 0 and sprint_is_complete stays
    // false. Auto-set sprint_is_complete so the next transition halts at
    // SPRINT_FINALIZE_PENDING.
    const nanoProfile = { ...medium(), implementation_flow: 'quick' };
    const r = interpretSignal(
      st(STATES.NANO_QUICK_DEV),
      { status: 'success', output: { story_key: '1-1-foo', git_steps_completed: true } },
      nanoProfile,
    );
    expect(r.newState.sprint_is_complete).toBe(true);
  });

  it('NANO_QUICK_DEV success honors explicit sprint_is_complete: false override', () => {
    // The LLM can opt out of auto-completion if they have additional
    // stories to run (e.g. multi-story sprint-status was pre-seeded).
    const nanoProfile = { ...medium(), implementation_flow: 'quick' };
    const r = interpretSignal(
      st(STATES.NANO_QUICK_DEV),
      {
        status: 'success',
        output: { story_key: '1-1-foo', sprint_is_complete: false, git_steps_completed: true },
      },
      nanoProfile,
    );
    expect(r.newState.sprint_is_complete).toBe(false);
  });
});

describe('success — verify.js trust boundary', () => {
  it('rejects success when verify.js fails; retries within budget', () => {
    const r = interpretSignal(st(STATES.DEV_RED), { status: 'success' }, medium(), {
      ok: false,
      issues: ['no failing tests'],
    });
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

  // v2.3.0 — verify-loop detection: when identical issues recur, the
  // budget-exhausted halt prompt is enriched with a loop-hint.
  describe('verify-loop detection', () => {
    it('tracks consecutive_identical_rejections across identical rejections', () => {
      // First rejection — count starts at 1.
      const r1 = interpretSignal(st(STATES.DEV_GREEN), { status: 'success' }, medium(), {
        ok: false,
        issues: ['branch required', 'git_steps_completed must be true'],
      });
      expect(r1.newState.consecutive_identical_rejections).toBe(1);
      expect(typeof r1.newState.last_verify_issues_signature).toBe('string');

      // Second rejection with same issues — count increments.
      const r2 = interpretSignal(r1.newState, { status: 'success' }, medium(), {
        ok: false,
        issues: ['branch required', 'git_steps_completed must be true'],
      });
      expect(r2.newState.consecutive_identical_rejections).toBe(2);
    });

    it('resets consecutive_identical_rejections when issues differ', () => {
      const r1 = interpretSignal(st(STATES.DEV_GREEN), { status: 'success' }, medium(), {
        ok: false,
        issues: ['branch required'],
      });
      expect(r1.newState.consecutive_identical_rejections).toBe(1);

      const r2 = interpretSignal(r1.newState, { status: 'success' }, medium(), {
        ok: false,
        issues: ['commit_sha required'], // different issue
      });
      expect(r2.newState.consecutive_identical_rejections).toBe(1);
    });

    it('treats reordered issues as identical (signature is order-independent)', () => {
      const r1 = interpretSignal(st(STATES.DEV_GREEN), { status: 'success' }, medium(), {
        ok: false,
        issues: ['a', 'b', 'c'],
      });
      const r2 = interpretSignal(r1.newState, { status: 'success' }, medium(), {
        ok: false,
        issues: ['c', 'a', 'b'], // same set, different order
      });
      expect(r2.newState.consecutive_identical_rejections).toBe(2);
    });

    it('enriches halt prompt with loop hint when identicalCount >= 2 at budget exhaustion', () => {
      // Prime state at budget-1 with one prior identical rejection.
      const state = st(STATES.DEV_GREEN, {
        verify_reject_count: 2, // medium budget = 3, this is the last allowed retry
        last_verify_issues_signature: verifyIssuesSignature([
          'branch required',
          'git_steps_completed must be true',
        ]),
        consecutive_identical_rejections: 2,
      });
      const r = interpretSignal(state, { status: 'success' }, medium(), {
        ok: false,
        issues: ['branch required', 'git_steps_completed must be true'],
      });
      expect(r.verdict).toBe('prompted');
      const prompt = String((r.nextAction as Record<string, unknown>).prompt);
      expect(prompt).toMatch(/SAME 2 issues 3 times in a row/);
      expect(prompt).toMatch(/this is a loop, not random noise/);
      expect(prompt).toMatch(/don't just retry the same signal/);
      expect((r.nextAction as Record<string, unknown>).consecutive_identical).toBe(3);
    });

    it('omits loop hint when issues vary across rejections', () => {
      const state = st(STATES.DEV_GREEN, {
        verify_reject_count: 2,
        last_verify_issues_signature: verifyIssuesSignature(['some other issue']),
        consecutive_identical_rejections: 1,
      });
      const r = interpretSignal(state, { status: 'success' }, medium(), {
        ok: false,
        issues: ['a different issue this time'],
      });
      expect(r.verdict).toBe('prompted');
      const prompt = String((r.nextAction as Record<string, unknown>).prompt);
      expect(prompt).not.toMatch(/this is a loop/);
      expect((r.nextAction as Record<string, unknown>).consecutive_identical).toBe(1);
    });

    it('resets loop trackers on the halt path so the next phase starts fresh', () => {
      const state = st(STATES.DEV_GREEN, {
        verify_reject_count: 2,
        last_verify_issues_signature: verifyIssuesSignature(['x']),
        consecutive_identical_rejections: 2,
      });
      const r = interpretSignal(state, { status: 'success' }, medium(), {
        ok: false,
        issues: ['x'],
      });
      expect(r.newState.last_verify_issues_signature).toBeNull();
      expect(r.newState.consecutive_identical_rejections).toBe(0);
      expect(r.newState.verify_reject_count).toBe(0);
    });

    it('the log_verify_rejection side-effect carries consecutive_identical', () => {
      const r1 = interpretSignal(st(STATES.DEV_GREEN), { status: 'success' }, medium(), {
        ok: false,
        issues: ['x'],
      });
      const r2 = interpretSignal(r1.newState, { status: 'success' }, medium(), {
        ok: false,
        issues: ['x'],
      });
      const eff = r2.sideEffects.find((e) => e.kind === 'log_verify_rejection');
      expect(eff).toBeDefined();
      expect(eff?.consecutive_identical).toBe(2);
    });

    it('resets loop trackers when verify succeeds', () => {
      const state = st(STATES.DEV_GREEN, {
        last_verify_issues_signature: verifyIssuesSignature(['x']),
        consecutive_identical_rejections: 2,
      });
      const r = interpretSignal(state, { status: 'success' }, medium(), { ok: true });
      // The state advances to the next phase; advanceState clears trackers.
      expect(r.newState.last_verify_issues_signature).toBeNull();
      expect(r.newState.consecutive_identical_rejections).toBe(0);
    });
  });

  describe('verifyIssuesSignature', () => {
    it('returns null for empty/missing input', () => {
      expect(verifyIssuesSignature([])).toBeNull();
      expect(verifyIssuesSignature(null)).toBeNull();
      expect(verifyIssuesSignature(undefined)).toBeNull();
      expect(verifyIssuesSignature('not an array')).toBeNull();
    });

    it('produces stable, order-independent signatures', () => {
      expect(verifyIssuesSignature(['a', 'b', 'c'])).toBe(verifyIssuesSignature(['c', 'b', 'a']));
      expect(verifyIssuesSignature(['a'])).toBe(verifyIssuesSignature(['a']));
    });

    it('differs for different issue sets', () => {
      expect(verifyIssuesSignature(['a'])).not.toBe(verifyIssuesSignature(['b']));
      expect(verifyIssuesSignature(['a', 'b'])).not.toBe(verifyIssuesSignature(['a']));
    });
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

  it('escalates to user_prompt after budget exhausted (post-diagnostic)', () => {
    // v2.4.1 — test phases insert one diagnostic verbose-run between
    // the last retry and user_prompt. Setting `diagnostic_completed:
    // true` simulates the post-diagnostic state so we still exercise
    // the bare budget-exhausted escalation path.
    const state = st(STATES.DEV_GREEN, {
      retry_count_this_phase: 2,
      diagnostic_completed: true,
    });
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

  it('missing_dependency → abstract run_script install_dependencies (CLI inlines the command)', () => {
    const r = interpretSignal(
      st(STATES.DEV_GREEN),
      { status: 'blocked', blocker_kind: 'missing_dependency', user_input_needed: false },
      medium(),
    );
    expect(r.verdict).toBe('retry');
    const action = r.nextAction as Record<string, unknown>;
    expect(action.type).toBe('run_script');
    expect(action.op).toBe('install_dependencies');
    // Language-specific argv is inlined by decorateRunScript at the CLI
    // edge — adapt.js stays pure (no FS detection).
    expect(action.command).toBeUndefined();
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
      {
        status: 'verify_override',
        evidence: { decision_log_ref: 'DEC-007', explanation: 'renamed' },
      },
      medium(),
      { ok: true },
    );
    expect(r.verdict).toBe('advanced');
    expect(r.newState.phase).toBe(STATES.DEV_GREEN);
    expect(r.sideEffects).toContainEqual(
      expect.objectContaining({ kind: 'log_verify_override', accepted: true }),
    );
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
    expect(() => interpretSignal(st(STATES.DEV_RED), { status: 'mystery' }, medium())).toThrow();
  });
});

describe('propose_alternative + accept_alternative round-trip (Bug B regression)', () => {
  it('medium-impact propose_alternative stores pending_alternative on state', () => {
    const r = interpretSignal(
      st(STATES.DEV_GREEN),
      {
        status: 'propose_alternative',
        reason: 'switch test framework',
        alternative: {
          type: 'invoke_skill',
          skill: 'bmad-dev-story',
          args: { test_framework: 'vitest' },
        },
      },
      medium(),
    );
    expect(r.verdict).toBe('prompted');
    expect(r.newState.pending_alternative).toEqual(
      expect.objectContaining({
        action: expect.objectContaining({ type: 'invoke_skill', skill: 'bmad-dev-story' }),
        impact: 'medium',
        reason: 'switch test framework',
        prompted_at: expect.any(String),
      }),
    );
  });

  it('next user_input { accept_alternative } returns the stored alternative and clears state', () => {
    const stateWithPending = st(STATES.DEV_GREEN, {
      pending_alternative: {
        action: { type: 'run_script', command: ['echo', 'hi'] },
        impact: 'high',
        reason: 'test',
        prompted_at: '2026-05-15T12:00:00Z',
      },
    });
    const r = interpretSignal(
      stateWithPending,
      { status: 'user_input', commands: [{ kind: 'accept_alternative' }] },
      medium(),
    );
    expect(r.verdict).toBe('advanced');
    expect((r.nextAction as Record<string, unknown>).type).toBe('run_script');
    expect((r.nextAction as Record<string, unknown>)._dispatched_via).toBe(
      'user_accept_alternative',
    );
    expect(r.newState.pending_alternative).toBeUndefined();
  });

  it('accept_alternative syncs story_key/current_epic/story_file_path/ac_summary from dispatched action onto state', () => {
    // Regression: dispatch_action used to return the dispatched action
    // verbatim but never propagated its story metadata, leaving
    // autopilot-state.yaml with current_story: null even though
    // accept_alternative just dispatched work on a specific story.
    const dispatchedAction = {
      type: 'invoke_skill',
      skill: 'bmad-dev-story',
      template_slots: {
        story_key: '4-8-realm-wide-matcher',
        current_epic: '4',
        story_file_path: '/repo/_bmad-output/stories/4-8.md',
        ac_summary: 'Lock the realm session',
      },
    };
    const stateWithPending = st(STATES.CREATE_STORY, {
      story_key: null,
      current_epic: null,
      story_file_path: null,
      ac_summary: null,
      pending_alternative: {
        action: dispatchedAction,
        impact: 'high',
        reason: 'jump to dev_red',
        prompted_at: '2026-05-15T12:00:00Z',
      },
    });
    const r = interpretSignal(
      stateWithPending,
      { status: 'user_input', commands: [{ kind: 'accept_alternative' }] },
      medium(),
    );
    expect(r.verdict).toBe('advanced');
    expect(r.newState.story_key).toBe('4-8-realm-wide-matcher');
    expect(r.newState.current_epic).toBe('4');
    expect(r.newState.story_file_path).toBe('/repo/_bmad-output/stories/4-8.md');
    expect(r.newState.ac_summary).toBe('Lock the realm session');
  });

  it('accept_alternative ADVANCES state.phase when the dispatched action carries phase (v2.2.6 fix)', () => {
    // Real-world stuck session: story 4-8 was implemented end-to-end on
    // its branch in a prior session (impl + tests + code review + sprint-
    // status flip), but the orchestrator's state was still at dev_red.
    // User proposed an alternative with `phase: story_done` to skip the
    // unnecessary cycle. Pre-2.2.6 the dispatch ran as a one-shot (noop)
    // and state.phase reverted to dev_red on next emission. Now: phase
    // advances if the alternative carries a valid STATES value.
    const dispatchedAction = {
      type: 'noop',
      phase: STATES.STORY_DONE,
      reason: 'already implemented + committed + pushed on the branch',
    };
    const stateWithPending = st(STATES.DEV_RED, {
      story_key: '4-8-realm',
      pending_alternative: {
        action: dispatchedAction,
        impact: 'high',
        reason: 'work already done on branch',
        prompted_at: '2026-05-15T20:00:00Z',
      },
    });
    const r = interpretSignal(
      stateWithPending,
      { status: 'user_input', commands: [{ kind: 'accept_alternative' }] },
      medium(),
    );
    expect(r.verdict).toBe('advanced');
    expect(r.newState.phase).toBe(STATES.STORY_DONE);
    // Counters reset so the new phase isn't throttled by stale budgets.
    expect(r.newState.retry_count_this_phase).toBe(0);
    expect(r.newState.verify_reject_count).toBe(0);
  });

  it('accept_alternative IGNORES invalid phase values (defense against malformed alternatives)', () => {
    const dispatchedAction = {
      type: 'invoke_skill',
      phase: 'mystery_phase_typo',
      skill: 'bmad-dev-story',
    };
    const stateWithPending = st(STATES.DEV_RED, {
      pending_alternative: {
        action: dispatchedAction,
        impact: 'high',
        reason: 'bad input',
        prompted_at: '2026-05-15T20:00:00Z',
      },
    });
    const r = interpretSignal(
      stateWithPending,
      { status: 'user_input', commands: [{ kind: 'accept_alternative' }] },
      medium(),
    );
    expect(r.newState.phase).toBe(STATES.DEV_RED); // unchanged
  });

  it('accept_alternative without phase keeps original state.phase (back-compat)', () => {
    const dispatchedAction = {
      type: 'invoke_skill',
      skill: 'bmad-dev-story',
      // no phase field
    };
    const stateWithPending = st(STATES.CODE_REVIEW, {
      pending_alternative: {
        action: dispatchedAction,
        impact: 'medium',
        reason: 'swap framework',
        prompted_at: '2026-05-15T20:00:00Z',
      },
    });
    const r = interpretSignal(
      stateWithPending,
      { status: 'user_input', commands: [{ kind: 'accept_alternative' }] },
      medium(),
    );
    expect(r.newState.phase).toBe(STATES.CODE_REVIEW);
  });

  it('accept_alternative does NOT overwrite existing story_key on state (caller priority)', () => {
    // If state already has a story_key (mid-cycle dispatch), the dispatch
    // shouldn't blow it away with the alternative's value.
    const dispatchedAction = {
      type: 'invoke_skill',
      skill: 'bmad-dev-story',
      template_slots: { story_key: 'alt-story' },
    };
    const stateWithPending = st(STATES.DEV_GREEN, {
      story_key: 'original-story',
      pending_alternative: {
        action: dispatchedAction,
        impact: 'high',
        reason: 'oops',
        prompted_at: '2026-05-15T12:00:00Z',
      },
    });
    const r = interpretSignal(
      stateWithPending,
      { status: 'user_input', commands: [{ kind: 'accept_alternative' }] },
      medium(),
    );
    expect(r.newState.story_key).toBe('original-story');
  });

  it('user_input { force_continue } clears pending_alternative and returns planned action', () => {
    const stateWithPending = st(STATES.DEV_GREEN, {
      pending_alternative: {
        action: { type: 'run_script', command: ['rm', '-rf', '/'] },
        impact: 'high',
        reason: 'bad idea',
        prompted_at: '2026-05-15T12:00:00Z',
      },
    });
    const r = interpretSignal(
      stateWithPending,
      { status: 'user_input', commands: [{ kind: 'force_continue', reason: 'no thanks' }] },
      medium(),
    );
    expect(r.verdict).toBe('advanced');
    expect(r.newState.pending_alternative).toBeUndefined();
    // Planned action for DEV_GREEN should be the state machine's normal next, not the dangerous alternative.
    expect((r.nextAction as Record<string, unknown>).type).not.toBe('run_script');
  });

  it('accept_alternative without a pending alternative emits a validation_error side-effect', () => {
    const r = interpretSignal(
      st(STATES.DEV_GREEN),
      { status: 'user_input', commands: [{ kind: 'accept_alternative' }] },
      medium(),
    );
    expect(r.sideEffects).toContainEqual(
      expect.objectContaining({
        kind: 'validation_error',
        reason: expect.stringContaining('no pending alternative'),
      }),
    );
    // No dispatch happened — falls through to planned action.
    expect((r.nextAction as Record<string, unknown>)._dispatched_via).toBeUndefined();
  });
});

describe('user_input pause halts the loop (Bug C regression)', () => {
  it('pause sets state.halt_requested and returns a halt action on the same turn', () => {
    const r = interpretSignal(
      st(STATES.DEV_GREEN),
      { status: 'user_input', commands: [{ kind: 'pause', reason: 'switching focus' }] },
      medium(),
    );
    expect(r.verdict).toBe('halt');
    expect((r.nextAction as Record<string, unknown>).type).toBe('halt');
    expect((r.nextAction as Record<string, unknown>).reason).toBe('switching focus');
    expect(r.newState.halt_requested).toEqual(
      expect.objectContaining({
        reason: 'switching focus',
        requested_at: expect.any(String),
      }),
    );
  });

  it('pause without an explicit reason still halts (reason becomes the default)', () => {
    const r = interpretSignal(
      st(STATES.CODE_REVIEW),
      { status: 'user_input', commands: [{ kind: 'pause' }] },
      medium(),
    );
    expect(r.verdict).toBe('halt');
    expect((r.nextAction as Record<string, unknown>).type).toBe('halt');
    expect((r.nextAction as Record<string, unknown>).reason).toBe('user_pause');
  });
});

describe('advanceState — bug #2: current_epic preserved through STORY_DONE → EPIC_BOUNDARY_CHECK', () => {
  it('clears story_key / story_file_path / ac_summary but KEEPS current_epic', () => {
    // Regression: v2.2.0 cleared current_epic at STORY_DONE → EPIC_BOUNDARY_
    // CHECK, which made verifyRetrospective look for retrospectives/unknown.md
    // because state.current_epic was null by the time RETROSPECTIVE ran.
    // current_epic must survive through EPIC_BOUNDARY_CHECK + RETROSPECTIVE
    // for both the state-machine end-of-epic check and the retro verifier.
    const stateAtStoryDone = st(STATES.STORY_DONE, {
      story_key: '4-8-realm',
      current_epic: '4',
      story_file_path: '/repo/_bmad-output/stories/4-8.md',
      ac_summary: 'lock the realm session',
      story_queue: ['4-8-realm', '4-9-next-in-epic-4'],
    });
    const r = interpretSignal(
      stateAtStoryDone,
      {
        status: 'success',
        output: {
          commit_sha: 'abc123',
          branch: 'story/4-8-realm',
          git_steps_completed: true,
          story_key: '4-8-realm',
        },
      },
      medium(),
    );
    expect(r.newState.phase).toBe(STATES.EPIC_BOUNDARY_CHECK);
    // Cleared:
    expect(r.newState.story_key).toBeNull();
    expect(r.newState.story_file_path).toBeNull();
    expect(r.newState.ac_summary).toBeNull();
    // Preserved (this is the regression fix):
    expect(r.newState.current_epic).toBe('4');
    // Queue popped:
    expect(r.newState.story_queue).toEqual(['4-9-next-in-epic-4']);
  });
});

describe('advanceState — session_stories_completed counter', () => {
  it('increments on STORY_DONE → EPIC_BOUNDARY_CHECK', () => {
    const r = interpretSignal(
      st(STATES.STORY_DONE, { session_stories_completed: 2 }),
      {
        status: 'success',
        output: { commit_sha: 'abc', branch: 'story/S1', git_steps_completed: true },
      },
      medium(),
    );
    expect(r.newState.phase).toBe(STATES.EPIC_BOUNDARY_CHECK);
    expect(r.newState.session_stories_completed).toBe(3);
  });

  it('treats unset counter as 0 (increments from 0 → 1)', () => {
    const r = interpretSignal(
      st(STATES.STORY_DONE),
      {
        status: 'success',
        output: { commit_sha: 'abc', branch: 'story/S1', git_steps_completed: true },
      },
      medium(),
    );
    expect(r.newState.session_stories_completed).toBe(1);
  });

  it('does NOT increment on transitions that are not STORY_DONE → EPIC_BOUNDARY_CHECK', () => {
    const r = interpretSignal(
      st(STATES.DEV_RED, { session_stories_completed: 2 }),
      { status: 'success' },
      medium(),
    );
    expect(r.newState.session_stories_completed).toBe(2);
  });
});

describe('diagnostic mode insertion (v2.4.1)', () => {
  it('inserts a diagnostic re-run between budget-exhausted and user_prompt for test phases', () => {
    const r = interpretSignal(
      st(STATES.DEV_GREEN, { retry_count_this_phase: 2 }),
      { status: 'failure', reason: 'x', diagnosis: 'y', recoverable: true },
      medium(),
    );
    expect(r.verdict).toBe('retry');
    expect(r.newState.diagnostic_pending).toBe(true);
    expect(r.newState.diagnostic_completed).toBeFalsy();
    // Retry counter NOT incremented — diagnostic is an observation pass.
    expect(r.newState.retry_count_this_phase).toBe(2);
  });

  it('skips diagnostic when state.diagnostic_completed is already true', () => {
    const r = interpretSignal(
      st(STATES.DEV_GREEN, { retry_count_this_phase: 2, diagnostic_completed: true }),
      { status: 'failure', reason: 'x', diagnosis: 'y', recoverable: true },
      medium(),
    );
    expect(r.verdict).toBe('prompted');
    expect((r.nextAction as Record<string, unknown>).reason).toBe('retry_budget_exhausted');
  });

  it('skips diagnostic for non-test phases', () => {
    const r = interpretSignal(
      st(STATES.CODE_REVIEW, { retry_count_this_phase: 2 }),
      { status: 'failure', reason: 'x', diagnosis: 'y', recoverable: true },
      medium(),
    );
    expect(r.verdict).toBe('prompted');
    expect(r.newState.diagnostic_pending).toBeFalsy();
  });

  it('skips diagnostic on non-recoverable failure (not yet at budget)', () => {
    // retry_count_this_phase=0, so the budget is not exhausted. The
    // !recoverable branch hits user_prompt with reason='failure_not_recoverable'
    // and no diagnostic insertion happens.
    const r = interpretSignal(
      st(STATES.DEV_GREEN, { retry_count_this_phase: 0 }),
      { status: 'failure', reason: 'fatal', diagnosis: 'x', recoverable: false },
      medium(),
    );
    expect(r.verdict).toBe('prompted');
    expect((r.nextAction as Record<string, unknown>).reason).toBe('failure_not_recoverable');
    expect(r.newState.diagnostic_pending).toBeFalsy();
  });

  it('captures diagnostic_trace and escalates with rich prior_diagnosis on diagnostic response', () => {
    const trace = 'FAIL tests/foo.test.ts > expected 1 to be 2\n  at line 42';
    const r = interpretSignal(
      st(STATES.DEV_GREEN, {
        retry_count_this_phase: 2,
        diagnostic_pending: true,
      }),
      {
        status: 'failure',
        reason: 'still failing',
        diagnosis: null,
        recoverable: true,
        output: { diagnostic_trace: trace },
      },
      medium(),
    );
    expect(r.verdict).toBe('prompted');
    expect((r.nextAction as Record<string, unknown>).reason).toBe(
      'retry_budget_exhausted_with_diagnostic',
    );
    expect((r.nextAction as Record<string, unknown>).diagnosis).toBe(trace);
    expect(r.newState.diagnostic_trace).toBe(trace);
    expect(r.newState.diagnostic_completed).toBe(true);
    expect(r.newState.diagnostic_pending).toBe(false);
    // Side effect logged.
    expect(r.sideEffects.find((e) => e.kind === 'log_diagnostic_captured')).toBeDefined();
  });

  it('clears diagnostic state on phase advance', () => {
    const r = interpretSignal(
      st(STATES.DEV_GREEN, {
        diagnostic_pending: true,
        diagnostic_completed: true,
        diagnostic_trace: 'old trace',
      }),
      { status: 'success' },
      medium(),
    );
    expect(r.newState.phase).toBe(STATES.CODE_REVIEW);
    expect(r.newState.diagnostic_pending).toBe(false);
    expect(r.newState.diagnostic_completed).toBe(false);
    expect(r.newState.diagnostic_trace).toBeNull();
  });
});

describe('record_flaky_tests side effect (v2.4.0)', () => {
  it('emits a record_flaky_tests side-effect when signal.output.flaky_tests is present', () => {
    const r = interpretSignal(
      st(STATES.DEV_GREEN),
      {
        status: 'success',
        output: {
          flaky_tests: ['tests/foo.test.ts', 'tests/bar.test.ts'],
        },
      },
      medium(),
    );
    const eff = r.sideEffects.find((e) => e.kind === 'record_flaky_tests');
    expect(eff).toBeDefined();
    expect(eff!.tests).toEqual(['tests/foo.test.ts', 'tests/bar.test.ts']);
    expect(eff!.story_key).toBe('S1');
    expect(eff!.phase).toBe(STATES.DEV_GREEN);
  });

  it('does not emit when flaky_tests is empty / missing', () => {
    const r = interpretSignal(
      st(STATES.DEV_GREEN),
      { status: 'success', output: {} },
      medium(),
    );
    expect(r.sideEffects.find((e) => e.kind === 'record_flaky_tests')).toBeUndefined();
  });

  it('drops non-string entries', () => {
    const r = interpretSignal(
      st(STATES.DEV_GREEN),
      {
        status: 'success',
        output: {
          flaky_tests: ['real-id', null, 42, ''],
        },
      },
      medium(),
    );
    const eff = r.sideEffects.find((e) => e.kind === 'record_flaky_tests');
    expect(eff).toBeDefined();
    expect(eff!.tests).toEqual(['real-id']);
  });
});

describe('advanceState — phase_started_at stamping (v2.4.0)', () => {
  const T = '2026-06-01T12:00:00.000Z';

  it('stamps phase_started_at on phase advance', () => {
    const r = interpretSignal(
      st(STATES.DEV_RED, { phase_started_at: '2026-06-01T11:00:00.000Z' }),
      { status: 'success', _now: T },
      medium(),
    );
    expect(r.newState.phase).toBe(STATES.DEV_GREEN);
    expect(r.newState.phase_started_at).toBe(T);
  });

  it('preserves phase_started_at when the phase does not change (retry path)', () => {
    const prior = '2026-06-01T11:50:00.000Z';
    const r = interpretSignal(
      st(STATES.DEV_GREEN, {
        phase_started_at: prior,
      }),
      {
        // failure with recoverable=true (default) keeps the phase, doesn't
        // advance. The nextAction path in handleFailure re-emits the
        // same-phase action.
        status: 'failure',
        reason: 'tests failed',
        recoverable: true,
        _now: T,
      },
      medium(),
    );
    // Retry path — phase unchanged, phase_started_at unchanged.
    expect(r.verdict).toBe('retry');
    expect(r.newState.phase).toBe(STATES.DEV_GREEN);
    expect(r.newState.phase_started_at).toBe(prior);
  });

  it('backfills phase_started_at when missing on phase advance', () => {
    const r = interpretSignal(
      st(STATES.CHECK_READINESS), // no phase_started_at
      { status: 'success', _now: T },
      medium(),
    );
    expect(r.newState.phase).toBe(STATES.DEV_RED);
    expect(r.newState.phase_started_at).toBe(T);
  });

  it('uses signal._now for deterministic stamping in tests', () => {
    const r = interpretSignal(
      st(STATES.CREATE_STORY),
      { status: 'success', _now: T },
      medium(),
    );
    expect(r.newState.phase_started_at).toBe(T);
  });
});
