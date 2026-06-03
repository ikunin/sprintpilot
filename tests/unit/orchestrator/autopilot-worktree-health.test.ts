import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import autopilot from '../../../_Sprintpilot/bin/autopilot.js';
// @ts-expect-error — CommonJS module
import profileRules from '../../../_Sprintpilot/lib/orchestrator/profile-rules.js';

const { runWorktreeHealthCheck } = autopilot as {
  runWorktreeHealthCheck: (
    profile: Record<string, unknown>,
    projectRoot: string,
  ) => {
    ok: boolean;
    skipped?: boolean;
    reason?: string;
    summary?: Record<string, number>;
    orphans?: string[];
    prompt?: string;
  };
};

const { flatToProfile } = profileRules as {
  flatToProfile: (resolved: unknown, name: string) => Record<string, unknown>;
};

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

let tmp: string;

function setupProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'autopilot-wt-health-'));
  // Stage health-check.js + its runtime deps.
  mkdirSync(join(root, '_Sprintpilot', 'scripts'), { recursive: true });
  mkdirSync(join(root, '_Sprintpilot', 'lib', 'runtime'), { recursive: true });
  for (const f of ['health-check.js']) {
    cpSync(join(REPO_ROOT, '_Sprintpilot', 'scripts', f), join(root, '_Sprintpilot', 'scripts', f));
  }
  for (const f of ['args.js', 'log.js', 'git.js', 'yaml-lite.js', 'spawn.js']) {
    cpSync(
      join(REPO_ROOT, '_Sprintpilot', 'lib', 'runtime', f),
      join(root, '_Sprintpilot', 'lib', 'runtime', f),
    );
  }
  // Init a git repo so health-check's `git fetch` / `rev-parse` don't blow up.
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: root });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init', '-q'], { cwd: root });
  return root;
}

beforeEach(() => {
  tmp = setupProject();
});

afterEach(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

describe('runWorktreeHealthCheck', () => {
  it('skips when health_check_on_boot=false', () => {
    const profile = { ...flatToProfile({}, 'medium'), worktree_health_check_on_boot: false };
    const r = runWorktreeHealthCheck(profile, tmp);
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('disabled');
  });

  it('skips when worktree_enabled=false', () => {
    const profile = { ...flatToProfile({}, 'medium'), worktree_enabled: false };
    const r = runWorktreeHealthCheck(profile, tmp);
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('worktrees_disabled');
  });

  it('skips when .worktrees/ does not exist', () => {
    const r = runWorktreeHealthCheck(flatToProfile({}, 'medium'), tmp);
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('no_worktrees_dir');
  });

  it('skips when health-check.js is missing (partial install)', () => {
    rmSync(join(tmp, '_Sprintpilot', 'scripts', 'health-check.js'));
    mkdirSync(join(tmp, '.worktrees'));
    const r = runWorktreeHealthCheck(flatToProfile({}, 'medium'), tmp);
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('script_missing');
  });

  it('proceeds OK when worktrees dir is empty', () => {
    mkdirSync(join(tmp, '.worktrees'));
    const r = runWorktreeHealthCheck(flatToProfile({}, 'medium'), tmp);
    expect(r.ok).toBe(true);
    expect(r.summary).toEqual({
      total: 0,
      clean_done: 0,
      committed: 0,
      stale: 0,
      dirty: 0,
      orphan: 0,
    });
  });

  it('halts when an orphan worktree directory exists (broken .git file)', () => {
    // A directory under .worktrees/ with a .git FILE that points to a
    // non-existent worktree gitdir — health-check classifies as ORPHAN
    // (git -C <dir> rev-parse --git-dir fails). This is the shape a real
    // crashed `git worktree add` leaves behind.
    const wt = join(tmp, '.worktrees', 'story-crashed');
    mkdirSync(wt, { recursive: true });
    // A broken .git pointer file. Real worktrees have e.g. `gitdir: .../worktrees/story-crashed`.
    require('node:fs').writeFileSync(
      join(wt, '.git'),
      `gitdir: ${join(tmp, '.git', 'worktrees', 'nonexistent')}\n`,
    );
    const r = runWorktreeHealthCheck(flatToProfile({}, 'medium'), tmp);
    expect(r.ok).toBe(false);
    expect(r.summary?.orphan).toBe(1);
    expect(r.orphans).toContain('story-crashed');
    expect(r.prompt).toMatch(/orphaned worktree/);
    expect(r.prompt).toMatch(/git worktree prune/);
  });
});
