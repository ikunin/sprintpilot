import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import portable from '../../_Sprintpilot/scripts/git-portable.js';

const { countWorktrees, configGet, commonDir, safeAdd } = portable as {
  countWorktrees: (root: string) => number;
  configGet: (root: string, key: string, opts: { defaultValue: string; scope: string | null }) => string;
  commonDir: (root: string) => { ok: boolean; value?: string; error?: string };
  safeAdd: (root: string, paths: string[]) => { added: string[]; skipped: string[] };
};

const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, '_Sprintpilot', 'scripts', 'git-portable.js');

let tmpRoot = '';

function git(args: string[]): void {
  execFileSync('git', ['-C', tmpRoot, ...args], { encoding: 'utf-8', timeout: 10_000 });
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sp-gitp-'));
  git(['init', '--initial-branch=main']);
  git(['config', 'user.email', 't@e.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(tmpRoot, 'README.md'), 'hello');
  git(['add', '-A']);
  git(['commit', '-m', 'init']);
});

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────
// countWorktrees
// ──────────────────────────────────────────────────────────────────

describe('countWorktrees', () => {
  it('returns 1 for a single-worktree repo (just main)', () => {
    expect(countWorktrees(tmpRoot)).toBe(1);
  });

  it('returns 2 after adding one worktree', () => {
    git(['checkout', '-b', 'feature']);
    git(['checkout', 'main']);
    mkdirSync(join(tmpRoot, '.worktrees'), { recursive: true });
    git(['worktree', 'add', join(tmpRoot, '.worktrees', 'feature'), 'feature']);
    expect(countWorktrees(tmpRoot)).toBe(2);
  });

  it('fails open to 2 when run on a non-repo directory', () => {
    const nonRepo = mkdtempSync(join(tmpdir(), 'sp-non-repo-'));
    try {
      expect(countWorktrees(nonRepo)).toBe(2);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────────────────────────
// configGet
// ──────────────────────────────────────────────────────────────────

describe('configGet', () => {
  it('returns the configured value when present', () => {
    git(['config', '--local', 'gc.auto', '0']);
    expect(configGet(tmpRoot, 'gc.auto', { defaultValue: 'unset', scope: null })).toBe('0');
  });

  it('returns the default when key is absent', () => {
    expect(configGet(tmpRoot, 'gc.auto', { defaultValue: 'unset', scope: null })).toBe('unset');
  });

  it('honors a custom default', () => {
    expect(configGet(tmpRoot, 'gc.auto', { defaultValue: '0', scope: null })).toBe('0');
  });

  it('respects --scope local for present + absent keys', () => {
    git(['config', '--local', 'foo.bar', 'baz']);
    expect(configGet(tmpRoot, 'foo.bar', { defaultValue: 'X', scope: 'local' })).toBe('baz');
    expect(configGet(tmpRoot, 'foo.missing', { defaultValue: 'X', scope: 'local' })).toBe('X');
  });
});

// ──────────────────────────────────────────────────────────────────
// commonDir
// ──────────────────────────────────────────────────────────────────

describe('commonDir', () => {
  it('returns an absolute path for a normal repo', () => {
    const r = commonDir(tmpRoot);
    expect(r.ok).toBe(true);
    expect(r.value).toBeTruthy();
    // Path may be either tmpRoot/.git or its realpath; just assert it ends in .git.
    expect(r.value!.endsWith('.git')).toBe(true);
  });

  it('returns ok: false on a non-repo directory', () => {
    const nonRepo = mkdtempSync(join(tmpdir(), 'sp-non-repo-'));
    try {
      const r = commonDir(nonRepo);
      expect(r.ok).toBe(false);
      expect(r.error).toBeTruthy();
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────────────────────────
// safeAdd
// ──────────────────────────────────────────────────────────────────

describe('safeAdd', () => {
  it('adds existing paths and skips missing ones', () => {
    writeFileSync(join(tmpRoot, 'a.txt'), 'a');
    writeFileSync(join(tmpRoot, 'b.txt'), 'b');
    const r = safeAdd(tmpRoot, ['a.txt', 'b.txt', 'missing.txt']);
    expect(r.added.sort()).toEqual(['a.txt', 'b.txt']);
    expect(r.skipped).toEqual(['missing.txt']);
    // Verify the staging area actually has both.
    const staged = execFileSync('git', ['-C', tmpRoot, 'diff', '--cached', '--name-only'], {
      encoding: 'utf-8',
    }).trim();
    expect(staged.split('\n').sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('returns added: [] when all paths are missing (no git invocation)', () => {
    const r = safeAdd(tmpRoot, ['nope.txt', 'gone.txt']);
    expect(r.added).toEqual([]);
    expect(r.skipped.sort()).toEqual(['gone.txt', 'nope.txt']);
    // Nothing should be staged.
    const staged = execFileSync('git', ['-C', tmpRoot, 'diff', '--cached', '--name-only'], {
      encoding: 'utf-8',
    }).trim();
    expect(staged).toBe('');
  });

  it('handles directories (added recursively by git)', () => {
    mkdirSync(join(tmpRoot, 'dir'), { recursive: true });
    writeFileSync(join(tmpRoot, 'dir', 'x.txt'), 'x');
    writeFileSync(join(tmpRoot, 'dir', 'y.txt'), 'y');
    const r = safeAdd(tmpRoot, ['dir']);
    expect(r.added).toEqual(['dir']);
    const staged = execFileSync('git', ['-C', tmpRoot, 'diff', '--cached', '--name-only'], {
      encoding: 'utf-8',
    }).trim();
    expect(staged.split('\n').sort()).toEqual(['dir/x.txt', 'dir/y.txt']);
  });
});

// ──────────────────────────────────────────────────────────────────
// CLI integration
// ──────────────────────────────────────────────────────────────────

describe('CLI', () => {
  it('count-worktrees prints integer to stdout', () => {
    const out = execFileSync(process.execPath, [
      SCRIPT,
      'count-worktrees',
      '--project-root',
      tmpRoot,
    ]).toString();
    expect(out.trim()).toBe('1');
  });

  it('config-get with --default works for missing key', () => {
    const out = execFileSync(process.execPath, [
      SCRIPT,
      'config-get',
      'gc.auto',
      '--default',
      'unset',
      '--project-root',
      tmpRoot,
    ]).toString();
    expect(out.trim()).toBe('unset');
  });

  it('config-get returns the actual value when set', () => {
    git(['config', '--local', 'gc.auto', '0']);
    const out = execFileSync(process.execPath, [
      SCRIPT,
      'config-get',
      'gc.auto',
      '--default',
      'unset',
      '--project-root',
      tmpRoot,
    ]).toString();
    expect(out.trim()).toBe('0');
  });

  it('common-dir prints absolute path ending in .git', () => {
    const out = execFileSync(process.execPath, [
      SCRIPT,
      'common-dir',
      '--project-root',
      tmpRoot,
    ]).toString();
    expect(out.trim().endsWith('.git')).toBe(true);
  });

  it('common-dir exits 1 on non-repo', () => {
    const nonRepo = mkdtempSync(join(tmpdir(), 'sp-non-repo-'));
    try {
      const res = spawnSync(
        process.execPath,
        [SCRIPT, 'common-dir', '--project-root', nonRepo],
        { encoding: 'utf8' },
      );
      expect(res.status).toBe(1);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it('safe-add emits JSON summary', () => {
    writeFileSync(join(tmpRoot, 'present.txt'), 'p');
    const out = execFileSync(process.execPath, [
      SCRIPT,
      'safe-add',
      'present.txt',
      'absent.txt',
      '--project-root',
      tmpRoot,
    ]).toString();
    const parsed = JSON.parse(out);
    expect(parsed.added).toEqual(['present.txt']);
    expect(parsed.skipped).toEqual(['absent.txt']);
  });
});
