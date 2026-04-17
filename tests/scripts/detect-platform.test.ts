import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, gitIn, type TempRepo } from './helpers/repo.js';
import { runScript } from './helpers/run.js';

// Build a PATH containing ONLY symlinks to git + node — nothing else from
// /usr/bin or similar. Needed because CI runners (GitHub Actions) have
// platform CLIs like `gh` in /usr/bin, which would leak into detection and
// break the "no known CLI" test premise.
function makeGitNodeOnlyPath(): { path: string; cleanup: () => void } {
  const which = (cmd: string) => {
    try {
      return execFileSync('which', [cmd], { encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  };
  const gitReal = which('git');
  const nodeReal = which('node');
  const binDir = mkdtempSync(join(tmpdir(), 'gitnode-only-'));
  if (gitReal) symlinkSync(gitReal, join(binDir, 'git'));
  if (nodeReal) symlinkSync(nodeReal, join(binDir, 'node'));
  return {
    path: binDir,
    cleanup: () => {
      try {
        rmSync(binDir, { recursive: true, force: true });
      } catch {
        /* */
      }
    },
  };
}

describe('detect-platform', () => {
  let repo: TempRepo;

  beforeEach(() => {
    repo = createTempRepo();
  });
  afterEach(() => {
    repo.cleanup();
  });

  it('explicit github provider returns github', () => {
    const r = runScript('detect-platform', ['--provider', 'github'], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('github');
  });

  it('explicit gitlab provider returns gitlab', () => {
    const r = runScript('detect-platform', ['--provider', 'gitlab'], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('gitlab');
  });

  it('explicit git_only returns git_only', () => {
    const r = runScript('detect-platform', ['--provider', 'git_only'], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('git_only');
  });

  it('github remote URL detected', () => {
    gitIn(repo.dir, ['remote', 'add', 'origin', 'git@github.com:user/repo.git']);
    const r = runScript('detect-platform', [], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('github');
  });

  it('bitbucket remote URL produces no error', () => {
    gitIn(repo.dir, ['remote', 'add', 'origin', 'git@bitbucket.org:user/repo.git']);
    const r = runScript('detect-platform', ['--provider', 'auto'], { cwd: repo.dir });
    expect(r.status).toBe(0);
    // Output depends on locally installed CLIs; just assert it's one of the known values.
    expect(['github', 'gitlab', 'bitbucket', 'gitea', 'git_only']).toContain(r.stdout);
  });

  it('no remote and no known CLI falls back to git_only', () => {
    const { path, cleanup } = makeGitNodeOnlyPath();
    try {
      const r = runScript('detect-platform', [], {
        cwd: repo.dir,
        env: { PATH: path },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('git_only');
    } finally {
      cleanup();
    }
  });

  it('help flag shows usage', () => {
    const r = runScript('detect-platform', ['--help'], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage:');
  });
});
