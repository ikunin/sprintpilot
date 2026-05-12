import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import shardMod from '../../_Sprintpilot/scripts/state-shard.js';

const {
  CRITICAL_KEYS,
  batchWrite,
  flushPending,
  readPending,
  pendingPath,
  shardPath,
  readShard,
  writeShardAtomic,
  containsCriticalKey,
} = shardMod as {
  CRITICAL_KEYS: Set<string>;
  batchWrite: (
    root: string,
    story: string,
    kind: string,
    partial: Record<string, unknown>,
  ) => Record<string, unknown>;
  flushPending: (root: string, story: string, kind: string) => { flushed: boolean; fields: number };
  readPending: (root: string, story: string, kind: string) => Record<string, unknown>;
  pendingPath: (root: string, story: string, kind: string) => string;
  shardPath: (root: string, story: string, kind: string) => string;
  readShard: (root: string, story: string, kind: string) => Record<string, unknown> | null;
  writeShardAtomic: (
    root: string,
    story: string,
    kind: string,
    obj: Record<string, unknown>,
  ) => string;
  containsCriticalKey: (obj: Record<string, unknown>) => boolean;
};

const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, '_Sprintpilot', 'scripts', 'state-shard.js');

let tmpRoot = '';
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sp-coalesce-'));
});
afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

describe('CRITICAL_KEYS', () => {
  it('covers the four crash-recovery keys from the PR 6 spec', () => {
    expect(CRITICAL_KEYS.has('current_story')).toBe(true);
    expect(CRITICAL_KEYS.has('current_bmad_step')).toBe(true);
    expect(CRITICAL_KEYS.has('in_worktree')).toBe(true);
    expect(CRITICAL_KEYS.has('patch_commits')).toBe(true);
    // Non-critical fields are not in the set.
    expect(CRITICAL_KEYS.has('test_count')).toBe(false);
    expect(CRITICAL_KEYS.has('lint_result')).toBe(false);
  });
});

describe('containsCriticalKey', () => {
  it('returns true iff any top-level key is critical', () => {
    expect(containsCriticalKey({ current_story: 'x' })).toBe(true);
    expect(containsCriticalKey({ test_count: 9, current_bmad_step: 3 })).toBe(true);
    expect(containsCriticalKey({ test_count: 9, lint_result: 'ok' })).toBe(false);
    expect(containsCriticalKey({})).toBe(false);
    expect(containsCriticalKey(null as unknown as Record<string, unknown>)).toBe(false);
  });
});

describe('batchWrite + flushPending', () => {
  it('accumulates fields in the pending file, not the shard', () => {
    batchWrite(tmpRoot, 's1', 'state', { a: 1, b: 2 });
    batchWrite(tmpRoot, 's1', 'state', { c: 3 });
    expect(existsSync(shardPath(tmpRoot, 's1', 'state'))).toBe(false);
    expect(existsSync(pendingPath(tmpRoot, 's1', 'state'))).toBe(true);
    const pending = readPending(tmpRoot, 's1', 'state');
    expect(pending).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('flush writes pending into shard and clears pending', () => {
    batchWrite(tmpRoot, 's1', 'state', { a: 1, b: 2 });
    const res = flushPending(tmpRoot, 's1', 'state');
    expect(res.flushed).toBe(true);
    expect(res.fields).toBe(2);
    expect(existsSync(pendingPath(tmpRoot, 's1', 'state'))).toBe(false);
    const shard = readShard(tmpRoot, 's1', 'state')!;
    expect(shard.a).toBe(1);
    expect(shard.b).toBe(2);
  });

  it('flush is idempotent when nothing is pending', () => {
    const res = flushPending(tmpRoot, 's1', 'state');
    expect(res.flushed).toBe(false);
    expect(res.fields).toBe(0);
  });

  it('flush merges into an existing shard without losing prior fields', () => {
    writeShardAtomic(tmpRoot, 's1', 'state', { prior: 'kept' });
    batchWrite(tmpRoot, 's1', 'state', { new_field: 'added' });
    flushPending(tmpRoot, 's1', 'state');
    const shard = readShard(tmpRoot, 's1', 'state')!;
    expect(shard.prior).toBe('kept');
    expect(shard.new_field).toBe('added');
  });
});

describe('CLI — batch + flush + critical bypass', () => {
  it('batch keeps shard empty until flush', () => {
    execFileSync(process.execPath, [
      SCRIPT,
      'batch',
      '--story',
      's1',
      '--json',
      '{"a":1}',
      '--project-root',
      tmpRoot,
    ]);
    execFileSync(process.execPath, [
      SCRIPT,
      'batch',
      '--story',
      's1',
      '--json',
      '{"b":2}',
      '--project-root',
      tmpRoot,
    ]);
    expect(existsSync(shardPath(tmpRoot, 's1', 'state'))).toBe(false);

    const out = execFileSync(process.execPath, [
      SCRIPT,
      'flush',
      '--story',
      's1',
      '--project-root',
      tmpRoot,
    ]).toString();
    expect(JSON.parse(out).flushed).toBe(true);
    const shard = readShard(tmpRoot, 's1', 'state')!;
    expect(shard.a).toBe(1);
    expect(shard.b).toBe(2);
  });

  it('batch with a critical key auto-flushes prior buffered fields + itself', () => {
    execFileSync(process.execPath, [
      SCRIPT,
      'batch',
      '--story',
      's1',
      '--json',
      JSON.stringify({ test_count: 9, lint_ok: true }),
      '--project-root',
      tmpRoot,
    ]);
    // Buffered, not yet in shard.
    expect(existsSync(shardPath(tmpRoot, 's1', 'state'))).toBe(false);

    execFileSync(process.execPath, [
      SCRIPT,
      'batch',
      '--story',
      's1',
      '--json',
      JSON.stringify({ current_story: 's1', current_bmad_step: 4 }),
      '--project-root',
      tmpRoot,
    ]);
    // Buffer is gone, shard has BOTH the previously-buffered and the critical fields.
    expect(existsSync(pendingPath(tmpRoot, 's1', 'state'))).toBe(false);
    const shard = readShard(tmpRoot, 's1', 'state')!;
    expect(shard.test_count).toBe(9);
    expect(shard.lint_ok).toBe(true);
    expect(shard.current_story).toBe('s1');
    expect(shard.current_bmad_step).toBe(4);
  });

  it('write also flushes pending so the shard never has stale buffered data', () => {
    execFileSync(process.execPath, [
      SCRIPT,
      'batch',
      '--story',
      's1',
      '--json',
      '{"x":1}',
      '--project-root',
      tmpRoot,
    ]);
    execFileSync(process.execPath, [
      SCRIPT,
      'write',
      '--story',
      's1',
      '--json',
      '{"y":2}',
      '--project-root',
      tmpRoot,
    ]);
    const shard = readShard(tmpRoot, 's1', 'state')!;
    expect(shard.x).toBe(1);
    expect(shard.y).toBe(2);
    expect(existsSync(pendingPath(tmpRoot, 's1', 'state'))).toBe(false);
  });
});
