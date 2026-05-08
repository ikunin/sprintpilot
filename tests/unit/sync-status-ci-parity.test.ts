import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, '_Sprintpilot', 'scripts', 'sync-status.js');

let tmpDir = '';
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sp-sync-ci-parity-'));
});
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = '';
});

describe('sync-status.js — --ci-parity-uncertain field', () => {
  it('writes ci_parity_uncertain to the story block when provided', () => {
    const statusFile = join(tmpDir, 'git-status.yaml');
    execFileSync(process.execPath, [
      SCRIPT,
      '--story',
      '1-1-a',
      '--git-status-file',
      statusFile,
      '--branch',
      'story/1-1-a',
      '--push-status',
      'pushed',
      '--ci-parity-uncertain',
      'true',
    ]);
    const body = readFileSync(statusFile, 'utf8');
    // 'true' is a YAML reserved literal that must be quoted to round-trip
    // as a string. yamlSafe handles that.
    expect(body).toContain('ci_parity_uncertain: "true"');
  });

  it('omits the field when not provided', () => {
    const statusFile = join(tmpDir, 'git-status.yaml');
    execFileSync(process.execPath, [
      SCRIPT,
      '--story',
      '1-1-a',
      '--git-status-file',
      statusFile,
      '--branch',
      'story/1-1-a',
      '--push-status',
      'pushed',
    ]);
    const body = readFileSync(statusFile, 'utf8');
    expect(body).not.toContain('ci_parity_uncertain');
  });
});
