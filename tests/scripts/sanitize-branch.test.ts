import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, gitIn, type TempRepo } from './helpers/repo.js';
import { runScript } from './helpers/run.js';

describe('sanitize-branch', () => {
  let repo: TempRepo;

  beforeEach(() => {
    repo = createTempRepo();
  });
  afterEach(() => {
    repo.cleanup();
  });

  it('simple story key passes through', () => {
    const r = runScript('sanitize-branch', ['1-3'], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('1-3');
  });

  it('uppercase is lowered', () => {
    const r = runScript('sanitize-branch', ['My-Story'], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('my-story');
  });

  it('spaces become hyphens', () => {
    const r = runScript('sanitize-branch', ['my story key'], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('my-story-key');
  });

  it('special characters are stripped', () => {
    const r = runScript('sanitize-branch', ['feat: add @auth!'], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('feat-add-auth');
  });

  it('ampersands and parens become hyphens', () => {
    const r = runScript('sanitize-branch', ['foo & bar (baz)'], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('foo-bar-baz');
  });

  it('consecutive hyphens are collapsed', () => {
    const r = runScript('sanitize-branch', ['a--b---c'], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('a-b-c');
  });

  it('leading and trailing hyphens are stripped', () => {
    const r = runScript('sanitize-branch', ['-leading-trailing-'], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('leading-trailing');
  });

  it('leading and trailing dots are stripped', () => {
    const r = runScript('sanitize-branch', ['.dotted.'], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('dotted');
  });

  it('long name is truncated with hash', () => {
    const longName =
      'this-is-a-very-long-story-key-that-exceeds-the-sixty-character-limit-for-branch-names';
    const r = runScript('sanitize-branch', [longName], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeLessThanOrEqual(60);
    expect(/-[a-f0-9]{6}$/.test(r.stdout)).toBe(true);
  });

  it('custom max-length is respected', () => {
    const r = runScript('sanitize-branch', ['a-moderately-long-name', '--max-length', '15'], {
      cwd: repo.dir,
    });
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeLessThanOrEqual(15);
  });

  it('empty key after sanitization fails', () => {
    const r = runScript('sanitize-branch', ['!@#$%'], { cwd: repo.dir });
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain('empty branch name');
  });

  it('missing story key fails', () => {
    const r = runScript('sanitize-branch', [], { cwd: repo.dir });
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain('story key required');
  });

  it('custom prefix is used for validation', () => {
    const r = runScript('sanitize-branch', ['my-feature', '--prefix', 'feature/'], {
      cwd: repo.dir,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('my-feature');
  });

  it('branch collision appends counter', () => {
    gitIn(repo.dir, ['checkout', '-b', 'story/my-story']);
    gitIn(repo.dir, ['checkout', 'main']);
    const r = runScript('sanitize-branch', ['my-story'], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('my-story-2');
  });

  it('multiple branch collisions increment counter', () => {
    gitIn(repo.dir, ['checkout', '-b', 'story/my-story']);
    gitIn(repo.dir, ['checkout', 'main']);
    gitIn(repo.dir, ['checkout', '-b', 'story/my-story-2']);
    gitIn(repo.dir, ['checkout', 'main']);
    const r = runScript('sanitize-branch', ['my-story'], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('my-story-3');
  });

  it('help flag shows usage', () => {
    const r = runScript('sanitize-branch', ['--help'], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage:');
  });

  it('numeric story key works', () => {
    const r = runScript('sanitize-branch', ['42'], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('42');
  });

  // Regression: max-length below 8 cannot produce a valid truncated name
  // (1 char + '-' + 6-char hash = 8 chars minimum), so it must be rejected.
  it('max-length below 8 is rejected', () => {
    const r = runScript('sanitize-branch', ['long-story-name', '--max-length', '5'], {
      cwd: repo.dir,
    });
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain('--max-length must be at least');
  });

  // Regression: path separators in story keys must not end up in the branch.
  it('slash in story key becomes hyphen', () => {
    const r = runScript('sanitize-branch', ['some/nested/key'], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('some-nested-key');
  });

  // Regression: path-traversal sequences in story keys must not end up in the branch.
  it('dot-dot sequences are collapsed to hyphen', () => {
    const r = runScript('sanitize-branch', ['../escape'], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('..');
    expect(r.stdout).toBe('escape');
  });
});
