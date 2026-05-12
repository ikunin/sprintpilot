import { describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import profileRules from '../../../_Sprintpilot/lib/orchestrator/profile-rules.js';

const { flatToProfile, escalateOnFailure, ORCHESTRATOR_DEFAULTS_BY_PROFILE } = profileRules as {
  flatToProfile: (resolved: unknown, name: string) => Record<string, unknown>;
  escalateOnFailure: (
    profile: Record<string, unknown>,
    signalOutput: unknown,
  ) => Record<string, unknown>;
  ORCHESTRATOR_DEFAULTS_BY_PROFILE: Record<string, { retry_budget_per_action: number; verify_reject_budget: number }>;
};

describe('flatToProfile', () => {
  it('produces a typed Profile from an empty resolved tree (medium defaults)', () => {
    const p = flatToProfile({}, 'medium');
    expect(p.name).toBe('medium');
    expect(p.implementation_flow).toBe('full');
    expect(p.session_story_limit).toBe(3);
    expect(p.retrospective_mode).toBe('auto');
    expect(p.coalesce_state_writes).toBe(false);
    expect(p.granularity).toBe('story');
    expect(p.worktree_enabled).toBe(true);
    expect(p.parallel_stories).toBe(false);
    expect(p.retry_budget_per_action).toBe(2);
    expect(p.verify_reject_budget).toBe(3);
  });

  it('reads nested autopilot/git/ma fields from the resolved tree', () => {
    const resolved = {
      autopilot: {
        implementation_flow: 'quick',
        session_story_limit: 5,
        retrospective_mode: 'stop',
        coalesce_state_writes: true,
        conditional_boot_work: true,
      },
      git: {
        granularity: 'epic',
        worktree: { enabled: false },
        squash_on_merge: true,
      },
      ma: {
        parallel_stories: true,
        max_parallel_stories: 4,
      },
    };
    const p = flatToProfile(resolved, 'large');
    expect(p.implementation_flow).toBe('quick');
    expect(p.session_story_limit).toBe(5);
    expect(p.retrospective_mode).toBe('stop');
    expect(p.coalesce_state_writes).toBe(true);
    expect(p.conditional_boot_work).toBe(true);
    expect(p.granularity).toBe('epic');
    expect(p.worktree_enabled).toBe(false);
    expect(p.squash_on_merge).toBe(true);
    expect(p.parallel_stories).toBe(true);
    expect(p.max_parallel_stories).toBe(4);
  });

  it('seeds nano fallback fields true for nano profile by default', () => {
    const p = flatToProfile({}, 'nano');
    expect(p.fallback_on_tests_fail).toBe(true);
    expect(p.fallback_on_quick_dev_high_severity).toBe(true);
    expect(p.fallback_target).toBe('small');
    expect(p.retry_budget_per_action).toBe(1);
    expect(p.verify_reject_budget).toBe(2);
  });

  it('reads nano fallback overrides when present', () => {
    const resolved = {
      autopilot: {
        nano: {
          fallback_on_tests_fail: false,
          fallback_on_quick_dev_high_severity: true,
          fallback_target: 'medium',
        },
      },
    };
    const p = flatToProfile(resolved, 'nano');
    expect(p.fallback_on_tests_fail).toBe(false);
    expect(p.fallback_on_quick_dev_high_severity).toBe(true);
    expect(p.fallback_target).toBe('medium');
  });

  it('falls back to medium for an unknown profile name', () => {
    const p = flatToProfile({}, 'mystery');
    expect(p.name).toBe('medium');
  });

  it('rejects invalid enum values and falls back to default', () => {
    const resolved = {
      autopilot: { implementation_flow: 'turbo', retrospective_mode: 'never' },
      git: { granularity: 'sprint' },
    };
    const p = flatToProfile(resolved, 'small');
    expect(p.implementation_flow).toBe('full');
    expect(p.retrospective_mode).toBe('auto');
    expect(p.granularity).toBe('story');
  });

  it('coerces string booleans/integers from YAML when needed', () => {
    const resolved = {
      autopilot: { coalesce_state_writes: 'true', session_story_limit: '7' },
    };
    const p = flatToProfile(resolved, 'medium');
    expect(p.coalesce_state_writes).toBe(true);
    expect(p.session_story_limit).toBe(7);
  });

  it('returns the documented retry/verify budgets per profile', () => {
    for (const name of Object.keys(ORCHESTRATOR_DEFAULTS_BY_PROFILE)) {
      const p = flatToProfile({}, name);
      expect(p.retry_budget_per_action).toBe(ORCHESTRATOR_DEFAULTS_BY_PROFILE[name].retry_budget_per_action);
      expect(p.verify_reject_budget).toBe(ORCHESTRATOR_DEFAULTS_BY_PROFILE[name].verify_reject_budget);
    }
  });
});

describe('escalateOnFailure', () => {
  const nanoProfile = () => flatToProfile({}, 'nano');

  it('returns profile unchanged when not nano', () => {
    const p = flatToProfile({}, 'medium');
    expect(escalateOnFailure(p, { tests_failed: 3 })).toBe(p);
  });

  it('returns profile unchanged when signalOutput is missing', () => {
    const p = nanoProfile();
    expect(escalateOnFailure(p, null)).toBe(p);
    expect(escalateOnFailure(p, undefined)).toBe(p);
  });

  it('escalates nano to small on tests_failed > 0', () => {
    const p = nanoProfile();
    const next = escalateOnFailure(p, { tests_failed: 1 });
    expect(next.name).toBe('small');
    expect(next.implementation_flow).toBe('full');
    expect(next.escalated_from).toBe('nano');
    expect(next.escalation_reason).toBe('tests_failed');
    expect(next.retry_budget_per_action).toBe(2);
  });

  it('escalates nano to fallback_target on severity=high', () => {
    const p = flatToProfile(
      { autopilot: { nano: { fallback_target: 'large' } } },
      'nano',
    );
    const next = escalateOnFailure(p, { severity: 'high' });
    expect(next.name).toBe('large');
    expect(next.implementation_flow).toBe('full');
    expect(next.escalation_reason).toBe('high_severity');
    expect(next.retry_budget_per_action).toBe(3);
  });

  it('does not escalate when the relevant fallback flag is disabled', () => {
    const p = flatToProfile(
      { autopilot: { nano: { fallback_on_tests_fail: false } } },
      'nano',
    );
    expect(escalateOnFailure(p, { tests_failed: 5 })).toBe(p);
  });

  it('does not escalate on tests_failed === 0', () => {
    const p = nanoProfile();
    expect(escalateOnFailure(p, { tests_failed: 0 })).toBe(p);
  });

  it('disables further escalation on the returned profile', () => {
    const p = nanoProfile();
    const next = escalateOnFailure(p, { tests_failed: 1 });
    expect(next.fallback_on_tests_fail).toBe(false);
    expect(next.fallback_on_quick_dev_high_severity).toBe(false);
    // Second call with the escalated profile (which is no longer nano) is a no-op.
    expect(escalateOnFailure(next, { tests_failed: 5 })).toBe(next);
  });
});
