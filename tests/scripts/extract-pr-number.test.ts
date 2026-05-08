import { describe, expect, it } from 'vitest';
import { runScript } from './helpers/run.js';

describe('extract-pr-number (end-to-end)', () => {
  it('emits the PR number on stdout for a GitHub URL', () => {
    const r = runScript('extract-pr-number', [
      '--url',
      'https://github.com/owner/repo/pull/42',
      '--platform',
      'github',
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('42');
  });

  it('exits 2 when no PR pattern matches', () => {
    const r = runScript('extract-pr-number', [
      '--url',
      'https://github.com/owner/repo/issues/5',
      '--platform',
      'github',
    ]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/could not extract/);
  });

  it('exits 1 when --url is missing', () => {
    const r = runScript('extract-pr-number', ['--platform', 'github']);
    expect(r.status).toBe(1);
  });

  it('exits 1 for unknown platform', () => {
    const r = runScript('extract-pr-number', [
      '--url',
      'https://example.com/pr/1',
      '--platform',
      'hgweb',
    ]);
    expect(r.status).toBe(1);
  });

  it('rejects git_only platform', () => {
    const r = runScript('extract-pr-number', ['--url', 'x', '--platform', 'git_only']);
    expect(r.status).toBe(1);
  });
});
