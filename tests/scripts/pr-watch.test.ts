import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runScript } from './helpers/run.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sp-pr-watch-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('pr-watch (end-to-end)', () => {
  it('git_only platform exits 2 with degraded payload', () => {
    const r = runScript(
      'pr-watch',
      ['--platform', 'git_only', '--pr', '1', '--timeout', '5'],
      { cwd: dir },
    );
    expect(r.status).toBe(2);
    const payload = JSON.parse(r.stdout);
    expect(payload.skipped).toContain('git_only');
    expect(payload.state).toBe('unknown');
  });

  it('missing --pr exits 1', () => {
    const r = runScript('pr-watch', ['--platform', 'github', '--timeout', '5'], { cwd: dir });
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain('--pr is required');
  });

  it('missing --platform exits 1', () => {
    const r = runScript('pr-watch', ['--pr', '1'], { cwd: dir });
    expect(r.status).toBe(1);
  });

  it('rejects non-positive --timeout', () => {
    const r = runScript(
      'pr-watch',
      ['--platform', 'github', '--pr', '1', '--timeout', '0'],
      { cwd: dir },
    );
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain('--timeout');
  });

  it('rejects non-positive --interval', () => {
    const r = runScript(
      'pr-watch',
      ['--platform', 'github', '--pr', '1', '--timeout', '5', '--interval', '0'],
      { cwd: dir },
    );
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain('--interval');
  });
});
