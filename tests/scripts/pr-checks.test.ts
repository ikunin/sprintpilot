import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, gitIn, type TempRepo } from './helpers/repo.js';
import { runScript } from './helpers/run.js';

describe('pr-checks', () => {
  let repo: TempRepo;

  beforeEach(() => {
    repo = createTempRepo();
  });
  afterEach(() => {
    repo.cleanup();
  });

  it('git_only platform exits 2 with unknown state', () => {
    gitIn(repo.dir, ['remote', 'add', 'origin', 'https://example.com/repo.git']);
    const r = runScript('pr-checks', ['--platform', 'git_only', '--pr', '1'], { cwd: repo.dir });
    expect(r.status).toBe(2);
    const payload = JSON.parse(r.stdout);
    expect(payload.platform).toBe('git_only');
    expect(payload.state).toBe('unknown');
  });

  it('missing --pr (on github) exits 1', () => {
    const r = runScript('pr-checks', ['--platform', 'github'], { cwd: repo.dir });
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain('--pr is required');
  });

  it('missing --platform exits 1', () => {
    const r = runScript('pr-checks', ['--pr', '5'], { cwd: repo.dir });
    expect(r.status).toBe(1);
  });
});
