import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runScript } from './helpers/run.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sp-stack-snap-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeFixture(filename: string, content: object): string {
  const p = path.join(dir, filename);
  writeFileSync(p, JSON.stringify(content));
  return p;
}

describe('stack-snapshot (end-to-end)', () => {
  it('writes a healthy snapshot when fixture has clean green PRs', () => {
    const prsFile = writeFixture('prs.json', {
      platform: 'github',
      prs: [
        {
          number: 1,
          sourceBranch: 'story/1-1',
          targetBranch: 'main',
          mergeStateStatus: 'CLEAN',
        },
        {
          number: 2,
          sourceBranch: 'story/1-2',
          targetBranch: 'story/1-1',
          mergeStateStatus: 'CLEAN',
        },
      ],
    });
    const checksFile = writeFixture('checks.json', { '1': 'success', '2': 'success' });
    const gitStatus = path.join(dir, 'git-status.yaml');

    const r = runScript(
      'stack-snapshot',
      [
        '--platform',
        'github',
        '--branch-prefix',
        'story/',
        '--base-branch',
        'main',
        '--git-status-file',
        gitStatus,
        '--prs-from-file',
        prsFile,
        '--checks-from-file',
        checksFile,
      ],
      { cwd: dir },
    );

    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.snapshot.depth).toBe(2);
    expect(payload.snapshot.ci_all_green).toBe(true);
    expect(payload.snapshot.recommendation).toMatch(/land-stack/);

    const yamlBody = readFileSync(gitStatus, 'utf8');
    expect(yamlBody).toMatch(/^stack:/m);
    expect(yamlBody).toMatch(/depth: 2/);
    expect(yamlBody).toMatch(/ci_all_green: true/);
  });

  it('flags conflicts_at_base when any PR is DIRTY', () => {
    const prsFile = writeFixture('prs.json', {
      platform: 'github',
      prs: [
        {
          number: 1,
          sourceBranch: 'story/1-1',
          targetBranch: 'main',
          mergeStateStatus: 'DIRTY',
        },
      ],
    });
    const checksFile = writeFixture('checks.json', { '1': 'success' });
    const gitStatus = path.join(dir, 'git-status.yaml');

    const r = runScript(
      'stack-snapshot',
      [
        '--platform',
        'github',
        '--git-status-file',
        gitStatus,
        '--prs-from-file',
        prsFile,
        '--checks-from-file',
        checksFile,
      ],
      { cwd: dir },
    );
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.snapshot.conflicts_at_base).toBe(true);
    expect(payload.snapshot.recommendation).toMatch(/resolve-docs/);
  });

  it('git_only platform exits 2 with degraded snapshot', () => {
    const gitStatus = path.join(dir, 'git-status.yaml');
    const r = runScript(
      'stack-snapshot',
      ['--platform', 'git_only', '--git-status-file', gitStatus],
      { cwd: dir },
    );
    expect(r.status).toBe(2);
    const payload = JSON.parse(r.stdout);
    expect(payload.snapshot.degraded).toContain('git_only');
    expect(payload.snapshot.depth).toBe(0);
  });

  it('--dry-run does not write to disk', () => {
    const prsFile = writeFixture('prs.json', {
      platform: 'github',
      prs: [
        { number: 1, sourceBranch: 'story/1-1', targetBranch: 'main', mergeStateStatus: 'CLEAN' },
      ],
    });
    const checksFile = writeFixture('checks.json', { '1': 'success' });
    const gitStatus = path.join(dir, 'git-status.yaml');

    const r = runScript(
      'stack-snapshot',
      [
        '--platform',
        'github',
        '--git-status-file',
        gitStatus,
        '--prs-from-file',
        prsFile,
        '--checks-from-file',
        checksFile,
        '--dry-run',
      ],
      { cwd: dir },
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).wrote).toBe(null);
    expect(() => readFileSync(gitStatus, 'utf8')).toThrow();
  });

  it('replaces an existing stack: block on re-run', () => {
    const gitStatus = path.join(dir, 'git-status.yaml');
    writeFileSync(
      gitStatus,
      [
        '# Sprintpilot — Git Status',
        'stories:',
        '  1-1:',
        '    branch: story/1-1',
        '',
        'stack:',
        '  depth: 99',
        '  base_branch: stale',
        '',
      ].join('\n'),
    );
    const prsFile = writeFixture('prs.json', {
      platform: 'github',
      prs: [{ number: 1, sourceBranch: 'story/1-1', targetBranch: 'main', mergeStateStatus: 'CLEAN' }],
    });
    const checksFile = writeFixture('checks.json', { '1': 'success' });

    const r = runScript(
      'stack-snapshot',
      [
        '--platform',
        'github',
        '--git-status-file',
        gitStatus,
        '--prs-from-file',
        prsFile,
        '--checks-from-file',
        checksFile,
      ],
      { cwd: dir },
    );
    expect(r.status).toBe(0);

    const yamlBody = readFileSync(gitStatus, 'utf8');
    // Stale stale data must be gone; new depth must be present.
    expect(yamlBody).not.toContain('depth: 99');
    expect(yamlBody).not.toContain('base_branch: stale');
    expect(yamlBody).toMatch(/depth: 1/);
    expect(yamlBody).toMatch(/base_branch: main/);
    // The pre-existing stories: block must be preserved.
    expect(yamlBody).toMatch(/stories:\n {2}1-1:\n {4}branch: story\/1-1/);
  });
});
