import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import dispatchMod from '../../_Sprintpilot/scripts/dispatch-layer.js';

const { parseLayer, planLayer, writePlan, dispatch, PLAN_FILENAME } = dispatchMod as {
  parseLayer: (raw: string | undefined) => { ok: boolean; value?: string[]; error?: string };
  planLayer: (opts: {
    keys: string[];
    maxParallel: number;
    projectRoot: string;
    branchPrefix: string;
    baseBranch: string;
  }) => {
    version: number;
    effective_parallel: number;
    max_parallel: number;
    stories: Array<{ story: string; worktree: string; branch: string; base_branch: string }>;
    deferred: string[];
  };
  writePlan: (root: string, plan: unknown) => string;
  dispatch: (opts: {
    keys: string[];
    maxParallel: number;
    projectRoot: string;
    branchPrefix: string;
    baseBranch: string;
    dryRun?: boolean;
  }) => {
    plan_file: string | null;
    effective_parallel: number;
    stories: Array<{
      story: string;
      worktree: string;
      branch: string;
      created: boolean;
      retried: boolean;
      stderr: string;
      rolled_back?: boolean;
    }>;
    deferred: string[];
    dry_run: boolean;
  };
  PLAN_FILENAME: string;
};

const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, '_Sprintpilot', 'scripts', 'dispatch-layer.js');

let tmpRoot = '';
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sp-dispatch-'));
});
afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

describe('parseLayer', () => {
  it('accepts comma-separated story keys', () => {
    const r = parseLayer('1-1-a,1-2-b,1-3-c');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual(['1-1-a', '1-2-b', '1-3-c']);
  });

  it('rejects empty input', () => {
    expect(parseLayer(undefined).ok).toBe(false);
    expect(parseLayer('').ok).toBe(false);
    expect(parseLayer(',,,').ok).toBe(false);
  });

  it('rejects path-traversal story keys', () => {
    const r = parseLayer('1-1-a,../etc/passwd');
    expect(r.ok).toBe(false);
  });
});

describe('planLayer', () => {
  it('caps effective_parallel at len(layer) and at max_parallel', () => {
    const p1 = planLayer({
      keys: ['a', 'b', 'c'],
      maxParallel: 5,
      projectRoot: tmpRoot,
      branchPrefix: 'story/',
      baseBranch: 'main',
    });
    expect(p1.effective_parallel).toBe(3); // len wins
    expect(p1.stories.length).toBe(3); // all dispatched
    expect(p1.deferred).toEqual([]);

    const p2 = planLayer({
      keys: ['a', 'b', 'c', 'd', 'e'],
      maxParallel: 2,
      projectRoot: tmpRoot,
      branchPrefix: 'story/',
      baseBranch: 'main',
    });
    expect(p2.effective_parallel).toBe(2); // max wins
    // CAP enforcement: only 2 stories dispatched; remaining 3 deferred
    // for the next loop iteration. Pre-2.0.8 the cap was a lie — all 5
    // were dispatched and the workflow spawned 5 sub-agents anyway.
    expect(p2.stories.length).toBe(2);
    expect(p2.stories.map((s) => s.story)).toEqual(['a', 'b']);
    expect(p2.deferred).toEqual(['c', 'd', 'e']);
  });

  it('dedupes duplicate keys before slicing to the cap', () => {
    // A duplicated key would otherwise produce two entries pointing at
    // the same worktree path and same branch — racing on the rename.
    const plan = planLayer({
      keys: ['a', 'b', 'a', 'c'],
      maxParallel: 5,
      projectRoot: tmpRoot,
      branchPrefix: 'story/',
      baseBranch: 'main',
    });
    expect(plan.stories.map((s) => s.story)).toEqual(['a', 'b', 'c']);
    expect(plan.effective_parallel).toBe(3);
  });

  it('builds per-story worktree + branch metadata', () => {
    const plan = planLayer({
      keys: ['1-1-a', '1-2-b'],
      maxParallel: 2,
      projectRoot: tmpRoot,
      branchPrefix: 'story/',
      baseBranch: 'main',
    });
    expect(plan.stories[0]).toEqual({
      story: '1-1-a',
      worktree: join(tmpRoot, '.worktrees', '1-1-a'),
      branch: 'story/1-1-a',
      base_branch: 'main',
    });
  });
});

describe('writePlan', () => {
  it('writes the plan atomically to .layer-plan.json', () => {
    const plan = { version: 1, stories: [] };
    const file = writePlan(tmpRoot, plan);
    expect(file.endsWith(PLAN_FILENAME)).toBe(true);
    const body = JSON.parse(readFileSync(file, 'utf8'));
    expect(body).toEqual(plan);
  });
});

