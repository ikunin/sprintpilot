import { describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import checkPrereqsMod from '../../_Sprintpilot/scripts/check-prereqs.js';

const { parseSemver, cmp, fmt, checkNode, checkGit, MIN_NODE, MIN_GIT_STRICT, MIN_GIT_SOFT } =
  checkPrereqsMod as {
    parseSemver: (s: string) => [number, number, number] | null;
    cmp: (a: [number, number, number], b: [number, number, number]) => number;
    fmt: (v: [number, number, number]) => string;
    checkNode: () => { ok: boolean; version?: string };
    checkGit: (minStrictArg?: string) => {
      ok: boolean;
      version?: string;
      degraded?: boolean;
    };
    MIN_NODE: [number, number, number];
    MIN_GIT_STRICT: [number, number, number];
    MIN_GIT_SOFT: [number, number, number];
  };

describe('parseSemver', () => {
  it('parses x.y.z', () => {
    expect(parseSemver('2.18.0')).toEqual([2, 18, 0]);
  });
  it('parses x.y defaulting patch to 0', () => {
    expect(parseSemver('2.18')).toEqual([2, 18, 0]);
  });
  it('parses git version string', () => {
    expect(parseSemver('git version 2.39.3 (Apple Git-145)')).toEqual([2, 39, 3]);
  });
  it('parses node version prefix', () => {
    expect(parseSemver('v20.11.1')).toEqual([20, 11, 1]);
  });
  it('returns null on nonsense', () => {
    expect(parseSemver('not a version')).toBeNull();
  });
});

describe('cmp', () => {
  it('orders versions', () => {
    expect(cmp([2, 18, 0], [2, 17, 9])).toBe(1);
    expect(cmp([2, 17, 9], [2, 18, 0])).toBe(-1);
    expect(cmp([2, 18, 0], [2, 18, 0])).toBe(0);
  });
  it('minor and patch matter', () => {
    expect(cmp([2, 19, 0], [2, 18, 99])).toBe(1);
    expect(cmp([2, 18, 5], [2, 18, 4])).toBe(1);
  });
});

describe('fmt', () => {
  it('round-trips via parse', () => {
    expect(fmt([2, 39, 3])).toBe('2.39.3');
    expect(parseSemver(fmt([2, 5, 0]))).toEqual([2, 5, 0]);
  });
});

describe('MIN constants', () => {
  it('exposes expected minimums', () => {
    expect(MIN_NODE).toEqual([18, 0, 0]);
    expect(MIN_GIT_STRICT).toEqual([2, 18, 0]);
    expect(MIN_GIT_SOFT).toEqual([2, 5, 0]);
  });
});

describe('checkNode', () => {
  it('accepts the running node (assumed >=18 per package.json engines)', () => {
    const out = checkNode();
    expect(out.ok).toBe(true);
    expect(out.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('checkGit', () => {
  it('returns ok when git is available (CI + dev machines have it)', () => {
    const out = checkGit();
    expect(out.ok).toBe(true);
    expect(out.version).toBeTruthy();
  });
  it('flags degraded mode when raising the strict floor artificially high', () => {
    const out = checkGit('99.99.99');
    // Degraded iff installed git is < 99.99.99, which should always be true.
    // On real dev machines git is < 99.99.99 but >= 2.5, so degraded=true, ok=true.
    expect(out.ok).toBe(true);
    expect(out.degraded).toBe(true);
  });
});
