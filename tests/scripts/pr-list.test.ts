import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, gitIn, type TempRepo } from './helpers/repo.js';
import { runScript } from './helpers/run.js';

describe('pr-list', () => {
  let repo: TempRepo;

  beforeEach(() => {
    repo = createTempRepo();
  });
  afterEach(() => {
    repo.cleanup();
  });

  it('git_only platform exits 2 with empty prs', () => {
    gitIn(repo.dir, ['remote', 'add', 'origin', 'https://example.com/repo.git']);
    const r = runScript('pr-list', ['--platform', 'git_only'], { cwd: repo.dir });
    expect(r.status).toBe(2);
    const payload = JSON.parse(r.stdout);
    expect(payload.platform).toBe('git_only');
    expect(payload.prs).toEqual([]);
  });

  it('missing --platform exits 1', () => {
    const r = runScript('pr-list', [], { cwd: repo.dir });
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain("unknown or missing --platform");
  });

  it('unknown platform exits 1', () => {
    const r = runScript('pr-list', ['--platform', 'hgweb'], { cwd: repo.dir });
    expect(r.status).toBe(1);
  });
});
