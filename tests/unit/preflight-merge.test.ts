import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import preflightMod from '../../_Sprintpilot/scripts/preflight-merge.js';

const { parseEpics, pairs, preflight, PREFLIGHT_BRANCH } = preflightMod as {
  parseEpics: (raw: string | undefined) => { ok: boolean; value?: string[]; error?: string };
  pairs: (arr: string[]) => Array<[string, string]>;
  preflight: (opts: {
    projectRoot: string;
    epics: string[];
    base: string;
    branchPrefix: string;
    lockTimeoutSec: number;
  }) => { safe_pairs: Array<[string, string]>; conflict_pairs: Array<[string, string]>; checked: number };
  PREFLIGHT_BRANCH: string;
};

const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, '_Sprintpilot', 'scripts', 'preflight-merge.js');

let tmpRoot = '';

function git(cwd: string, args: string[]) {
  const res = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(res.stderr || '').trim()}`);
  }
  return (res.stdout || '').trim();
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sp-pm-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 't@t']);
  git(root, ['config', 'user.name', 't']);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  git(root, ['add', 'base.txt']);
  git(root, ['commit', '-q', '-m', 'base']);
  return root;
}

function addEpicBranch(root: string, epicId: string, filename: string, contents: string) {
  git(root, ['checkout', '-q', 'main']);
  git(root, ['checkout', '-q', '-b', `story/epic-${epicId}`]);
  writeFileSync(join(root, filename), contents);
  git(root, ['add', filename]);
  git(root, ['commit', '-q', '-m', `epic-${epicId}`]);
  git(root, ['checkout', '-q', 'main']);
}

beforeEach(() => {
  tmpRoot = '';
});
afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

describe('parseEpics', () => {
  it('accepts 2+ comma-separated epic ids', () => {
    expect(parseEpics('1,2').ok).toBe(true);
    expect(parseEpics('1,2,3').value).toEqual(['1', '2', '3']);
  });
  it('rejects single-epic input (no pair possible)', () => {
    expect(parseEpics('1').ok).toBe(false);
  });
  it('rejects path-traversal ids', () => {
    expect(parseEpics('1,../etc').ok).toBe(false);
  });
});

describe('pairs', () => {
  it('emits every distinct pair (i < j)', () => {
    expect(pairs(['a', 'b', 'c'])).toEqual([
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'c'],
    ]);
  });
});

describe('preflight — safe vs conflict pairs', () => {
  it('independent epics land in safe_pairs', () => {
    tmpRoot = initRepo();
    addEpicBranch(tmpRoot, '1', 'a.txt', 'epic-1 content\n');
    addEpicBranch(tmpRoot, '2', 'b.txt', 'epic-2 content\n');
    const r = preflight({
      projectRoot: tmpRoot,
      epics: ['1', '2'],
      base: 'main',
      branchPrefix: 'story/',
      lockTimeoutSec: 5,
    });
    expect(r.safe_pairs).toEqual([['1', '2']]);
    expect(r.conflict_pairs).toEqual([]);
  });

  it('overlapping-file epics land in conflict_pairs', () => {
    tmpRoot = initRepo();
    // Both epics edit base.txt with different contents → conflict on merge.
    git(tmpRoot, ['checkout', '-q', '-b', 'story/epic-1']);
    appendFileSync(join(tmpRoot, 'base.txt'), 'from epic-1\n');
    git(tmpRoot, ['add', 'base.txt']);
    git(tmpRoot, ['commit', '-q', '-m', 'epic-1 edit']);
    git(tmpRoot, ['checkout', '-q', 'main']);
    git(tmpRoot, ['checkout', '-q', '-b', 'story/epic-2']);
    appendFileSync(join(tmpRoot, 'base.txt'), 'from epic-2 (different line)\n');
    git(tmpRoot, ['add', 'base.txt']);
    git(tmpRoot, ['commit', '-q', '-m', 'epic-2 edit']);
    git(tmpRoot, ['checkout', '-q', 'main']);

    const r = preflight({
      projectRoot: tmpRoot,
      epics: ['1', '2'],
      base: 'main',
      branchPrefix: 'story/',
      lockTimeoutSec: 5,
    });
    expect(r.conflict_pairs).toEqual([['1', '2']]);
    expect(r.safe_pairs).toEqual([]);
  });

  it('cleans up the preflight branch after each pair', () => {
    tmpRoot = initRepo();
    addEpicBranch(tmpRoot, '1', 'a.txt', 'epic-1\n');
    addEpicBranch(tmpRoot, '2', 'b.txt', 'epic-2\n');
    preflight({
      projectRoot: tmpRoot,
      epics: ['1', '2'],
      base: 'main',
      branchPrefix: 'story/',
      lockTimeoutSec: 5,
    });
    const branches = git(tmpRoot, ['branch', '--list', PREFLIGHT_BRANCH]);
    expect(branches).toBe('');
  });

  it('mixed layer correctly separates safe from conflict pairs', () => {
    tmpRoot = initRepo();
    addEpicBranch(tmpRoot, '1', 'a.txt', 'epic-1\n');
    addEpicBranch(tmpRoot, '2', 'b.txt', 'epic-2\n');
    // epic-3 conflicts with epic-1 by editing base.txt.
    git(tmpRoot, ['checkout', '-q', '-b', 'story/epic-3']);
    writeFileSync(join(tmpRoot, 'base.txt'), 'epic-3 overwrites\n');
    git(tmpRoot, ['add', 'base.txt']);
    git(tmpRoot, ['commit', '-q', '-m', 'epic-3']);
    git(tmpRoot, ['checkout', '-q', 'main']);
    // epic-1 also touches base.txt by appending.
    git(tmpRoot, ['checkout', '-q', 'story/epic-1']);
    appendFileSync(join(tmpRoot, 'base.txt'), 'epic-1 appends\n');
    git(tmpRoot, ['add', 'base.txt']);
    git(tmpRoot, ['commit', '-q', '-m', 'epic-1 touch']);
    git(tmpRoot, ['checkout', '-q', 'main']);

    const r = preflight({
      projectRoot: tmpRoot,
      epics: ['1', '2', '3'],
      base: 'main',
      branchPrefix: 'story/',
      lockTimeoutSec: 5,
    });
    expect(r.checked).toBe(3);
    expect(r.conflict_pairs.some(([a, b]) => (a === '1' && b === '3') || (a === '3' && b === '1'))).toBe(true);
    expect(r.safe_pairs.some(([a, b]) => (a === '1' && b === '2') || (a === '2' && b === '3'))).toBe(true);
  });
});

describe('CLI integration', () => {
  it('rejects single-epic input with exit 1', () => {
    const res = spawnSync(process.execPath, [SCRIPT, '--epics', '1', '--base', 'main']);
    expect(res.status).toBe(1);
  });

  it('rejects missing --base', () => {
    const res = spawnSync(process.execPath, [SCRIPT, '--epics', '1,2']);
    expect(res.status).toBe(1);
  });

  it('emits JSON on a real repo', () => {
    tmpRoot = initRepo();
    addEpicBranch(tmpRoot, '1', 'a.txt', 'epic-1\n');
    addEpicBranch(tmpRoot, '2', 'b.txt', 'epic-2\n');
    const out = execFileSync(process.execPath, [
      SCRIPT,
      '--epics',
      '1,2',
      '--base',
      'main',
      '--branch-prefix',
      'story/',
      '--project-root',
      tmpRoot,
    ]).toString();
    const parsed = JSON.parse(out);
    expect(parsed.safe_pairs).toEqual([['1', '2']]);
  });
});
