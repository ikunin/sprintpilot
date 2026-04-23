import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import dispatchMod from '../../_Sprintpilot/scripts/dispatch-layer.js';

const { parseLayer, planLayer, writePlan, PLAN_FILENAME } = dispatchMod as {
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
  };
  writePlan: (root: string, plan: unknown) => string;
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
    const p2 = planLayer({
      keys: ['a', 'b', 'c', 'd', 'e'],
      maxParallel: 2,
      projectRoot: tmpRoot,
      branchPrefix: 'story/',
      baseBranch: 'main',
    });
    expect(p2.effective_parallel).toBe(2); // max wins
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
