import { describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import land from '../../_Sprintpilot/scripts/land-this-pr.js';

const { buildPlan } = land as {
  buildPlan: (
    snapshot: Record<string, unknown>,
    opts: { squash?: boolean; base?: string },
  ) => {
    steps: { args: string[]; description: string; retry?: unknown }[];
    skipped: boolean;
    branch?: string;
    base?: string;
    rebased?: string[];
  };
};

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  base_branch: 'main',
  branches: [
    { name: 'story/s1', head: 'aaa', story_key: 's1', status: 'in_progress' },
    { name: 'story/s2', head: 'bbb', story_key: 's2', status: 'done' },
    { name: 'story/s3', head: 'ccc', story_key: 's3', status: 'in_progress' },
  ],
  active_pr: { branch: 'story/s1', story_key: 's1' },
  ...overrides,
});

describe('buildPlan', () => {
  it('skips when no active_pr', () => {
    const r = buildPlan({ ...snapshot(), active_pr: null }, {});
    expect(r.skipped).toBe(true);
  });

  it('non-squash plan: fetch + switch + ff + non-ff merge + push + delete', () => {
    const r = buildPlan(snapshot(), {});
    expect(r.skipped).toBe(false);
    const descs = r.steps.map((s) => s.description);
    expect(descs).toContain('sync remote');
    expect(descs).toContain('switch to main');
    expect(descs).toContain('ff base to remote');
    expect(descs).toContain('non-ff merge');
    expect(descs).toContain('push main');
    expect(descs).toContain('delete local story/s1');
  });

  it('squash plan: --squash + commit', () => {
    const r = buildPlan(snapshot(), { squash: true });
    expect(r.steps.some((s) => s.args.includes('--squash'))).toBe(true);
    expect(r.steps.some((s) => s.args.includes('commit') && s.args.includes('-m'))).toBe(true);
  });

  it('rebases the remaining stack onto base', () => {
    const r = buildPlan(snapshot(), {});
    // s2 is done → excluded; s1 is the active → excluded; s3 should be rebased.
    expect(r.rebased).toEqual(['story/s3']);
    expect(r.steps.some((s) => s.args.includes('rebase') && s.args.includes('story/s3'))).toBe(
      true,
    );
  });

  it('honors --base override', () => {
    const r = buildPlan(snapshot(), { base: 'develop' });
    expect(r.base).toBe('develop');
    expect(r.steps.some((s) => s.args.includes('switch') && s.args.includes('develop'))).toBe(true);
  });
});
