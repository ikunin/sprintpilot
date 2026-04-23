import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import submoduleLockMod from '../../_Sprintpilot/scripts/submodule-lock.js';

const { slugify, lockPathFor, acquire, release, check } = submoduleLockMod as {
  slugify: (s: string) => string;
  lockPathFor: (root: string, name: string) => string;
  acquire: (root: string, name: string) => { status: number; stdout: string; stderr: string };
  release: (root: string, name: string) => { status: number; stdout: string; stderr: string };
  check: (root: string, name: string) => { status: number; stdout: string; stderr: string };
};

const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, '_Sprintpilot', 'scripts', 'submodule-lock.js');

let tmpRoot = '';

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sp-sm-'));
});
afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

describe('slugify', () => {
  it('maps slashes and other chars to dashes', () => {
    expect(slugify('themes/docusaurus')).toBe('themes-docusaurus');
    expect(slugify('Some Name!')).toBe('some-name');
    expect(slugify('---leading--trailing---')).toBe('leading-trailing');
  });
  it('caps at 64 chars', () => {
    expect(slugify('x'.repeat(100)).length).toBe(64);
  });
});

describe('lockPathFor', () => {
  it('resolves under .sprintpilot/submodule-locks', () => {
    const p = lockPathFor(tmpRoot, 'pkg/foo');
    expect(p.endsWith('.sprintpilot/submodule-locks/pkg-foo.lock')).toBe(true);
  });

  it('throws when the slug is empty', () => {
    expect(() => lockPathFor(tmpRoot, '!!!')).toThrow();
  });
});

describe('acquire / release / check', () => {
  it('acquire creates the lock, second acquire is LOCKED, release frees it', () => {
    const a1 = acquire(tmpRoot, 'themes/docusaurus');
    expect(a1.status).toBe(0);
    expect(a1.stdout).toMatch(/^ACQUIRED/);
    expect(existsSync(lockPathFor(tmpRoot, 'themes/docusaurus'))).toBe(true);

    const a2 = acquire(tmpRoot, 'themes/docusaurus');
    expect(a2.status).not.toBe(0);
    expect(a2.stdout).toMatch(/^LOCKED/);

    const r = release(tmpRoot, 'themes/docusaurus');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^RELEASED/);

    const a3 = acquire(tmpRoot, 'themes/docusaurus');
    expect(a3.status).toBe(0);
  });

  it('different submodules do not contend', () => {
    expect(acquire(tmpRoot, 'a').status).toBe(0);
    expect(acquire(tmpRoot, 'b').status).toBe(0);
    expect(acquire(tmpRoot, 'c').status).toBe(0);
  });

  it('check on a free submodule reports FREE', () => {
    const c = check(tmpRoot, 'fresh');
    expect(c.stdout).toBe('FREE');
  });
});

describe('CLI integration', () => {
  it('acquire via CLI works end-to-end', () => {
    const out = execFileSync(process.execPath, [
      SCRIPT,
      'acquire',
      '--submodule',
      'libs/core',
      '--project-root',
      tmpRoot,
    ]).toString();
    expect(out).toMatch(/^ACQUIRED/);
  });

  it('rejects invalid action with exit 1', () => {
    const res = spawnSync(process.execPath, [
      SCRIPT,
      'lock-it',
      '--submodule',
      'x',
      '--project-root',
      tmpRoot,
    ]);
    expect(res.status).toBe(1);
  });

  it('rejects missing --submodule with exit 1', () => {
    const res = spawnSync(process.execPath, [SCRIPT, 'acquire', '--project-root', tmpRoot]);
    expect(res.status).toBe(1);
  });
});
