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
    // Format is what the nano e2e test asserts on (origin/story/epic-*).
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
    // `--message=<msg>` form (single argv element) protects against
    // user-customized templates that produce a leading `-`.
    expect(r.steps[1].args.some((a: string) => a.startsWith('--message='))).toBe(true);
    expect(r.steps[2].args).toEqual(['git', 'push', '-u', 'origin', 'story/s1.2']);
    expect(r.steps[2].retry).toBeDefined();
  });

  it('phase 2 syncs _bmad-output/ to base branch after pushing story branch', () => {
    const r = plan(story(), flatToProfile({}, 'medium'), {
      type: 'git_op',
      op: 'commit_and_push_story',
    });
    // Step 0: git add. Step 1: git commit. Step 2: git push <branch>.
    // Step 3: create-pr.js (push_create_pr=true by default under stacked).
    // Step 4: switch base. Step 5–9: Phase 2 sync.
    expect(r.steps[3].args[0]).toBe('node');
    expect(r.steps[3].args.some((a: string) => a.endsWith('create-pr.js'))).toBe(true);
    expect(r.steps[4].args).toEqual(['git', 'switch', 'main']);
    expect(r.steps[5].args).toEqual([
      'git',
      'checkout',
      'story/s1.2',
      '--',
      '_bmad-output',
    ]);
    expect(r.steps[6].args).toEqual(['git', 'add', '_bmad-output']);
    expect(r.steps[7].args.slice(0, 3)).toEqual(['git', 'commit', '--allow-empty']);
    expect(r.steps[7].args[3].startsWith('--message=')).toBe(true);
    expect(r.steps[8].args).toEqual(['git', 'push', 'origin', 'main']);
    expect(r.steps[8].retry).toBeDefined();
    expect(r.steps[9].args).toEqual(['git', 'switch', 'story/s1.2']);
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
    expect(r.steps[1].args).toContain('--message=fix: oops');
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

describe('plan: commit_and_push_story — user-config knobs', () => {
  it('push.auto=false: drops every git push step (story + base)', () => {
    const p = { ...flatToProfile({}, 'medium'), push_auto: false };
    const r = plan(story(), p, { type: 'git_op', op: 'commit_and_push_story' });
    const pushSteps = r.steps.filter((s) => s.args[0] === 'git' && s.args[1] === 'push');
    expect(pushSteps).toHaveLength(0);
    // Base-branch sync still runs (commits to local base) — only pushes
    // are suppressed.
    expect(r.steps.some((s) => s.args.join(' ') === 'git switch main')).toBe(true);
  });

  it('push.auto=false: also suppresses the PR creation step (no remote ref to PR from)', () => {
    const p = { ...flatToProfile({}, 'medium'), push_auto: false };
    const r = plan(story(), p, { type: 'git_op', op: 'commit_and_push_story' });
    const prSteps = r.steps.filter((s) => s.args.some((a) => a.endsWith('create-pr.js')));
    expect(prSteps).toHaveLength(0);
  });

  it('push.create_pr=true (default) under stacked: appends create-pr.js step', () => {
    const r = plan(story(), flatToProfile({}, 'medium'), {
      type: 'git_op',
      op: 'commit_and_push_story',
    });
    const prStep = r.steps.find((s) => s.args.some((a) => a.endsWith('create-pr.js')));
    expect(prStep).toBeDefined();
    expect(prStep?.args).toContain('--branch');
    expect(prStep?.args).toContain('story/s1.2');
    expect(prStep?.args).toContain('--base');
    expect(prStep?.args).toContain('main');
    expect(prStep?.args).toContain('--platform');
  });

  it('push.create_pr=false: skips the PR step', () => {
    const p = { ...flatToProfile({}, 'medium'), push_create_pr: false };
    const r = plan(story(), p, { type: 'git_op', op: 'commit_and_push_story' });
    const prSteps = r.steps.filter((s) => s.args.some((a) => a.endsWith('create-pr.js')));
    expect(prSteps).toHaveLength(0);
  });

  it('merge_strategy=land_as_you_go: skips per-story PR (land.js owns it)', () => {
    const p = { ...flatToProfile({}, 'medium'), merge_strategy: 'land_as_you_go' };
    const r = plan(story(), p, { type: 'git_op', op: 'commit_and_push_story' });
    const prSteps = r.steps.filter((s) => s.args.some((a) => a.endsWith('create-pr.js')));
    expect(prSteps).toHaveLength(0);
  });

  it('reuse_user_branch=true: skips per-story PR (one sprint-end PR)', () => {
    const p = { ...flatToProfile({}, 'medium'), reuse_user_branch: true };
    const state = story({ user_branch: 'feature/x' });
    const r = plan(state, p, { type: 'git_op', op: 'commit_and_push_story' });
    const prSteps = r.steps.filter((s) => s.args.some((a) => a.endsWith('create-pr.js')));
    expect(prSteps).toHaveLength(0);
  });

  it('granularity=epic: PR step IS emitted (idempotent under repeated pushes to same epic branch)', () => {
    const p = { ...flatToProfile({}, 'medium'), granularity: 'epic' };
    const state = story({ current_epic: 'E1' });
    const r = plan(state, p, { type: 'git_op', op: 'commit_and_push_story' });
    const prStep = r.steps.find((s) => s.args.some((a) => a.endsWith('create-pr.js')));
    // Without a PR being opened per push, MERGE_EPIC's `gh pr merge`
    // would have nothing to merge. The idempotency lives in create-pr.js.
    expect(prStep).toBeDefined();
    expect(prStep?.args).toContain('--branch');
    expect(prStep?.args).toContain('story/epic-e1');
  });

  it('platform.provider + base_url: forwarded to the PR step argv', () => {
    const p = {
      ...flatToProfile({}, 'medium'),
      platform_provider: 'gitea',
      platform_base_url: 'https://git.example.com',
    };
    const r = plan(story(), p, { type: 'git_op', op: 'commit_and_push_story' });
    const prStep = r.steps.find((s) => s.args.some((a) => a.endsWith('create-pr.js')));
    expect(prStep?.args).toContain('--platform');
    expect(prStep?.args[prStep.args.indexOf('--platform') + 1]).toBe('gitea');
    expect(prStep?.args).toContain('--base-url');
    expect(prStep?.args[prStep.args.indexOf('--base-url') + 1]).toBe('https://git.example.com');
  });

  it('commit_template_story: placeholders {epic}, {story-key}, {story-title} are expanded', () => {
    const p = {
      ...flatToProfile({}, 'medium'),
      commit_template_story: 'feat({epic}): {story-title} ({story-key})',
    };
    const state = story({ story_key: 'S1.2', current_epic: 'E1', ac_summary: 'Login button' });
    const r = plan(state, p, { type: 'git_op', op: 'commit_and_push_story' });
    const commitStep = r.steps.find((s) => s.args[0] === 'git' && s.args[1] === 'commit');
    expect(commitStep?.args).toContain('--message=feat(E1): Login button (S1.2)');
  });

  it('commit_template_story: custom template honored', () => {
    const p = {
      ...flatToProfile({}, 'medium'),
      commit_template_story: '[{story-key}] {story-title}',
    };
    const state = story({ story_key: 'S2', current_epic: 'E2', ac_summary: 'Pay flow' });
    const r = plan(state, p, { type: 'git_op', op: 'commit_and_push_story' });
    const commitStep = r.steps.find((s) => s.args[0] === 'git' && s.args[1] === 'commit');
    expect(commitStep?.args).toContain('--message=[S2] Pay flow');
  });

  it('commit_template_story: $1/$& in ac_summary survive replacement (no backreference interpretation)', () => {
    const state = story({ ac_summary: 'Add $1 button & $& widget' });
    const r = plan(state, flatToProfile({}, 'medium'), {
      type: 'git_op',
      op: 'commit_and_push_story',
    });
    const commitStep = r.steps.find((s) => s.args[0] === 'git' && s.args[1] === 'commit');
    // Function-form replace preserves literal `$1` / `$&` characters.
    expect(commitStep?.args).toContain('--message=feat(E1): Add $1 button & $& widget (S1.2)');
  });

  it('explicit action.message still overrides the template', () => {
    const r = plan(story(), flatToProfile({}, 'medium'), {
      type: 'git_op',
      op: 'commit_and_push_story',
      message: 'hotfix: revert',
    });
    const commitStep = r.steps.find((s) => s.args[0] === 'git' && s.args[1] === 'commit');
    expect(commitStep?.args).toContain('--message=hotfix: revert');
  });

  it('push_create_pr=false + stacked + granularity=story → direct merge to base after push', () => {
    const p = { ...flatToProfile({}, 'medium'), push_create_pr: false };
    const r = plan(story(), p, { type: 'git_op', op: 'commit_and_push_story' });
    // No PR step.
    expect(r.steps.some((s) => s.args.some((a) => a.endsWith('create-pr.js')))).toBe(false);
    // Has merge step.
    expect(r.steps.some((s) => s.args.includes('--no-ff') && s.args.includes('story/s1.2'))).toBe(
      true,
    );
    // Pushes base after merge.
    const basePushSteps = r.steps.filter(
      (s) => s.args.join(' ') === 'git push origin main',
    );
    expect(basePushSteps.length).toBeGreaterThanOrEqual(1);
    // The _bmad-output-only checkout is skipped (full merge brings it).
    expect(
      r.steps.some((s) => s.args.join(' ').includes('checkout story/s1.2 -- _bmad-output')),
    ).toBe(false);
  });

  it('direct merge under squash_on_merge=true → squash + commit on base', () => {
    const p = {
      ...flatToProfile({}, 'medium'),
      push_create_pr: false,
      squash_on_merge: true,
    };
    const r = plan(story(), p, { type: 'git_op', op: 'commit_and_push_story' });
    expect(r.steps.some((s) => s.args.includes('--squash') && s.args.includes('story/s1.2'))).toBe(
      true,
    );
    // Squash creates an extra commit step on base.
    const commitOnBase = r.steps.filter(
      (s) => s.args[0] === 'git' && s.args[1] === 'commit',
    );
    expect(commitOnBase.length).toBeGreaterThanOrEqual(2); // one on branch, one on base
  });

  it('direct merge NOT used under granularity=epic (epic uses MERGE_EPIC instead)', () => {
    const p = {
      ...flatToProfile({}, 'medium'),
      push_create_pr: false,
      granularity: 'epic',
    };
    const r = plan(story(), p, { type: 'git_op', op: 'commit_and_push_story' });
    expect(r.steps.some((s) => s.args.includes('--no-ff'))).toBe(false);
  });
});

describe('branchName — max_branch_length truncation', () => {
  it('returns the name unchanged when under the limit', () => {
    const p = flatToProfile({}, 'medium');
    expect(branchName(p, 'short-key', 'E1')).toBe('story/short-key');
  });

  it('truncates and appends an 8-char hash when over the limit', () => {
    const longKey =
      '1-12-add-a-really-really-extremely-long-feature-name-with-many-tokens';
    const p = flatToProfile({}, 'medium'); // max_branch_length defaults to 60
    const name = branchName(p, longKey, 'E1');
    expect(name.length).toBeLessThanOrEqual(60);
    expect(name.startsWith('story/')).toBe(true);
    // Suffix must be a 6-char hex hash preceded by a single `-`.
    expect(name).toMatch(/-[0-9a-f]{8}$/);
  });

  it('two distinct long keys produce distinct truncated names', () => {
    const p = flatToProfile({}, 'medium');
    const a = branchName(
      p,
      '1-12-add-a-really-really-extremely-long-feature-name-version-one',
      'E1',
    );
    const b = branchName(
      p,
      '1-12-add-a-really-really-extremely-long-feature-name-version-two',
      'E1',
    );
    expect(a).not.toBe(b);
  });

  it('honors custom max_branch_length', () => {
    const p = { ...flatToProfile({}, 'medium'), max_branch_length: 20 };
    const name = branchName(p, 'add-a-very-long-feature-name', 'E1');
    expect(name.length).toBeLessThanOrEqual(20);
    expect(name).toMatch(/-[0-9a-f]{8}$/);
  });
});

describe('integration: granularity=epic full lifecycle (commit_and_push → MERGE_EPIC)', () => {
  it('commit_and_push emits PR step under granularity=epic; MERGE_EPIC then merges it', () => {
    const p = { ...flatToProfile({}, 'medium'), granularity: 'epic' };
    const state = story({ current_epic: 'E1' });
    // Story commit pushes to the epic branch and opens the PR.
    const commit = plan(state, p, { type: 'git_op', op: 'commit_and_push_story' });
    const prStep = commit.steps.find((s) => s.args.some((a) => a.endsWith('create-pr.js')));
    expect(prStep).toBeDefined();
    expect(prStep?.args).toContain('story/epic-e1');
    // At epic boundary, MERGE_EPIC merges that same PR.
    const merge = plan(state, p, { type: 'git_op', op: 'merge_epic' });
    const ghStep = merge.steps.find((s) => s.args[0] === 'gh');
    expect(ghStep).toBeDefined();
    expect(ghStep?.args).toContain('story/epic-e1');
    expect(ghStep?.args).toContain('--merge');
  });

  it('commit_and_push is idempotent under granularity=epic — repeated calls emit identical PR steps', () => {
    // Real epics push N stories to the same branch. The full step
    // (args + env + tolerate_exit_codes + retry + description) must be
    // identical across calls so create-pr.js's pre-check
    // (`gh pr list --head <branch>`) reliably short-circuits the
    // second+ invocations and so a future regression that introduces
    // non-deterministic content (e.g. a timestamp in env) trips here.
    const p = { ...flatToProfile({}, 'medium'), granularity: 'epic' };
    const state = story({ current_epic: 'E1' });
    const a = plan(state, p, { type: 'git_op', op: 'commit_and_push_story' });
    const b = plan(state, p, { type: 'git_op', op: 'commit_and_push_story' });
    const aPr = a.steps.find((s) => s.args.some((arg) => arg.endsWith('create-pr.js')));
    const bPr = b.steps.find((s) => s.args.some((arg) => arg.endsWith('create-pr.js')));
    // toEqual on the whole step object (not just args).
    expect(bPr).toEqual(aPr);
  });
});

describe('plan: merge_epic', () => {
  it('default (push_create_pr=true + github/auto) → wait + switch base + gh pr merge --merge --delete-branch + cleanup', () => {
    const r = plan(story(), flatToProfile({}, 'medium'), { type: 'git_op', op: 'merge_epic' });
    // v2.2.20: cleanup_on_merge defaults true → one extra cleanup step
    // is appended after the merge.
    expect(r.steps).toHaveLength(4);
    // Step 0: wait for CI green.
    expect(r.steps[0].args[0]).toBe('node');
    expect(r.steps[0].args.some((a: string) => a.endsWith('create-pr.js'))).toBe(true);
    expect(r.steps[0].args).toContain('--mode');
    expect(r.steps[0].args).toContain('checks');
    expect(r.steps[0].tolerate_exit_codes).toEqual([0, 2]);
    // Step 1: switch to base so gh can delete the merged branch even
    // when this worktree currently has it checked out.
    expect(r.steps[1].args).toEqual(['git', 'switch', 'main']);
    // Step 2: gh pr merge.
    expect(r.steps[2].args[0]).toBe('gh');
    expect(r.steps[2].args).toContain('pr');
    expect(r.steps[2].args).toContain('merge');
    expect(r.steps[2].args).toContain('--merge');
    expect(r.steps[2].args).toContain('--delete-branch');
    // Step 3: worktree cleanup (cleanup_on_merge=true by default).
    expect(r.steps[3].args[0]).toBe('node');
    expect(r.steps[3].args.some((a: string) => a.endsWith('cleanup-worktrees.js'))).toBe(true);
    expect(r.steps[3].optional).toBe(true);
  });

  it('cleanup_on_merge=false → no cleanup step appended', () => {
    const p = { ...flatToProfile({}, 'medium'), worktree_cleanup_on_merge: false };
    const r = plan(story(), p, { type: 'git_op', op: 'merge_epic' });
    expect(r.steps).toHaveLength(3);
    expect(r.steps.find((s: { args: string[] }) =>
      s.args.some((a) => typeof a === 'string' && a.endsWith('cleanup-worktrees.js')),
    )).toBeUndefined();
  });

  it('default + squash_on_merge=true → gh pr merge --squash', () => {
    const p = { ...flatToProfile({}, 'medium'), squash_on_merge: true };
    const r = plan(story(), p, { type: 'git_op', op: 'merge_epic' });
    const ghStep = r.steps.find((s) => s.args[0] === 'gh');
    expect(ghStep?.args).toContain('--squash');
    expect(ghStep?.args).not.toContain('--merge');
  });

  it('platform_base_url → GH_HOST/GITLAB_URI env on the merge step', () => {
    const p = {
      ...flatToProfile({}, 'medium'),
      platform_base_url: 'https://ghe.example.com',
    };
    const r = plan(story(), p, { type: 'git_op', op: 'merge_epic' });
    const ghStep = r.steps.find((s) => s.args[0] === 'gh');
    expect(ghStep?.env).toBeDefined();
    expect(ghStep?.env.GH_HOST).toBe('ghe.example.com');
    expect(ghStep?.env.GITLAB_URI).toBe('https://ghe.example.com');
  });

  it('no platform_base_url → no env field on the merge step', () => {
    const r = plan(story(), flatToProfile({}, 'medium'), { type: 'git_op', op: 'merge_epic' });
    const ghStep = r.steps.find((s) => s.args[0] === 'gh');
    expect(ghStep?.env).toBeUndefined();
  });

  it('platform_base_url with port + path → GH_HOST strips path; GITLAB_URI preserves it', () => {
    const p = {
      ...flatToProfile({}, 'medium'),
      platform_base_url: 'https://git.example.com:8443/gitlab',
    };
    const r = plan(story(), p, { type: 'git_op', op: 'merge_epic' });
    const ghStep = r.steps.find((s) => s.args[0] === 'gh');
    expect(ghStep?.env.GH_HOST).toBe('git.example.com:8443');
    expect(ghStep?.env.GITLAB_URI).toBe('https://git.example.com:8443/gitlab');
  });

  it('malformed platform_base_url → no env (does not throw)', () => {
    const p = { ...flatToProfile({}, 'medium'), platform_base_url: 'not a url' };
    const r = plan(story(), p, { type: 'git_op', op: 'merge_epic' });
    const ghStep = r.steps.find((s) => s.args[0] === 'gh');
    expect(ghStep?.env).toBeUndefined();
  });

  it('push_create_pr=false (local merge): non-squash → fetch + switch + ff base + non-ff merge + push', () => {
    const p = { ...flatToProfile({}, 'medium'), push_create_pr: false };
    const r = plan(story(), p, { type: 'git_op', op: 'merge_epic' });
    const descriptions = r.steps.map((s) => s.description);
    expect(descriptions).toContain('sync with remote');
    expect(descriptions).toContain('switch to main');
    expect(r.steps.some((s) => s.args.includes('--no-ff'))).toBe(true);
  });

  it('push_create_pr=false + squash_on_merge=true → local merge --squash + commit', () => {
    const p = { ...flatToProfile({ git: { squash_on_merge: true } }, 'nano'), push_create_pr: false };
    const r = plan(story(), p, { type: 'git_op', op: 'merge_epic' });
    expect(r.steps.some((s) => s.args.includes('--squash'))).toBe(true);
    expect(
      r.steps.some(
        (s) =>
          s.args[0] === 'git' &&
          s.args[1] === 'commit' &&
          s.args.some((a: string) => a.startsWith('--message=')),
      ),
    ).toBe(true);
  });

  it('platform=gitlab + push_create_pr=true → switch base + glab mr merge', () => {
    const p = { ...flatToProfile({}, 'medium'), platform_provider: 'gitlab' };
    const r = plan(story(), p, { type: 'git_op', op: 'merge_epic' });
    // Step 0: switch to base.
    expect(r.steps[0].args).toEqual(['git', 'switch', 'main']);
    // Step 1: glab mr merge.
    expect(r.steps[1].args[0]).toBe('glab');
    expect(r.steps[1].args).toContain('mr');
    expect(r.steps[1].args).toContain('merge');
  });

  it('platform=gitlab + squash → glab mr merge --squash', () => {
    const p = {
      ...flatToProfile({}, 'medium'),
      platform_provider: 'gitlab',
      squash_on_merge: true,
    };
    const r = plan(story(), p, { type: 'git_op', op: 'merge_epic' });
    const glabStep = r.steps.find((s) => s.args[0] === 'glab');
    expect(glabStep?.args).toContain('--squash');
  });

  it('platform=bitbucket → halt_action with user_prompt (no autopilot-supported merge CLI)', () => {
    const p = { ...flatToProfile({}, 'medium'), platform_provider: 'bitbucket' };
    const r = plan(story(), p, { type: 'git_op', op: 'merge_epic' });
    expect(r.halt_action).toBeDefined();
    expect(r.halt_action.type).toBe('user_prompt');
    expect(r.halt_action.reason).toBe('epic_merge_unsupported_platform');
  });

  it('platform=gitea → halt_action with user_prompt', () => {
    const p = { ...flatToProfile({}, 'medium'), platform_provider: 'gitea' };
    const r = plan(story(), p, { type: 'git_op', op: 'merge_epic' });
    expect(r.halt_action).toBeDefined();
    expect(r.halt_action.reason).toBe('epic_merge_unsupported_platform');
  });

  it('has_origin=false + push_create_pr=false → local merge without fetch/push', () => {
    const p = { ...flatToProfile({}, 'medium'), push_create_pr: false, has_origin: false };
    const r = plan(story(), p, { type: 'git_op', op: 'merge_epic' });
    expect(r.steps.some((s) => s.args[0] === 'git' && s.args[1] === 'push')).toBe(false);
    expect(r.steps.some((s) => s.args[0] === 'git' && s.args[1] === 'fetch')).toBe(false);
    expect(r.steps.some((s) => s.args.includes('--no-ff'))).toBe(true);
  });
});

describe('plan: create_branch', () => {
  it('default settings: fetch base, then switch -c <branch> <base>', () => {
    const r = plan(story(), flatToProfile({}, 'medium'), { type: 'git_op', op: 'create_branch' });
    expect(r.steps).toHaveLength(2);
    expect(r.steps[0].args).toEqual(['git', 'fetch', 'origin', 'main']);
    expect(r.steps[1].args).toEqual(['git', 'switch', '-c', 'story/s1.2', 'main']);
  });

  it('has_origin=false: no fetch step, just switch -c', () => {
    const p = { ...flatToProfile({}, 'medium'), has_origin: false };
    const r = plan(story(), p, { type: 'git_op', op: 'create_branch' });
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0].args).toEqual(['git', 'switch', '-c', 'story/s1.2', 'main']);
  });

  it('state.branch_exists=true: idempotent switch (no -c, no reset)', () => {
    const state = story({ branch_exists: true });
    const r = plan(state, flatToProfile({}, 'medium'), { type: 'git_op', op: 'create_branch' });
    // Fetch still runs (best-effort, idempotent). Switch uses no -c flag.
    const switchStep = r.steps.find(
      (s) => s.args[0] === 'git' && s.args[1] === 'switch' && !s.args.includes('-c'),
    );
    expect(switchStep).toBeDefined();
    expect(switchStep?.args).toEqual(['git', 'switch', 'story/s1.2']);
    // Must NOT emit `switch -c` when the branch already exists — that would
    // either fail (already exists) or destroy prior work (with -C).
    expect(r.steps.some((s) => s.args.includes('-c') || s.args.includes('-C'))).toBe(false);
  });

  it('state.branch_exists=true + has_origin=false: single switch step', () => {
    const state = story({ branch_exists: true });
    const p = { ...flatToProfile({}, 'medium'), has_origin: false };
    const r = plan(state, p, { type: 'git_op', op: 'create_branch' });
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0].args).toEqual(['git', 'switch', 'story/s1.2']);
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
