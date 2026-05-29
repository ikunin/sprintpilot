import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import excluded from '../../../_Sprintpilot/lib/orchestrator/excluded-stories.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sp-excluded-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('excluded-stories ledger', () => {
  it('readSet returns an empty set when the file is absent', () => {
    expect(excluded.readSet(root)).toBeInstanceOf(Set);
    expect(excluded.readSet(root).size).toBe(0);
    expect(excluded.isExcluded(root, '1-1-a')).toBe(false);
  });

  it('records a single key and reads it back', () => {
    const added = excluded.recordExcluded(root, '16-7-foo', { reason: 'user_skip_story' });
    expect(added).toBe(1);
    expect(excluded.isExcluded(root, '16-7-foo')).toBe(true);
    expect([...excluded.readSet(root)]).toEqual(['16-7-foo']);
    const map = excluded.readMap(root);
    expect(map['16-7-foo'].reason).toBe('user_skip_story');
    expect(typeof map['16-7-foo'].recorded_at).toBe('string');
  });

  it('record is idempotent and preserves the original recorded_at', () => {
    excluded.recordExcluded(root, 'a', { reason: 'first' });
    const firstAt = excluded.readMap(root).a.recorded_at;
    const addedAgain = excluded.recordExcluded(root, 'a', { reason: 'second' });
    expect(addedAgain).toBe(0); // already present
    const map = excluded.readMap(root);
    expect(map.a.recorded_at).toBe(firstAt); // unchanged
    expect(map.a.reason).toBe('second'); // reason updates
  });

  it('records and removes arrays of keys', () => {
    expect(excluded.recordExcluded(root, ['a', 'b', 'c'])).toBe(3);
    expect(excluded.readSet(root).size).toBe(3);
    expect(excluded.removeExcluded(root, ['a', 'c'])).toBe(2);
    expect([...excluded.readSet(root)]).toEqual(['b']);
    // removing an absent key is a no-op
    expect(excluded.removeExcluded(root, ['nope'])).toBe(0);
  });

  it('tolerates malformed JSON (returns empty set, never throws)', () => {
    const p = excluded.excludedPath(root);
    mkdirSync(join(root, '_bmad-output', 'implementation-artifacts'), { recursive: true });
    writeFileSync(p, '{ this is not json', 'utf8');
    expect(excluded.readSet(root).size).toBe(0);
    // and a subsequent record overwrites the garbage cleanly
    excluded.recordExcluded(root, 'x');
    expect(excluded.isExcluded(root, 'x')).toBe(true);
  });

  it('persists as parseable JSON under implementation-artifacts', () => {
    excluded.recordExcluded(root, 'k', { reason: 'r' });
    const p = excluded.excludedPath(root);
    expect(existsSync(p)).toBe(true);
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    expect(parsed.excluded_stories.k.reason).toBe('r');
  });

  it('empty / non-string inputs are no-ops', () => {
    expect(excluded.recordExcluded(root, [])).toBe(0);
    expect(excluded.recordExcluded(root, '')).toBe(0);
    expect(excluded.removeExcluded(root, [])).toBe(0);
    expect(excluded.readSet(root).size).toBe(0);
  });
});

describe('reconcileFromSprintStatus', () => {
  const NON_DONE = new Set(['deferred', 'skipped', 'wont_do', 'cancelled', 'abandoned']);

  it('folds terminal-non-done entries into the ledger', () => {
    const stories = {
      '1-1-a': { status: 'ready-for-dev' },
      '1-2-b': { status: 'deferred' },
      '1-3-c': { status: 'skipped' },
      '1-4-d': { status: 'done' }, // done MUST NOT be recorded
    };
    expect(excluded.reconcileFromSprintStatus(root, stories, NON_DONE)).toBe(2);
    const set = excluded.readSet(root);
    expect(set.has('1-2-b')).toBe(true);
    expect(set.has('1-3-c')).toBe(true);
    expect(set.has('1-4-d')).toBe(false); // done is not parked
    expect(set.has('1-1-a')).toBe(false); // active is not parked
  });

  it('is idempotent — re-running adds nothing', () => {
    const stories = { '1-2-b': { status: 'deferred' } };
    expect(excluded.reconcileFromSprintStatus(root, stories, NON_DONE)).toBe(1);
    expect(excluded.reconcileFromSprintStatus(root, stories, NON_DONE)).toBe(0);
    expect(excluded.readSet(root).size).toBe(1);
  });

  it('preserves an already-recorded entry when sprint-status flips back', () => {
    const deferred = { '1-2-b': { status: 'deferred' } };
    expect(excluded.reconcileFromSprintStatus(root, deferred, NON_DONE)).toBe(1);
    const at = excluded.readMap(root)['1-2-b'].recorded_at;
    // Simulate BMad re-plan clobbering deferred → ready-for-dev.
    const cleared = { '1-2-b': { status: 'ready-for-dev' } };
    expect(excluded.reconcileFromSprintStatus(root, cleared, NON_DONE)).toBe(0);
    const map = excluded.readMap(root);
    expect(map['1-2-b']).toBeTruthy();
    expect(map['1-2-b'].recorded_at).toBe(at);
  });

  it('tolerates missing/empty inputs', () => {
    expect(excluded.reconcileFromSprintStatus(root, null, NON_DONE)).toBe(0);
    expect(excluded.reconcileFromSprintStatus(root, {}, NON_DONE)).toBe(0);
    // missing terminalNonDone set → no-op
    expect(excluded.reconcileFromSprintStatus(root, { x: { status: 'deferred' } }, null)).toBe(0);
    expect(excluded.readSet(root).size).toBe(0);
  });
});
