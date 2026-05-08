import { describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS module
import extractMod from '../../_Sprintpilot/scripts/extract-pr-number.js';

const { extract, PATTERNS } = extractMod as {
  extract: (url: string, platform: string) => number | null;
  PATTERNS: Record<string, RegExp>;
};

describe('extract-pr-number', () => {
  it('extracts GitHub PR numbers', () => {
    expect(extract('https://github.com/owner/repo/pull/42', 'github')).toBe(42);
    expect(extract('https://github.com/o/r/pull/9999', 'github')).toBe(9999);
  });

  it('extracts GitLab MR numbers (including nested groups)', () => {
    expect(extract('https://gitlab.com/group/proj/-/merge_requests/7', 'gitlab')).toBe(7);
    expect(
      extract('https://gitlab.example.com/group/sub/proj/-/merge_requests/123', 'gitlab'),
    ).toBe(123);
  });

  it('extracts Bitbucket Cloud PR numbers', () => {
    expect(extract('https://bitbucket.org/workspace/repo/pull-requests/15', 'bitbucket')).toBe(15);
  });

  it('extracts Bitbucket Server PR numbers (with /overview tail)', () => {
    expect(
      extract(
        'https://bitbucket.example.com/projects/PROJ/repos/repo/pull-requests/8/overview',
        'bitbucket',
      ),
    ).toBe(8);
  });

  it('extracts Gitea PR numbers', () => {
    expect(extract('https://gitea.example.com/owner/repo/pulls/3', 'gitea')).toBe(3);
  });

  it('strips query strings and fragments before matching', () => {
    expect(extract('https://github.com/o/r/pull/42?tab=files', 'github')).toBe(42);
    expect(extract('https://github.com/o/r/pull/42#issuecomment-1', 'github')).toBe(42);
  });

  it('returns null for non-matching URLs', () => {
    expect(extract('https://github.com/owner/repo/issues/5', 'github')).toBe(null);
    expect(extract('https://gitlab.com/owner/repo/issues/5', 'gitlab')).toBe(null);
    expect(extract('not-a-url', 'github')).toBe(null);
  });

  it('returns null for unknown platforms', () => {
    expect(extract('https://github.com/o/r/pull/1', 'unknown')).toBe(null);
  });

  it('exposes PATTERNS for the four supported platforms', () => {
    expect(Object.keys(PATTERNS).sort()).toEqual(['bitbucket', 'gitea', 'github', 'gitlab'].sort());
  });
});
