import { describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS module
import snapshotMod from '../../_Sprintpilot/scripts/stack-snapshot.js';

const {
  computeDepth,
  topologicalOrder,
  composeSnapshot,
  buildRecommendation,
  renderStackYaml,
  upsertStackBlock,
  escYaml,
} = snapshotMod as {
  computeDepth: (
    prs: Array<{ sourceBranch?: string; targetBranch?: string; number?: number }>,
    baseBranch: string,
  ) => Array<Record<string, unknown> & { depth: number }>;
  topologicalOrder: (
    prs: Array<{ depth: number; number?: number }>,
  ) => Array<{ depth: number; number?: number }>;
  composeSnapshot: (opts: {
    prs: Array<Record<string, unknown>>;
    baseBranch: string;
    branchPrefix: string;
    mergeStrategy: string;
    fetchedAt: string;
  }) => Record<string, unknown>;
  buildRecommendation: (opts: {
    depth: number;
    ciAllGreen: boolean;
    conflictsAtBase: boolean;
    mergeStrategy: string;
  }) => string | null;
  renderStackYaml: (snapshot: Record<string, unknown>) => string;
  upsertStackBlock: (text: string, newBlock: string) => string;
  escYaml: (v: unknown) => string;
};

describe('computeDepth', () => {
  it('returns 0 for PRs targeting the base branch', () => {
    const prs = [{ sourceBranch: 'story/1-1', targetBranch: 'main', number: 1 }];
    expect(computeDepth(prs, 'main')[0].depth).toBe(0);
  });

  it('chains depth through stacked PRs', () => {
    const prs = [
      { sourceBranch: 'story/1-1', targetBranch: 'main', number: 1 },
      { sourceBranch: 'story/1-2', targetBranch: 'story/1-1', number: 2 },
      { sourceBranch: 'story/1-3', targetBranch: 'story/1-2', number: 3 },
    ];
    const r = computeDepth(prs, 'main');
    expect(r.find((p) => p.number === 1)?.depth).toBe(0);
    expect(r.find((p) => p.number === 2)?.depth).toBe(1);
    expect(r.find((p) => p.number === 3)?.depth).toBe(2);
  });

  it('treats PRs targeting an unknown branch as floor (depth 0)', () => {
    const prs = [{ sourceBranch: 'story/1-1', targetBranch: 'release-2.0', number: 1 }];
    expect(computeDepth(prs, 'main')[0].depth).toBe(0);
  });

  it('survives self-cycles without infinite recursion', () => {
    const prs = [{ sourceBranch: 'a', targetBranch: 'a', number: 1 }];
    const r = computeDepth(prs, 'main');
    expect(r[0].depth).toBeGreaterThanOrEqual(0); // doesn't hang
  });
});

describe('topologicalOrder', () => {
  it('sorts by depth ascending then number', () => {
    const prs = [
      { depth: 2, number: 3 },
      { depth: 0, number: 1 },
      { depth: 1, number: 2 },
    ];
    const sorted = topologicalOrder(prs);
    expect(sorted.map((p) => p.number)).toEqual([1, 2, 3]);
  });

  it('within same depth, lower PR number comes first', () => {
    const prs = [
      { depth: 0, number: 5 },
      { depth: 0, number: 2 },
    ];
    expect(topologicalOrder(prs).map((p) => p.number)).toEqual([2, 5]);
  });
});

describe('buildRecommendation', () => {
  it('returns null when stack is empty', () => {
    expect(
      buildRecommendation({ depth: 0, ciAllGreen: false, dirtyPrs: [], mergeStrategy: 'manual' }),
    ).toBe(null);
  });

  it('flags dirty PRs above all else', () => {
    const r = buildRecommendation({
      depth: 2,
      ciAllGreen: true,
      dirtyPrs: [{ pr: 7 }, { pr: 9 }],
      mergeStrategy: 'manual',
    });
    // Recommendation points at land-stack only — resolve-docs operates on
    // already-conflicted working-tree files and can't fix platform-side
    // DIRTY merge state. land-stack does the full flow.
    expect(r).toMatch(/land-stack/);
    expect(r).not.toMatch(/resolve-docs/);
    // The new wording lists the specific dirty PR numbers.
    expect(r).toMatch(/#7, #9/);
  });

  it('recommends land-stack when CI is fully green', () => {
    const r = buildRecommendation({
      depth: 3,
      ciAllGreen: true,
      dirtyPrs: [],
      mergeStrategy: 'manual',
    });
    expect(r).toMatch(/land-stack/);
    expect(r).toMatch(/3 PRs/);
  });

  it('recommends land_as_you_go when stack is deep and CI not yet green', () => {
    const r = buildRecommendation({
      depth: 3,
      ciAllGreen: false,
      dirtyPrs: [],
      mergeStrategy: 'manual',
    });
    expect(r).toMatch(/land_as_you_go/);
  });

  it('returns null when stack is shallow and CI is pending', () => {
    expect(
      buildRecommendation({
        depth: 1,
        ciAllGreen: false,
        dirtyPrs: [],
        mergeStrategy: 'manual',
      }),
    ).toBe(null);
  });
});

describe('composeSnapshot', () => {
  const base = {
    baseBranch: 'main',
    branchPrefix: 'story/',
    mergeStrategy: 'manual',
    fetchedAt: '2026-04-15T12:00:00Z',
  };

  it('builds a healthy snapshot when all PRs are green and stacked cleanly', () => {
    const prs = [
      {
        number: 1,
        sourceBranch: 'story/1-1',
        targetBranch: 'main',
        ci: 'success',
        mergeStateStatus: 'CLEAN',
      },
      {
        number: 2,
        sourceBranch: 'story/1-2',
        targetBranch: 'story/1-1',
        ci: 'success',
        mergeStateStatus: 'CLEAN',
      },
    ];
    const s = composeSnapshot({ ...base, prs }) as {
      depth: number;
      ci_all_green: boolean;
      conflicts_at_base: boolean;
      pending_merges: Array<{ story?: string; depth: number }>;
      recommendation: string;
    };
    expect(s.depth).toBe(2);
    expect(s.ci_all_green).toBe(true);
    expect(s.conflicts_at_base).toBe(false);
    expect(s.pending_merges[0].story).toBe('1-1');
    expect(s.pending_merges[0].depth).toBe(0);
    expect(s.pending_merges[1].depth).toBe(1);
    expect(s.recommendation).toMatch(/land-stack/);
  });

  it('flags conflicts_at_base when any PR has DIRTY merge state', () => {
    const prs = [
      {
        number: 1,
        sourceBranch: 'story/1-1',
        targetBranch: 'main',
        ci: 'success',
        mergeStateStatus: 'DIRTY',
      },
    ];
    const s = composeSnapshot({ ...base, prs }) as {
      conflicts_at_base: boolean;
      recommendation: string;
    };
    expect(s.conflicts_at_base).toBe(true);
    expect(s.recommendation).toMatch(/land-stack/);
    expect(s.recommendation).not.toMatch(/resolve-docs/);
  });

  it('returns depth 0 and no recommendation when stack is empty', () => {
    const s = composeSnapshot({ ...base, prs: [] }) as { depth: number; recommendation: string };
    expect(s.depth).toBe(0);
    expect(s.recommendation).toBe('');
  });

  it('extracts story key from sourceBranch using branchPrefix', () => {
    const prs = [
      { number: 1, sourceBranch: 'story/1-1', targetBranch: 'main', ci: 'success' },
      { number: 2, sourceBranch: 'feature/x', targetBranch: 'main', ci: 'success' },
    ];
    const s = composeSnapshot({ ...base, prs }) as {
      pending_merges: Array<{ story: string | null }>;
    };
    expect(s.pending_merges[0].story).toBe('1-1');
    expect(s.pending_merges[1].story).toBe(null);
  });
});

describe('escYaml', () => {
  it('quotes strings with colons or special chars', () => {
    expect(escYaml('a: b')).toBe('"a: b"');
    expect(escYaml('a [b]')).toBe('"a [b]"');
  });

  it('passes plain strings through unquoted', () => {
    expect(escYaml('plain')).toBe('plain');
  });

  it('quotes YAML reserved literals', () => {
    expect(escYaml('true')).toBe('"true"');
    expect(escYaml('no')).toBe('"no"');
  });

  it('renders booleans and numbers without quoting', () => {
    expect(escYaml(true)).toBe('true');
    expect(escYaml(42)).toBe('42');
  });
});

describe('renderStackYaml', () => {
  it('emits a structurally valid YAML block', () => {
    const snapshot = {
      last_snapshot: '2026-04-15T12:00:00Z',
      depth: 2,
      base_branch: 'main',
      ci_all_green: false,
      conflicts_at_base: false,
      pending_merges: [
        {
          story: '1-1',
          pr: 1,
          base: 'main',
          sourceBranch: 'story/1-1',
          mergeStateStatus: 'CLEAN',
          ci: 'success',
        },
        {
          story: '1-2',
          pr: 2,
          base: 'story/1-1',
          sourceBranch: 'story/1-2',
          mergeStateStatus: 'CLEAN',
          ci: 'pending',
        },
      ],
      recommendation: 'go forth',
    };
    const text = renderStackYaml(snapshot);
    expect(text).toMatch(/^stack:\n/);
    expect(text).toMatch(/depth: 2/);
    expect(text).toMatch(/ci_all_green: false/);
    expect(text).toMatch(/pending_merges:/);
    expect(text).toMatch(/story: 1-1/);
    expect(text).toMatch(/recommendation: go forth/);
  });

  it('handles empty pending_merges as flow-style empty list', () => {
    const snapshot = {
      last_snapshot: '2026-04-15T12:00:00Z',
      depth: 0,
      base_branch: 'main',
      ci_all_green: false,
      conflicts_at_base: false,
      pending_merges: [],
      recommendation: '',
    };
    expect(renderStackYaml(snapshot)).toMatch(/pending_merges: \[\]/);
  });
});

describe('upsertStackBlock', () => {
  it('appends to a file with no existing stack: block', () => {
    const before = `# Sprintpilot — Git Status\nstories:\n  1-1:\n    branch: story/1-1\n`;
    const block = `stack:\n  depth: 1\n`;
    const after = upsertStackBlock(before, block);
    expect(after).toContain('stories:');
    expect(after).toContain('stack:');
    expect(after).toMatch(/depth: 1/);
  });

  it('replaces an existing stack: block', () => {
    const before = `# header\nstories:\n  1-1:\n    branch: x\n\nstack:\n  depth: 99\n  base_branch: old\n`;
    const block = `stack:\n  depth: 2\n  base_branch: main\n`;
    const after = upsertStackBlock(before, block);
    expect(after).toContain('depth: 2');
    expect(after).not.toContain('depth: 99');
    expect(after).toContain('base_branch: main');
    // The stories: section before stack: must be preserved.
    expect(after).toMatch(/stories:\n {2}1-1:/);
  });

  it('handles an empty input', () => {
    const after = upsertStackBlock('', `stack:\n  depth: 0\n`);
    expect(after).toMatch(/^stack:\n {2}depth: 0\n$/);
  });
});
