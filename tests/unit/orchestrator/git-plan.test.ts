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

  it('epic granularity → <branch_prefix>epic-<key> (e.g. story/epic-e2)', () => {
    // Format matches the legacy workflow (workflow.legacy.md.bak:685,716)
    // and is what the nano e2e test asserts on (origin/story/epic-*).
    const p = flatToProfile({ git: { granularity: 'epic' } }, 'nano');
    expect(branchName(p, 'S1', 'E2')).toBe('story/epic-e2');
  });

  it('epic granularity honors a custom branch_prefix', () => {
    const p = flatToProfile(
      { git: { granularity: 'epic', branch_prefix: 'feature/' } },
      'nano',
    );
    expect(branchName(p, 'S1', 'E3')).toBe('feature/epic-e3');
  });
});

describe('plan: commit_and_push_story', () => {
  it('with explicit files: phase 1 = add <files> → commit → push story branch', () => {
    const r = plan(story(), flatToProfile({}, 'medium'), {
      type: 'git_op',
      op: 'commit_and_push_story',
      files: ['src/a.ts', 'src/b.ts'],
    });
    expect(r.branch).toBe('story/s1.2');
    expect(r.steps[0].args).toEqual(['git', 'add', 'src/a.ts', 'src/b.ts']);
    expect(r.steps[1].args[0]).toBe('git');
    expect(r.steps[1].args[1]).toBe('commit');
    expect(r.steps[1].args).toContain('-m');
    expect(r.steps[2].args).toEqual(['git', 'push', '-u', 'origin', 'story/s1.2']);
    expect(r.steps[2].retry).toBeDefined();
  });

  it('phase 2 syncs _bmad-output/ to base branch after pushing story branch', () => {
    const r = plan(story(), flatToProfile({}, 'medium'), {
      type: 'git_op',
      op: 'commit_and_push_story',
    });
    // Phase 1 ends with push to origin <story-branch> at step[2].
    // Phase 2 must follow: switch base → checkout _bmad-output from story
    // branch → add → commit (--allow-empty) → push base → switch back.
    expect(r.steps[3].args).toEqual(['git', 'switch', 'main']);
    expect(r.steps[4].args).toEqual([
      'git',
      'checkout',
      'story/s1.2',
      '--',
      '_bmad-output',
    ]);
    expect(r.steps[5].args).toEqual(['git', 'add', '_bmad-output']);
    expect(r.steps[6].args.slice(0, 4)).toEqual(['git', 'commit', '--allow-empty', '-m']);
    expect(r.steps[7].args).toEqual(['git', 'push', 'origin', 'main']);
    expect(r.steps[7].retry).toBeDefined();
    expect(r.steps[8].args).toEqual(['git', 'switch', 'story/s1.2']);
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

  it('with has_origin=false: no push steps (story OR base)', () => {
    const p = { ...flatToProfile({}, 'medium'), has_origin: false };
    const r = plan(story(), p, { type: 'git_op', op: 'commit_and_push_story' });
    const pushSteps = r.steps.filter(
      (s) => s.args[0] === 'git' && s.args[1] === 'push',
    );
    expect(pushSteps).toHaveLength(0);
    // The base-branch sync (switch/checkout/add/commit) still happens —
    // useful for local-only workflows that want main updated.
    expect(r.steps.some((s) => s.args.join(' ') === 'git switch main')).toBe(true);
  });

  it('honors a custom message on the story-branch commit', () => {
    const r = plan(story(), flatToProfile({}, 'medium'), {
      type: 'git_op',
      op: 'commit_and_push_story',
      message: 'fix: oops',
    });
    expect(r.steps[1].args).toContain('fix: oops');
  });

  it('story-branch push has 4-attempt exponential backoff retry config', () => {
    const r = plan(story(), flatToProfile({}, 'medium'), {
      type: 'git_op',
      op: 'commit_and_push_story',
    });
    // The story-branch push is step[2] (first git push in the sequence).
    const push = r.steps.find(
      (s) => s.args.join(' ') === 'git push -u origin story/s1.2',
    );
    expect(push).toBeDefined();
    expect(push?.retry).toMatchObject({
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

  it('reuse_user_branch + state.user_branch: skips -c, just switches', () => {
    const state = story({ user_branch: 'feature/auth-rewrite' });
    const r = plan(
      state,
      { ...flatToProfile({}, 'medium'), reuse_user_branch: true },
      { type: 'git_op', op: 'create_branch' },
    );
    expect(r.branch).toBe('feature/auth-rewrite');
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0].args).toEqual(['git', 'switch', 'feature/auth-rewrite']);
    expect(r.steps[0].args).not.toContain('-c');
  });
});

describe('branch reuse: single user branch carries every story', () => {
  it('commit_and_push targets the user branch (not story/<key>)', () => {
    const state = story({ user_branch: 'feature/auth-rewrite' });
    const r = plan(state, flatToProfile({}, 'medium'), {
      type: 'git_op',
      op: 'commit_and_push_story',
    });
    expect(r.branch).toBe('feature/auth-rewrite');
    // Push step targets the user branch.
    const push = r.steps.find((s) => s.args.includes('push'));
    expect(push?.args).toContain('feature/auth-rewrite');
  });

  it('reuse overrides epic granularity', () => {
    const state = story({ user_branch: 'feature/multi-epic' });
    const p = {
      ...flatToProfile({ git: { granularity: 'epic' } }, 'nano'),
      reuse_user_branch: true,
    };
    const r = plan(state, p, { type: 'git_op', op: 'commit_and_push_story' });
    expect(r.branch).toBe('feature/multi-epic');
    // Branch should NOT match the epic/<key> pattern.
    expect(r.branch).not.toMatch(/^epic\//);
  });

  it('no story branch created when reusing — security invariant holds (no shell chars)', () => {
    const state = story({ user_branch: 'feature/x-y_z.0' });
    const r = plan(state, flatToProfile({}, 'medium'), {
      type: 'git_op',
      op: 'commit_and_push_story',
    });
    for (const s of r.steps) {
      for (const a of s.args) {
        expect(a).not.toMatch(/[$`;&|<>]/);
      }
    }
  });

  it('without user_branch in state, falls back to story/<key>', () => {
    const r = plan(story(), flatToProfile({}, 'medium'), {
      type: 'git_op',
      op: 'commit_and_push_story',
    });
    expect(r.branch).toBe('story/s1.2');
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