describe('CLI integration (dry-run)', () => {
  it('dry-run reports the plan without creating worktrees', () => {
    const out = execFileSync(process.execPath, [
      SCRIPT,
      '--layer',
      '1-1-a,1-2-b',
      '--max-parallel',
      '2',
      '--dry-run',
      '--project-root',
      tmpRoot,
    ]).toString();
    const parsed = JSON.parse(out);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.stories.length).toBe(2);
    expect(existsSync(join(tmpRoot, '.worktrees', '1-1-a'))).toBe(false);
  });

  it('rejects bad --layer input with exit 1', () => {
    const res = spawnSync(process.execPath, [
      SCRIPT,
      '--layer',
      '../etc/passwd',
      '--dry-run',
      '--project-root',
      tmpRoot,
    ]);
    expect(res.status).toBe(1);
  });

  it('rejects --max-parallel 0', () => {
    const res = spawnSync(process.execPath, [
      SCRIPT,
      '--layer',
      '1-1-a',
      '--max-parallel',
      '0',
      '--dry-run',
      '--project-root',
      tmpRoot,
    ]);
    expect(res.status).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────
// Real-git integration tests for D1/D2/D3 fixes
// ──────────────────────────────────────────────────────────────────

function initGitRepo(root: string): void {
  // Suppress global git config so the test isn't subject to the
  // user's commit.gpgsign / user.signingkey / etc.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' };
  spawnSync('git', ['-C', root, 'init', '--initial-branch=main'], { env });
  spawnSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'], { env });
  spawnSync('git', ['-C', root, 'config', 'user.name', 'Test'], { env });
  spawnSync('git', ['-C', root, 'commit', '--allow-empty', '-m', 'init'], { env });
}

describe('dispatch — real git integration', () => {
  it('caps stories array to effective_parallel; remaining keys are deferred', () => {
    initGitRepo(tmpRoot);
    const r = dispatch({
      keys: ['a', 'b', 'c', 'd'],
      maxParallel: 2,
      projectRoot: tmpRoot,
      branchPrefix: 'story/',
      baseBranch: 'main',
    });
    // Only 2 worktrees actually created on disk.
    expect(r.stories.filter((s) => s.created).length).toBe(2);
    expect(existsSync(join(tmpRoot, '.worktrees', 'a'))).toBe(true);
    expect(existsSync(join(tmpRoot, '.worktrees', 'b'))).toBe(true);
    expect(existsSync(join(tmpRoot, '.worktrees', 'c'))).toBe(false);
    expect(existsSync(join(tmpRoot, '.worktrees', 'd'))).toBe(false);
    expect(r.deferred).toEqual(['c', 'd']);
    expect(r.effective_parallel).toBe(2);
  });

  it('disables gc.auto on each created worktree', () => {
    initGitRepo(tmpRoot);
    dispatch({
      keys: ['x'],
      maxParallel: 1,
      projectRoot: tmpRoot,
      branchPrefix: 'story/',
      baseBranch: 'main',
    });
    const worktree = join(tmpRoot, '.worktrees', 'x');
    expect(existsSync(worktree)).toBe(true);
    const r = spawnSync('git', ['-C', worktree, 'config', '--local', 'gc.auto'], {
      encoding: 'utf8',
    });
    expect(r.stdout?.trim()).toBe('0');
  });

  it('rolls back successful worktrees when a later create fails', () => {
    initGitRepo(tmpRoot);
    // Pre-create a worktree at the path the third dispatch will want,
    // forcing failure on story c. Successful stories a, b should be
    // rolled back so we don't leave orphan worktrees.
    spawnSync('git', ['-C', tmpRoot, 'worktree', 'add', join(tmpRoot, '.worktrees', 'c'), '-b', 'pre-existing-c', 'main']);
    expect(existsSync(join(tmpRoot, '.worktrees', 'c'))).toBe(true);

    const r = dispatch({
      keys: ['a', 'b', 'c'],
      maxParallel: 3,
      projectRoot: tmpRoot,
      branchPrefix: 'story/',
      baseBranch: 'main',
    });
    // story c failed (path conflict, branch doesn't already exist by
    // that name → no retry). Stories a and b succeeded then got rolled back.
    expect(r.plan_file).toBeNull(); // no plan written on partial failure
    const aResult = r.stories.find((s) => s.story === 'a');
    const bResult = r.stories.find((s) => s.story === 'b');
    const cResult = r.stories.find((s) => s.story === 'c');
    expect(aResult?.rolled_back).toBe(true);
    expect(bResult?.rolled_back).toBe(true);
    expect(cResult?.created).toBe(false);
    // Filesystem: a and b worktrees are gone; c still exists (pre-existing).
    expect(existsSync(join(tmpRoot, '.worktrees', 'a'))).toBe(false);
    expect(existsSync(join(tmpRoot, '.worktrees', 'b'))).toBe(false);
    expect(existsSync(join(tmpRoot, '.worktrees', 'c'))).toBe(true);
  });

  it('retries without -b ONLY when the branch already exists', () => {
    initGitRepo(tmpRoot);
    // Pre-create the branch (but no worktree on it).
    spawnSync('git', ['-C', tmpRoot, 'branch', 'story/x', 'main']);

    const r = dispatch({
      keys: ['x'],
      maxParallel: 1,
      projectRoot: tmpRoot,
      branchPrefix: 'story/',
      baseBranch: 'main',
    });
    // First attempt fails ("a branch named 'story/x' already exists").
    // Bare retry succeeds (checks out existing branch in the worktree).
    const xResult = r.stories.find((s) => s.story === 'x');
    expect(xResult?.created).toBe(true);
    expect(xResult?.retried).toBe(true);
    expect(existsSync(join(tmpRoot, '.worktrees', 'x'))).toBe(true);
  });

  it('does NOT retry when first failure is unrelated to "branch already exists"', () => {
    initGitRepo(tmpRoot);
    // Pre-create a directory at the worktree path → causes "already
    // exists" path error (NOT a branch error). The fix should propagate
    // this without the bare retry — pre-2.0.8 the bare retry would have
    // attempted to check out the branch into the same path again and
    // produced misleading errors.
    const wt = join(tmpRoot, '.worktrees', 'y');
    spawnSync('mkdir', ['-p', wt]);
    spawnSync('sh', ['-c', `echo content > ${join(wt, 'placeholder.txt')}`]);

    const r = dispatch({
      keys: ['y'],
      maxParallel: 1,
      projectRoot: tmpRoot,
      branchPrefix: 'story/',
      baseBranch: 'main',
    });
    const yResult = r.stories.find((s) => s.story === 'y');
    expect(yResult?.created).toBe(false);
    expect(yResult?.retried).toBe(false); // no bare retry — the error wasn't a branch-conflict
  });
});
