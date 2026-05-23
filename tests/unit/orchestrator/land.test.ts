import { describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import land from '../../../_Sprintpilot/lib/orchestrator/land.js';
// @ts-expect-error — CommonJS module
import profileRules from '../../../_Sprintpilot/lib/orchestrator/profile-rules.js';

const { planLand, planRebaseRecovery, isRebaseConflict } = land as {
  planLand: (
    state: Record<string, unknown>,
    profile: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => {
    steps: { args: string[]; description: string; retry?: unknown }[];
    branch: string;
    base: string;
    land_when: string;
  };
  planRebaseRecovery: (
    state: Record<string, unknown>,
    profile: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => {
    steps: { args: string[]; description: string }[];
    on_conflict: { type: string; reason: string; prompt: string };
  };
  isRebaseConflict: (stderr: string) => boolean;
};

const { flatToProfile } = profileRules as {
  flatToProfile: (resolved: unknown, name: string) => Record<string, unknown>;
};

function story(extra: Record<string, unknown> = {}) {
  return { story_key: 'S1.2', current_epic: 'E1', ...extra };
}

const baseOpts = (extra: Record<string, unknown> = {}) => ({
  scriptsDir: '/repo/_Sprintpilot/scripts',
  snapshotPath: '/tmp/stack-snapshot.json',
  projectRoot: '/repo',
  branch: 'story/s1.2',
  platform: 'github',
  ...extra,
});

describe('planLand: land_when modes', () => {
  it('no_wait emits create-pr + snapshot + land — no polling step', () => {
    const profile = flatToProfile({ git: { land_when: 'no_wait' } }, 'medium');
    const r = planLand(story(), profile, baseOpts());
    const descriptions = r.steps.map((s) => s.description);
    expect(descriptions[0]).toContain('open PR');
    expect(descriptions[1]).toContain('snapshot stack');
    expect(descriptions.find((d) => d.includes('CI'))).toBeUndefined();
    expect(descriptions.find((d) => d.includes('land PR'))).toBeDefined();
    expect(r.steps).toHaveLength(3); // create-pr + snapshot + land
    expect(r.land_when).toBe('no_wait');
  });

  it('ci_pass adds a CI-check polling step', () => {
    const profile = flatToProfile({ git: { land_when: 'ci_pass' } }, 'medium');
    const r = planLand(story(), profile, baseOpts());
    expect(r.steps).toHaveLength(4); // create-pr + snapshot + wait + land
    const wait = r.steps[2];
    expect(wait.args).toContain('--mode');
    expect(wait.args).toContain('checks');
    expect(wait.args).toContain('--wait-minutes');
    expect(wait.args).not.toContain('--require-approved-review');
  });

  it('ci_and_review adds approval requirement', () => {
    const profile = flatToProfile({ git: { land_when: 'ci_and_review' } }, 'medium');
    const r = planLand(story(), profile, baseOpts());
    const wait = r.steps[2];
    expect(wait.args).toContain('--require-approved-review');
  });

  it('squash_on_merge forwards --squash to land-this-pr', () => {
    const profile = flatToProfile({ git: { land_when: 'no_wait', squash_on_merge: true } }, 'nano');
    const r = planLand(story(), profile, baseOpts());
    const landStep = r.steps[r.steps.length - 1];
    expect(landStep.args).toContain('--squash');
  });

  it('honors profile.base_branch override (e.g., develop)', () => {
    const profile = flatToProfile(
      { git: { land_when: 'no_wait', base_branch: 'develop' } },
      'medium',
    );
    const r = planLand(story(), profile, baseOpts());
    expect(r.base).toBe('develop');
    const landStep = r.steps[r.steps.length - 1];
    expect(landStep.args).toContain('develop');
  });

  it('land_wait_minutes is forwarded as --wait-minutes', () => {
    const profile = flatToProfile(
      { git: { land_when: 'ci_pass', land_wait_minutes: 90 } },
      'medium',
    );
    const r = planLand(story(), profile, baseOpts());
    const wait = r.steps[2];
    expect(wait.args[wait.args.indexOf('--wait-minutes') + 1]).toBe('90');
  });

  it('throws when required inputs are missing', () => {
    const profile = flatToProfile({}, 'medium');
    expect(() => planLand({}, profile, baseOpts())).toThrow();
    expect(() =>
      planLand(story(), null as unknown as Record<string, unknown>, baseOpts()),
    ).toThrow();
    expect(() => planLand(story(), profile, { scriptsDir: '/x' })).toThrow();
  });

  it('argv-only — no shell metachars across any step or land_when mode', () => {
    for (const land_when of ['no_wait', 'ci_pass', 'ci_and_review']) {
      const profile = flatToProfile({ git: { land_when } }, 'medium');
      const r = planLand(story(), profile, baseOpts());
      for (const s of r.steps) {
        for (const a of s.args) expect(a).not.toMatch(/[$`;&|<>]/);
      }
    }
  });
});

// Regression: under merge_strategy=land_as_you_go, planCommitAndPush
// deliberately skips PR creation. Pre-fix, planLand only polled for
// checks on an existing PR — which never existed — so branches got
// pushed but PRs never opened. STORY_LAND now opens the PR itself.
describe('planLand: opens the PR (regression for land_as_you_go gap)', () => {
  it('prepends create-pr.js --mode create with title/body from options', () => {
    const profile = flatToProfile(
      { git: { land_when: 'ci_pass', platform: { provider: 'github' } } },
      'medium',
    );
    const r = planLand(
      story(),
      profile,
      baseOpts({
        prTitle: 'feat(E1): land this story (S1.2)',
        prBody: 'Auto-opened by Sprintpilot STORY_LAND.',
      }),
    );
    const createPrStep = r.steps[0];
    expect(createPrStep.description).toContain('open PR');
    expect(createPrStep.args).toContain('--mode');
    expect(createPrStep.args[createPrStep.args.indexOf('--mode') + 1]).toBe('create');
    expect(createPrStep.args).toContain('--platform');
    expect(createPrStep.args[createPrStep.args.indexOf('--platform') + 1]).toBe('github');
    expect(createPrStep.args).toContain('--branch');
    expect(createPrStep.args[createPrStep.args.indexOf('--branch') + 1]).toBe('story/s1.2');
    expect(createPrStep.args).toContain('--title');
    expect(createPrStep.args[createPrStep.args.indexOf('--title') + 1]).toBe(
      'feat(E1): land this story (S1.2)',
    );
    expect(createPrStep.args).toContain('--body');
    expect(createPrStep.args[createPrStep.args.indexOf('--body') + 1]).toBe(
      'Auto-opened by Sprintpilot STORY_LAND.',
    );
    // tolerate_exit_codes mirrors planCommitAndPush so a missing platform
    // CLI degrades to SKIP rather than halting the land sequence.
    expect((createPrStep as unknown as { tolerate_exit_codes: number[] }).tolerate_exit_codes)
      .toEqual([0, 2]);
  });

  it('falls back to generic defaults when prTitle/prBody not supplied', () => {
    const profile = flatToProfile({ git: { land_when: 'no_wait' } }, 'medium');
    const r = planLand(story(), profile, baseOpts());
    const createPrStep = r.steps[0];
    expect(createPrStep.args[createPrStep.args.indexOf('--title') + 1]).toBe('S1.2');
    expect(createPrStep.args[createPrStep.args.indexOf('--body') + 1]).toContain('S1.2');
  });

  it('forwards platformBaseUrl when supplied (on-prem GitLab/Bitbucket)', () => {
    const profile = flatToProfile({ git: { land_when: 'no_wait' } }, 'medium');
    const r = planLand(
      story(),
      profile,
      baseOpts({ platformBaseUrl: 'https://gitlab.acme.example/api/v4' }),
    );
    const createPrStep = r.steps[0];
    expect(createPrStep.args).toContain('--base-url');
    expect(createPrStep.args[createPrStep.args.indexOf('--base-url') + 1]).toBe(
      'https://gitlab.acme.example/api/v4',
    );
  });

  it('falls back to profile.platform_provider when options.platform omitted', () => {
    const profile = flatToProfile(
      { git: { land_when: 'no_wait', platform: { provider: 'gitlab' } } },
      'medium',
    );
    const r = planLand(story(), profile, {
      scriptsDir: '/repo/_Sprintpilot/scripts',
      snapshotPath: '/tmp/snap.json',
      projectRoot: '/repo',
      branch: 'story/s1.2',
    });
    const createPrStep = r.steps[0];
    expect(createPrStep.args[createPrStep.args.indexOf('--platform') + 1]).toBe('gitlab');
  });
});

describe('planRebaseRecovery', () => {
  it('emits fetch + rebase steps with on_conflict halt directive', () => {
    const profile = flatToProfile({}, 'medium');
    const r = planRebaseRecovery(story(), profile, { branch: 'story/s1.2' });
    const descriptions = r.steps.map((s) => s.description);
    expect(descriptions[0]).toContain('fetch latest base');
    expect(descriptions[1]).toContain('rebase story/s1.2');
    expect(r.on_conflict.type).toBe('user_prompt');
    expect(r.on_conflict.reason).toBe('rebase_conflict');
    expect(r.on_conflict.prompt).toContain('story/s1.2');
  });

  it('targets origin/<base>', () => {
    const profile = flatToProfile({ git: { base_branch: 'develop' } }, 'medium');
    const r = planRebaseRecovery(story(), profile, { branch: 'story/s1.2' });
    expect(r.steps[1].args).toContain('origin/develop');
  });

  it('throws when branch missing', () => {
    expect(() => planRebaseRecovery(story(), flatToProfile({}, 'medium'), {})).toThrow();
  });
});

describe('isRebaseConflict', () => {
  it('detects standard CONFLICT marker', () => {
    expect(isRebaseConflict('CONFLICT (content): Merge conflict in src/app.ts')).toBe(true);
  });

  it('detects "Automatic merge failed" message', () => {
    expect(
      isRebaseConflict('Automatic merge failed; fix conflicts and then commit the result.'),
    ).toBe(true);
  });

  it('detects "Could not apply" message', () => {
    expect(isRebaseConflict('error: could not apply 1234abcd... feat: x')).toBe(true);
  });

  it('returns false for unrelated git failures', () => {
    expect(isRebaseConflict('fatal: not a git repository')).toBe(false);
    expect(isRebaseConflict('')).toBe(false);
    expect(isRebaseConflict(null as unknown as string)).toBe(false);
  });
});
