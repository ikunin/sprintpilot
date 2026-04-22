import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, '_Sprintpilot', 'scripts', 'sync-status.js');

let tmpDir = '';
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sp-sync-'));
});
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = '';
});

function run(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

describe('sync-status.js — PR 5 granularity + epic-id', () => {
  it('story granularity is the default and omits epic_id field when not provided', () => {
    const statusFile = join(tmpDir, 'git-status.yaml');
    const res = run([
      '--story',
      '1-1-a',
      '--git-status-file',
      statusFile,
      '--branch',
      'story/1-1-a',
      '--push-status',
      'pushed',
    ]);
    expect(res.status).toBe(0);
    const body = readFileSync(statusFile, 'utf8');
    expect(body).toContain('1-1-a:');
    expect(body).toContain('branch: story/1-1-a');
    expect(body).not.toContain('epic_id:');
    expect(body).not.toContain('granularity:');
  });

  it('granularity=epic + --epic-id records both fields on the story block', () => {
    const statusFile = join(tmpDir, 'git-status.yaml');
    execFileSync(process.execPath, [
      SCRIPT,
      '--story',
      '1-1-a',
      '--git-status-file',
      statusFile,
      '--branch',
      'story/epic-1',
      '--push-status',
      'deferred',
      '--granularity',
      'epic',
      '--epic-id',
      '1',
    ]);
    execFileSync(process.execPath, [
      SCRIPT,
      '--story',
      '1-2-b',
      '--git-status-file',
      statusFile,
      '--branch',
      'story/epic-1',
      '--push-status',
      'pushed',
      '--granularity',
      'epic',
      '--epic-id',
      '1',
    ]);
    const body = readFileSync(statusFile, 'utf8');
    // Both stories share the epic branch and carry epic_id=1.
    expect((body.match(/branch: story\/epic-1/g) || []).length).toBe(2);
    expect((body.match(/epic_id: 1/g) || []).length).toBe(2);
    expect((body.match(/granularity: epic/g) || []).length).toBe(2);
  });

  it('rejects invalid --granularity', () => {
    const statusFile = join(tmpDir, 'git-status.yaml');
    const res = run([
      '--story',
      '1-1-a',
      '--git-status-file',
      statusFile,
      '--granularity',
      'bogus',
    ]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/invalid --granularity/);
  });
});
