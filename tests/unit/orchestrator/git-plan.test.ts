import { describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import gitPlan from '../../../_Sprintpilot/lib/orchestrator/git-plan.js';
// @ts-expect-error — CommonJS module
import profileRules from '../../../_Sprintpilot/lib/orchestrator/profile-rules.js';

const { plan, branchName, sanitizeStoryKey } = gitPlan as {
  plan: (
    state: Record<string, unknown>,
    profile: Record<string, unknown>,
    action: Record<string, unknown>,
  ) => { branch: string | null; steps: { args: string[]; description: string; retry?: unknown }[] };
  branchName: (profile: Record<string, unknown>, storyKey: string, epicKey?: string) => string;
  sanitizeStoryKey: (key: string) => string | null;
};

const { flatToProfile } = profileRules as {
  flatToProfile: (resolved: unknown, name: string) => Record<string, unknown>;
};

const story = (extra: Record<string, unknown> = {}) => ({
  phase: 'story_done',
  story_key: 'S1.2',
  current_epic: 'E1',
  ac_summary: 'Login button accessible',
  ...extra,
});

describe('sanitizeStoryKey', () => {
  it('lowercases and keeps allowed chars', () => {
    expect(sanitizeStoryKey('S1.2-Foo')).toBe('s1.2-foo');
  });

  it('replaces disallowed chars with -', () => {
    expect(sanitizeStoryKey('story key!')).toBe('story-key-');
  });

  it('returns null for non-string', () => {
    expect(sanitizeStoryKey(42 as unknown as string)).toBeNull();
  });
});

describe('branchName', () => {
  it('story granularity → story/<key>', () => {
    expect(branchName(flatToProfile({}, 'medium'), 'S1.2', 'E1')).toBe('story/s1.2');
  });

  it('epic granularity → epic/<key>', () => {
    const p = flatToProfile({ git: { granularity: 'epic' } }, 'nano');
    expect(branchName(p, 'S1', 'E2')).toBe('epic/e2');
  });
});

describe('plan: commit_and_push_story', () => {
  it('with explicit files: add <files> → commit → push', () => {
    const r = plan(story(), flatToProfile({}, 'medium'), {
      type: 'git_op',
      op: 'commit_and_push_story',
      files: ['src/a.ts', 'src/b.ts'],
    });
    expect(r.branch).toBe('story/s1.2');
    expect(r.steps).toHaveLength(3);
    expect(r.steps[0].args).toEqual(['git', 'add', 'src/a.ts', 'src/b.ts']);
    expect(r.steps[1].args[0]).toBe('git');
    expect(r.steps[1].args[1]).toBe('commit');
    expect(r.steps[1].args).toContain('-m');
    expect(r.steps[2].args).toEqual(['git', 'push', '-u', 'origin', 'story/s1.2']);
    expect(r.steps[2].retry).toBeDefined();
  });

  it('without explicit files: uses git add -u (never -A or .)', () => {
    const r = plan(story(), flatToProfile({}, 'medium'), {
      type: 'git_op',
      op: 'commit_and_push_story',
    });
    expect(r.steps[0].args).toEqual(['git', 'add', '-u']);
    // Adversarial: ensure no step uses -A or .
    for (const s of r.steps) {
      expect(s.args).not.toContain('-A');
      expect(s.args).not.toContain('.');
    }
  });

  it('with has_origin=false: no push step', () => {
    const p = { ...flatToProfile({}, 'medium'), has_origin: false };
    const r = plan(story(), p, { type: 'git_op', op: 'commit_and_push_story' });
    expect(r.steps.find((s) => s.args.includes('push'))).toBeUndefined();
  });

  it('honors a custom message', () => {
    const r = plan(story(), flatToProfile({}, 'medium'), {
      type: 'git_op',
      op: 'commit_and_push_story',
      message: 'fix: oops',
    });
    expect(r.steps[1].args).toContain('fix: oops');
  });

  it('push step has 4-attempt exponential backoff retry config', () => {
    const r = plan(story(), flatToProfile({}, 'medium'), {
      type: 'git_op',
      op: 'commit_and_push_story',
    });
    const push = r.steps[r.steps.length - 1];
    expect(push.retry).toMatchObject({
      attempts: 4,
      backoff_ms: [2000, 4000, 8000, 16000],
      on: 'network',
    });
  });
});

describe('plan: merge_epic', () => {
  it('non-squash → fetch + switch + ff base + non-ff merge + push', () => {
    const r = plan(story(), flatToProfile({}, 'medium'), { type: 'git_op', op: 'merge_epic' });
    const descriptions = r.steps.map((s) => s.description);
    expect(descriptions).toContain('sync with remote');
    expect(descriptions).toContain('switch to main');
    expect(r.steps.some((s) => s.args.includes('--no-ff'))).toBe(true);
  });

  it('squash_on_merge=true → merge --squash + commit', () => {
    const p = flatToProfile({ git: { squash_on_merge: true } }, 'nano');
    const r = plan(story(), p, { type: 'git_op', op: 'merge_epic' });
    expect(r.steps.some((s) => s.args.includes('--squash'))).toBe(true);
    expect(r.steps.some((s) => s.args.includes('commit') && s.args.includes('-m'))).toBe(true);
  });
});

describe('plan: create_branch', () => {
  it('creates a story branch with switch -c <branch> <base>', () => {
    const r = plan(story(), flatToProfile({}, 'medium'), { type: 'git_op', op: 'create_branch' });
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0].args[0]).toBe('git');
    expect(r.steps[0].args[1]).toBe('switch');
    expect(r.steps[0].args[2]).toBe('-c');
  });
});

describe('plan: fetch / push', () => {
  it('fetch returns single argv', () => {
    const r = plan(story(), flatToProfile({}, 'medium'), { type: 'git_op', op: 'fetch' });
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0].args).toEqual(['git', 'fetch', 'origin']);
  });

  it('fetch is a no-op without origin', () => {
    const p = { ...flatToProfile({}, 'medium'), has_origin: false };
    const r = plan(story(), p, { type: 'git_op', op: 'fetch' });
    expect(r.steps).toHaveLength(0);
  });
});

describe('plan validation', () => {
  it('throws on non-git_op action', () => {
    expect(() => plan(story(), flatToProfile({}, 'medium'), { type: 'invoke_skill' })).toThrow();
  });

  it('throws on unknown op', () => {
    expect(() =>
      plan(story(), flatToProfile({}, 'medium'), { type: 'git_op', op: 'mystery' }),
    ).toThrow();
  });
});

describe('argv-only — security invariant', () => {
  it('no step uses a shell string (no spaces in argv[0])', () => {
    const profiles = ['nano', 'small', 'medium', 'large', 'legacy'];
    const ops = ['commit_and_push_story', 'merge_epic', 'fetch', 'create_branch', 'push'];
    for (const name of profiles) {
      for (const op of ops) {
        const r = plan(story(), flatToProfile({}, name), { type: 'git_op', op });
        for (const step of r.steps) {
          expect(step.args[0]).not.toMatch(/\s/);
          // No shell metacharacters in any arg.
          for (const arg of step.args) {
            expect(arg).not.toMatch(/[$`;&|<>]/);
          }
        }
      }
    }
  });
});
