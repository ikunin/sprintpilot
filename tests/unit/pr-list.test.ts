import { describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS module
import prListMod from '../../_Sprintpilot/scripts/pr-list.js';

const { filterByPrefix } = prListMod as {
  filterByPrefix: (prs: Array<{ sourceBranch?: string }>, prefix: string) => unknown[];
};

describe('filterByPrefix', () => {
  it('keeps PRs whose sourceBranch starts with the prefix', () => {
    const prs = [
      { sourceBranch: 'story/1-1' },
      { sourceBranch: 'story/1-2' },
      { sourceBranch: 'feature/x' },
    ];
    expect(filterByPrefix(prs, 'story/')).toEqual([
      { sourceBranch: 'story/1-1' },
      { sourceBranch: 'story/1-2' },
    ]);
  });

  it('returns all when prefix is empty', () => {
    const prs = [{ sourceBranch: 'a' }, { sourceBranch: 'b' }];
    expect(filterByPrefix(prs, '')).toEqual(prs);
  });

  it('handles missing sourceBranch gracefully', () => {
    const prs = [{ sourceBranch: undefined }, { sourceBranch: 'story/x' }];
    expect(filterByPrefix(prs, 'story/')).toEqual([{ sourceBranch: 'story/x' }]);
  });
});
