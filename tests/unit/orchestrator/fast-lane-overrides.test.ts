import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import overrides from '../../../_Sprintpilot/lib/orchestrator/fast-lane-overrides.js';

const { overridesPath, normalizeEpicKey, readMap, resolve, setOverride, clearOverride } =
  overrides as {
    overridesPath: (root: string) => string;
    normalizeEpicKey: (k: string) => string;
    readMap: (root: string) => { stories: Record<string, unknown>; epics: Record<string, unknown> };
    resolve: (
      root: string,
      storyKey: string | null,
      epicKey: string | null,
    ) => 'fast' | 'full' | null;
    setOverride: (
      root: string,
      key: string,
      decision: string,
      opts?: { isEpic?: boolean },
    ) => { ok: boolean; bucket?: string; key?: string; reason?: string };
    clearOverride: (root: string, key: string, opts?: { isEpic?: boolean }) => boolean;
  };

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sp-fl-overrides-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('fast-lane-overrides store', () => {
  it('is empty and tolerant when the file is absent', () => {
    expect(readMap(root)).toEqual({ stories: {}, epics: {} });
    expect(resolve(root, '1-1', '1')).toBeNull();
  });

  it('sets and resolves a story mark', () => {
    expect(setOverride(root, '4-1-docs', 'fast').ok).toBe(true);
    expect(resolve(root, '4-1-docs', '4')).toBe('fast');
  });

  it('sets and resolves an epic mark, normalizing the key', () => {
    setOverride(root, 'epic-5', 'full', { isEpic: true });
    // stored under bare id 5; resolves whether the caller passes 5 or epic-5
    expect(resolve(root, '5-2-x', '5')).toBe('full');
    expect(resolve(root, '5-2-x', 'epic-5')).toBe('full');
    expect(normalizeEpicKey('Epic-5')).toBe('5');
  });

  it('a story mark WINS over its epic mark', () => {
    setOverride(root, 'epic-4', 'full', { isEpic: true });
    setOverride(root, '4-1-docs', 'fast');
    expect(resolve(root, '4-1-docs', '4')).toBe('fast'); // story wins
    expect(resolve(root, '4-2-other', '4')).toBe('full'); // sibling falls to epic
  });

  it('clear reverts to auto (null)', () => {
    setOverride(root, '4-1', 'fast');
    expect(clearOverride(root, '4-1')).toBe(true);
    expect(resolve(root, '4-1', '4')).toBeNull();
    expect(clearOverride(root, '4-1')).toBe(false); // idempotent
  });

  it('rejects an invalid decision', () => {
    expect(setOverride(root, '4-1', 'maybe').ok).toBe(false);
  });

  it('persists JSON under the conventional path with replace semantics', () => {
    setOverride(root, '4-1', 'fast');
    setOverride(root, '4-1', 'full'); // replace, not append
    const raw = JSON.parse(readFileSync(overridesPath(root), 'utf8'));
    expect(raw.fast_lane_overrides.stories['4-1'].decision).toBe('full');
    expect(Object.keys(raw.fast_lane_overrides.stories)).toEqual(['4-1']);
  });

  it('tolerates a mangled file (empty maps, never throws)', () => {
    setOverride(root, '4-1', 'fast');
    // corrupt it
    rmSync(overridesPath(root));
    require('node:fs').writeFileSync(overridesPath(root), '{ not json', 'utf8');
    expect(readMap(root)).toEqual({ stories: {}, epics: {} });
    expect(resolve(root, '4-1', '4')).toBeNull();
  });
});
