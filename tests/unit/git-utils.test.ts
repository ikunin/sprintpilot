import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getLatestStoryBranch,
  readSprintStoryKeys,
} from '../e2e/harness/git-utils.js';

let tmpRoot = '';

function git(args: string[]): void {
  execFileSync('git', ['-C', tmpRoot, ...args], { encoding: 'utf-8', timeout: 10_000 });
}

/** Commit sprint-status.yaml to main so it survives branch switches. */
function seedSprintStatus(content: string): void {
  const dir = join(tmpRoot, '_bmad-output', 'implementation-artifacts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sprint-status.yaml'), content);
  git(['add', '-A']);
  git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'seed sprint-status']);
}

function makeBranchWithCommit(branch: string): void {
  // Create the branch from current HEAD and add a commit so it can be sorted.
  // Use a marker file in a unique subdir per branch so add -A doesn't sweep
  // up files from earlier iterations.
  git(['checkout', '-b', branch]);
  const marker = join(tmpRoot, `markers-${branch.replace(/\//g, '_')}`, 'm.txt');
  mkdirSync(join(tmpRoot, `markers-${branch.replace(/\//g, '_')}`), { recursive: true });
  writeFileSync(marker, branch);
  git(['add', marker]);
  git(['-c', 'commit.gpgsign=false', 'commit', '-m', `branch ${branch}`]);
  git(['checkout', 'main']);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sp-git-utils-'));
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

describe('readSprintStoryKeys', () => {
  it('extracts keys from canonical development_status block', () => {
    seedSprintStatus(`
development_status:
  1-1-foo:
    status: ready-for-dev
  1-2-bar:
    status: backlog
  2-1-baz:
    status: backlog
`);
    expect(readSprintStoryKeys(tmpRoot)).toEqual(new Set(['1-1-foo', '1-2-bar', '2-1-baz']));
  });

  it('extracts inline-form keys (key: status)', () => {
    seedSprintStatus(`development_status:\n  1-1-foo: done\n  1-2-bar: ready-for-dev\n`);
    expect(readSprintStoryKeys(tmpRoot)).toEqual(new Set(['1-1-foo', '1-2-bar']));
  });

  it('extracts list-form keys (- id: <key>)', () => {
    seedSprintStatus(`development_status:\n  - id: "1-1-foo"\n    status: ready-for-dev\n  - id: "1-2-bar"\n    status: backlog\n`);
    expect(readSprintStoryKeys(tmpRoot)).toEqual(new Set(['1-1-foo', '1-2-bar']));
  });

  it('extracts from alternate `stories:` block', () => {
    seedSprintStatus(`stories:\n  1-1: ready-for-dev\n`);
    expect(readSprintStoryKeys(tmpRoot)).toEqual(new Set(['1-1']));
  });

  it('returns empty set when sprint-status missing', () => {
    expect(readSprintStoryKeys(tmpRoot)).toEqual(new Set());
  });
});

describe('getLatestStoryBranch', () => {
  it('returns the only matching branch when there is one', () => {
    seedSprintStatus(`development_status:\n  1-1-foo:\n    status: ready-for-dev\n`);
    makeBranchWithCommit('story/1-1-foo');
    expect(getLatestStoryBranch(tmpRoot)).toBe('story/1-1-foo');
  });

  it('IGNORES leftover branches not in current sprint-status (the harness bug fix)', () => {
    // Simulate what we observed in the wild: prior runs left
    // story/1-2-cli-interface-and-game-flow on the local repo with a
    // very recent commit. This sprint's story-status only mentions
    // sudoku stories; the leftover must NOT win the sort.
    seedSprintStatus(`development_status:\n  2-1-board-renderer:\n    status: ready-for-dev\n  2-2-input-handler:\n    status: backlog\n`);
    makeBranchWithCommit('story/1-2-cli-interface-and-game-flow'); // older
    makeBranchWithCommit('story/2-1-board-renderer'); // current sprint
    // Leftover from a prior run, latest commit overall
    makeBranchWithCommit('story/1-1-leftover-from-prior-run');

    const result = getLatestStoryBranch(tmpRoot);
    expect(result).toBe('story/2-1-board-renderer');
  });

  it('falls back to accepting any story-prefixed branch when sprint-status is missing', () => {
    // No sprint-status.yaml — early bootstrap, behave as before.
    makeBranchWithCommit('story/1-1-anything');
    const result = getLatestStoryBranch(tmpRoot);
    expect(result).toBe('story/1-1-anything');
  });

  it('returns null when no matching branch exists', () => {
    seedSprintStatus(`development_status:\n  9-9-nonexistent:\n    status: ready-for-dev\n`);
    makeBranchWithCommit('story/1-1-mismatch');
    expect(getLatestStoryBranch(tmpRoot)).toBeNull();
  });

  it('returns null when no branches exist at all', () => {
    seedSprintStatus(`development_status:\n  1-1-foo:\n    status: ready-for-dev\n`);
    expect(getLatestStoryBranch(tmpRoot)).toBeNull();
  });
});
