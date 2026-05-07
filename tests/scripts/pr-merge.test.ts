import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, gitIn, type TempRepo } from './helpers/repo.js';
import { runScript } from './helpers/run.js';

describe('pr-merge', () => {
  let repo: TempRepo;

  beforeEach(() => {
    repo = createTempRepo();
  });
  afterEach(() => {
    repo.cleanup();
  });

  it('git_only platform exits 2', () => {
    gitIn(repo.dir, ['remote', 'add', 'origin', 'https://example.com/repo.git']);
    const r = runScript('pr-merge', ['--platform', 'git_only', '--pr', '1'], { cwd: repo.dir });
    expect(r.status).toBe(2);
    const payload = JSON.parse(r.stdout);
    expect(payload.merged).toBe(false);
    expect(payload.skipped).toContain('git_only');
  });

  it('missing --pr exits 1', () => {
    const r = runScript('pr-merge', ['--platform', 'github'], { cwd: repo.dir });
    expect(r.status).toBe(1);
  });

  it('invalid --method exits 1', () => {
    const r = runScript('pr-merge', ['--platform', 'github', '--pr', '1', '--method', 'destroy'], {
      cwd: repo.dir,
    });
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain('invalid --method');
  });

  it('missing --platform exits 1', () => {
    const r = runScript('pr-merge', ['--pr', '5'], { cwd: repo.dir });
    expect(r.status).toBe(1);
  });
});
