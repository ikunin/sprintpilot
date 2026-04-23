import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import cacheMod from '../../_Sprintpilot/scripts/cached-read.js';

const {
  DEFAULT_TTL_MS,
  cacheEntryPath,
  readThrough,
  invalidate,
  clearAll,
  stats,
} = cacheMod as {
  DEFAULT_TTL_MS: number;
  cacheEntryPath: (root: string, file: string) => string;
  readThrough: (
    root: string,
    file: string,
    ttl: number,
  ) => { body: string | null; hit: boolean; source: string; reason?: string };
  invalidate: (root: string, file: string) => { cleared: boolean };
  clearAll: (root: string) => { cleared: number };
  stats: (root: string) => { entries: number; oldest_age_ms: number | null; newest_age_ms: number | null };
};

const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, '_Sprintpilot', 'scripts', 'cached-read.js');

let tmpRoot = '';
let srcFile = '';

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sp-cache-'));
  srcFile = join(tmpRoot, 'sprint-status.yaml');
  writeFileSync(srcFile, 'schema_version: 1\nstories:\n  1-1-a: done\n');
});
afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

describe('readThrough — first call misses, second hits', () => {
  it('first read populates the cache; second read hits', () => {
    const r1 = readThrough(tmpRoot, srcFile, DEFAULT_TTL_MS);
    expect(r1.hit).toBe(false);
    expect(r1.body).toContain('schema_version: 1');
    expect(existsSync(cacheEntryPath(tmpRoot, srcFile))).toBe(true);
    const r2 = readThrough(tmpRoot, srcFile, DEFAULT_TTL_MS);
    expect(r2.hit).toBe(true);
    expect(r2.body).toBe(r1.body);
  });
});

describe('source-mtime invalidates the cache even without explicit invalidate', () => {
  it('a file edit invalidates the entry on the next read', () => {
    readThrough(tmpRoot, srcFile, DEFAULT_TTL_MS); // prime
    // Bump mtime forward.
    const future = new Date(Date.now() + 5_000);
    utimesSync(srcFile, future, future);
    writeFileSync(srcFile, 'schema_version: 1\nstories:\n  1-1-a: in-progress\n');
    utimesSync(srcFile, future, future);
    const r2 = readThrough(tmpRoot, srcFile, DEFAULT_TTL_MS);
    expect(r2.hit).toBe(false);
    expect(r2.body).toContain('in-progress');
  });
});

describe('TTL expiry', () => {
  it('a zero TTL always misses', () => {
    readThrough(tmpRoot, srcFile, 0); // prime
    const r2 = readThrough(tmpRoot, srcFile, 0);
    expect(r2.hit).toBe(false);
  });
});

describe('invalidate + clearAll', () => {
  it('invalidate removes a single entry', () => {
    readThrough(tmpRoot, srcFile, DEFAULT_TTL_MS);
    expect(existsSync(cacheEntryPath(tmpRoot, srcFile))).toBe(true);
    const r = invalidate(tmpRoot, srcFile);
    expect(r.cleared).toBe(true);
    expect(existsSync(cacheEntryPath(tmpRoot, srcFile))).toBe(false);
  });

  it('clearAll sweeps the cache directory', () => {
    const other = join(tmpRoot, 'git-status.yaml');
    writeFileSync(other, 'stories: []\n');
    readThrough(tmpRoot, srcFile, DEFAULT_TTL_MS);
    readThrough(tmpRoot, other, DEFAULT_TTL_MS);
    const r = clearAll(tmpRoot);
    expect(r.cleared).toBeGreaterThanOrEqual(2);
  });
});

describe('stats', () => {
  it('reports entry count and ages', () => {
    readThrough(tmpRoot, srcFile, DEFAULT_TTL_MS);
    const s = stats(tmpRoot);
    expect(s.entries).toBe(1);
    expect(s.oldest_age_ms).toBeGreaterThanOrEqual(0);
    expect(s.newest_age_ms).toBeGreaterThanOrEqual(0);
  });

  it('is empty on a virgin cache', () => {
    const s = stats(tmpRoot);
    expect(s.entries).toBe(0);
    expect(s.oldest_age_ms).toBeNull();
  });
});

describe('CLI integration', () => {
  it('read prints body via cache; invalidate empties the entry', () => {
    const body = execFileSync(process.execPath, [
      SCRIPT,
      'read',
      '--file',
      srcFile,
      '--cache-root',
      tmpRoot,
    ]).toString();
    expect(body).toContain('schema_version: 1');

    const inv = execFileSync(process.execPath, [
      SCRIPT,
      'invalidate',
      '--file',
      srcFile,
      '--cache-root',
      tmpRoot,
    ]).toString();
    expect(JSON.parse(inv).cleared).toBe(true);
  });

  it('read exits 2 when the source is missing', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const res = spawnSync(process.execPath, [
      SCRIPT,
      'read',
      '--file',
      join(tmpRoot, 'nope.yaml'),
      '--cache-root',
      tmpRoot,
    ]);
    expect(res.status).toBe(2);
  });
});
