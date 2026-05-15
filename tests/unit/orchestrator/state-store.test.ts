import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import store from '../../../_Sprintpilot/lib/orchestrator/state-store.js';

const { write, flush, read, peekPending, resetPending, resolveStatePath, CRITICAL_KEYS } =
  store as {
    write: (
      updates: Record<string, unknown>,
      profile: Record<string, unknown>,
      context: { projectRoot: string; story?: string },
    ) => { mode: string; flushed: boolean };
    flush: (
      profile: Record<string, unknown>,
      context: { projectRoot: string; story?: string },
    ) => { mode: string; flushed: boolean };
    read: (context: { projectRoot: string }) => Record<string, unknown>;
    peekPending: (story?: string) => Record<string, unknown> | null;
    resetPending: () => void;
    resolveStatePath: (projectRoot: string) => string;
    CRITICAL_KEYS: string[];
  };

const NO_COALESCE = { coalesce_state_writes: false } as Record<string, unknown>;
const COALESCE = { coalesce_state_writes: true } as Record<string, unknown>;

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'sp-state-store-'));
  resetPending();
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  resetPending();
});

describe('write (legacy direct path)', () => {
  it('writes directly to autopilot-state.yaml when coalesce_state_writes=false', () => {
    const r = write({ current_story: 'S1', foo: 'bar' }, NO_COALESCE, { projectRoot });
    expect(r.mode).toBe('direct');
    expect(r.flushed).toBe(true);
    const text = readFileSync(resolveStatePath(projectRoot), 'utf8');
    expect(text).toContain('current_story: S1');
    expect(text).toContain('foo: bar');
    expect(text).toContain('last_updated:');
  });

  it('merges into existing file', () => {
    write({ current_story: 'S1' }, NO_COALESCE, { projectRoot });
    write({ foo: 'bar' }, NO_COALESCE, { projectRoot });
    const state = read({ projectRoot });
    expect(state.current_story).toBe('S1');
    expect(state.foo).toBe('bar');
  });

  it('atomic write — no .tmp file remains', () => {
    write({ x: 1 }, NO_COALESCE, { projectRoot });
    // Just ensure the .tmp.* file does not linger.
    const dir = join(projectRoot, '_bmad-output', 'implementation-artifacts');
    const fs = require('node:fs');
    const entries = fs.readdirSync(dir);
    expect(entries.filter((e: string) => e.includes('.tmp.'))).toEqual([]);
  });
});

describe('write (coalesce path)', () => {
  it('CRITICAL_KEYS write straight through and flush pending', () => {
    // First a non-critical: should be buffered.
    const r1 = write({ foo: 'bar' }, COALESCE, { projectRoot, story: 'S1' });
    expect(r1.mode).toBe('pending');
    expect(r1.flushed).toBe(false);
    expect(existsSync(resolveStatePath(projectRoot))).toBe(false);

    // Then a critical: flush + write critical + accumulated.
    const r2 = write({ current_story: 'S1' }, COALESCE, { projectRoot, story: 'S1' });
    expect(r2.mode).toBe('critical');
    expect(r2.flushed).toBe(true);
    const state = read({ projectRoot });
    expect(state.current_story).toBe('S1');
    expect(state.foo).toBe('bar');
    expect(peekPending('S1')).toBeNull();
  });

  it('non-critical writes accumulate without disk hit', () => {
    write({ a: 1 }, COALESCE, { projectRoot, story: 'S1' });
    write({ b: 2 }, COALESCE, { projectRoot, story: 'S1' });
    expect(existsSync(resolveStatePath(projectRoot))).toBe(false);
    expect(peekPending('S1')).toEqual({ a: 1, b: 2 });
  });

  it('flush() writes pending to disk and clears buffer', () => {
    write({ a: 1, b: 2 }, COALESCE, { projectRoot, story: 'S1' });
    const r = flush(COALESCE, { projectRoot, story: 'S1' });
    expect(r.flushed).toBe(true);
    const state = read({ projectRoot });
    expect(state.a).toBe(1);
    expect(state.b).toBe(2);
    expect(peekPending('S1')).toBeNull();
  });

  it('flush() is a no-op on empty buffer', () => {
    const r = flush(COALESCE, { projectRoot, story: 'S1' });
    expect(r.flushed).toBe(false);
  });

  it('flush is a no-op when coalesce=false (legacy mode never buffers)', () => {
    const r = flush(NO_COALESCE, { projectRoot, story: 'S1' });
    expect(r.flushed).toBe(false);
  });

  it('CRITICAL_KEYS exposes the documented set', () => {
    expect(CRITICAL_KEYS.sort()).toEqual(
      [
        'current_bmad_step',
        'current_story',
        'in_worktree',
        'patch_commits',
        'story_queue',
      ].sort(),
    );
  });

  it('mixed critical + non-critical in one call writes both atomically', () => {
    const r = write({ current_story: 'S1', foo: 'bar' }, COALESCE, { projectRoot, story: 'S1' });
    expect(r.mode).toBe('critical');
    const state = read({ projectRoot });
    expect(state.current_story).toBe('S1');
    expect(state.foo).toBe('bar');
  });
});

describe('read', () => {
  it('returns empty object when state file does not exist', () => {
    expect(read({ projectRoot })).toEqual({});
  });

  it('parses booleans, numbers, arrays', () => {
    write({ count: 7, ready: true, list: [1, 2, 3] }, NO_COALESCE, { projectRoot });
    const state = read({ projectRoot });
    expect(state.count).toBe(7);
    expect(state.ready).toBe(true);
    expect(state.list).toEqual([1, 2, 3]);
  });
});

describe('input validation', () => {
  it('throws on non-object updates', () => {
    expect(() =>
      write(null as unknown as Record<string, unknown>, NO_COALESCE, { projectRoot }),
    ).toThrow();
  });

  it('throws on missing projectRoot', () => {
    expect(() => write({}, NO_COALESCE, {} as { projectRoot: string })).toThrow();
  });

  it('throws on missing profile', () => {
    expect(() => write({}, null as unknown as Record<string, unknown>, { projectRoot })).toThrow();
  });
});
