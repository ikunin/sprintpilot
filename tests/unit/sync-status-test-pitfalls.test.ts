import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, '_Sprintpilot', 'scripts', 'sync-status.js');

let tmpDir = '';
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sp-sync-pitfalls-'));
});
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = '';
});

describe('sync-status.js — --test-pitfalls field', () => {
  it('writes test_pitfalls to the story block when provided', () => {
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
      '--test-pitfalls',
      '2 finding(s): {js-ts: 1, python: 1}',
    ]);
    const body = readFileSync(statusFile, 'utf8');
    // The colon, comma, and braces in the value force YAML quoting via yamlSafe.
    expect(body).toContain('test_pitfalls: "2 finding(s): {js-ts: 1, python: 1}"');
  });

  it('omits the field entirely when --test-pitfalls is not passed', () => {
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
    expect(body).not.toContain('test_pitfalls:');
  });

  it('round-trips a "clean" summary when no findings', () => {
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
      '--test-pitfalls',
      'clean',
    ]);
    const body = readFileSync(statusFile, 'utf8');
    expect(body).toContain('test_pitfalls: clean');
  });
});
