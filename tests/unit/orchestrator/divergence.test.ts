import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import divergence from '../../../_Sprintpilot/lib/orchestrator/divergence.js';

const { fingerprint, diff, detect, canonicalizeYaml, sha256 } = divergence as {
  fingerprint: (context: Record<string, unknown>) => Record<string, unknown>;
  diff: (
    expected: Record<string, unknown> | null,
    actual: Record<string, unknown> | null,
  ) => { identical: boolean; differences: Record<string, unknown> };
  detect: (
    context: Record<string, unknown>,
    baseline: Record<string, unknown> | null,
  ) => { identical: boolean; differences: Record<string, unknown> };
  canonicalizeYaml: (text: string) => string;
  sha256: (text: string) => string;
};

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'sp-divergence-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function seedStatus(content: string) {
  const dir = join(projectRoot, '_bmad-output', 'implementation-artifacts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sprint-status.yaml'), content, 'utf8');
}

function seedStory(name: string, body: string) {
  const dir = join(projectRoot, '_bmad-output', 'stories');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body, 'utf8');
}

describe('canonicalizeYaml', () => {
  it('strips trailing whitespace per line and normalizes final newline', () => {
    const a = canonicalizeYaml('foo: bar   \n\n');
    const b = canonicalizeYaml('foo: bar\n');
    expect(a).toBe(b);
  });
});

describe('fingerprint', () => {
  it('hashes sprint-status.yaml when present', () => {
    seedStatus('sprint:\n  story_a: done\n');
    const fp = fingerprint({ projectRoot });
    expect(typeof fp.sprintStatusSha).toBe('string');
    expect(fp.sprintStatusSha).toBe(sha256(canonicalizeYaml('sprint:\n  story_a: done\n')));
  });

  it('returns null sprintStatusSha when file missing', () => {
    const fp = fingerprint({ projectRoot });
    expect(fp.sprintStatusSha).toBeNull();
  });

  it('collects _bmad-output tree (relative paths → sizes)', () => {
    seedStory('a.md', 'hi');
    seedStory('b.md', 'hello');
    const fp = fingerprint({ projectRoot });
    const tree = fp.bmadTree as Record<string, number>;
    expect(tree['stories/a.md']).toBe(2);
    expect(tree['stories/b.md']).toBe(5);
  });

  it('uses injected gitHeadResolver to populate branchHeads', () => {
    const fp = fingerprint({
      projectRoot,
      branches: ['story/S1', 'story/S2'],
      gitHeadResolver: (b: string) => (b === 'story/S1' ? 'sha-1' : 'sha-2'),
    });
    expect(fp.branchHeads).toEqual({ 'story/S1': 'sha-1', 'story/S2': 'sha-2' });
  });

  it('uses injected worktreeScanner', () => {
    const fp = fingerprint({
      projectRoot,
      worktreeScanner: () => ['.worktrees/a', '.worktrees/b'],
    });
    expect(fp.worktreePaths).toEqual(['.worktrees/a', '.worktrees/b']);
  });

  it('requires projectRoot', () => {
    expect(() => fingerprint({})).toThrow();
  });
});

describe('diff', () => {
  it('returns identical=true when fingerprints match', () => {
    const fp = {
      sprintStatusSha: 'x',
      bmadTree: { 'a.md': 1 },
      branchHeads: {},
      worktreePaths: [],
    };
    expect(diff(fp, fp).identical).toBe(true);
  });

  it('reports sprint_status divergence', () => {
    const a = { sprintStatusSha: 'x', bmadTree: {}, branchHeads: {}, worktreePaths: [] };
    const b = { sprintStatusSha: 'y', bmadTree: {}, branchHeads: {}, worktreePaths: [] };
    const r = diff(a, b);
    expect(r.identical).toBe(false);
    expect(r.differences.sprint_status).toEqual({ expected: 'x', actual: 'y' });
  });

  it('reports added/removed/changed bmad files', () => {
    const a = {
      sprintStatusSha: null,
      bmadTree: { 'a.md': 1, 'b.md': 2, 'c.md': 3 },
      branchHeads: {},
      worktreePaths: [],
    };
    const b = {
      sprintStatusSha: null,
      bmadTree: { 'a.md': 1, 'b.md': 99, 'd.md': 4 },
      branchHeads: {},
      worktreePaths: [],
    };
    const r = diff(a, b);
    expect(r.differences.bmad_tree).toEqual({
      added: ['d.md'],
      removed: ['c.md'],
      changed: ['b.md'],
    });
  });

  it('reports branch head divergences', () => {
    const a = {
      sprintStatusSha: null,
      bmadTree: {},
      branchHeads: { 'story/S1': 'aaa' },
      worktreePaths: [],
    };
    const b = {
      sprintStatusSha: null,
      bmadTree: {},
      branchHeads: { 'story/S1': 'bbb' },
      worktreePaths: [],
    };
    const r = diff(a, b);
    expect(r.differences.branch_heads).toEqual([
      { branch: 'story/S1', expected: 'aaa', actual: 'bbb' },
    ]);
  });

  it('reports worktree additions/removals', () => {
    const a = {
      sprintStatusSha: null,
      bmadTree: {},
      branchHeads: {},
      worktreePaths: ['.worktrees/a'],
    };
    const b = {
      sprintStatusSha: null,
      bmadTree: {},
      branchHeads: {},
      worktreePaths: ['.worktrees/b'],
    };
    const r = diff(a, b);
    expect(r.differences.worktrees).toEqual({ added: ['.worktrees/b'], removed: ['.worktrees/a'] });
  });

  it('treats missing baseline as divergent', () => {
    expect(diff(null, { sprintStatusSha: 'x' } as Record<string, unknown>).identical).toBe(false);
  });
});

describe('detect', () => {
  it('composes fingerprint + diff', () => {
    seedStatus('sprint:\n  story_a: done\n');
    const baseline = fingerprint({ projectRoot });
    // No on-disk changes → identical.
    const r = detect({ projectRoot }, baseline);
    expect(r.identical).toBe(true);
  });

  it('detects post-baseline mutation', () => {
    seedStatus('sprint:\n  story_a: done\n');
    const baseline = fingerprint({ projectRoot });
    seedStatus('sprint:\n  story_a: in_progress\n');
    const r = detect({ projectRoot }, baseline);
    expect(r.identical).toBe(false);
    expect(r.differences.sprint_status).toBeDefined();
  });
});
