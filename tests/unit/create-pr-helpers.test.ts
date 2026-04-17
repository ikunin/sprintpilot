import { describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS module
import createPrMod from '../../_Sprintpilot/scripts/create-pr.js';

const { parseGitRemote, redactAuth } = createPrMod as {
  parseGitRemote: (url: string) => { host: string; path: string } | null;
  redactAuth: (text: string) => string;
};

describe('parseGitRemote', () => {
  it('parses github SSH shorthand', () => {
    expect(parseGitRemote('git@github.com:owner/repo.git')).toEqual({
      host: 'github.com',
      path: 'owner/repo',
    });
  });

  it('parses github https URL', () => {
    expect(parseGitRemote('https://github.com/owner/repo.git')).toEqual({
      host: 'github.com',
      path: 'owner/repo',
    });
  });

  it('parses GitLab subgroups (path keeps all segments)', () => {
    expect(parseGitRemote('git@gitlab.com:group/subgroup/project.git')).toEqual({
      host: 'gitlab.com',
      path: 'group/subgroup/project',
    });
  });

  it('parses SSH aliases (host contains dash)', () => {
    expect(parseGitRemote('git@github.com-work:org/repo.git')).toEqual({
      host: 'github.com-work',
      path: 'org/repo',
    });
  });

  it('parses ssh:// with port', () => {
    expect(parseGitRemote('ssh://git@gitlab.internal:2222/group/sub/repo.git')).toEqual({
      host: 'gitlab.internal',
      path: 'group/sub/repo',
    });
  });

  it('rejects IPv6 SCP-style input', () => {
    expect(parseGitRemote('git@[::1]:owner/repo')).toBeNull();
  });

  it('rejects non-standard SCP form with colon in path (embedded port)', () => {
    expect(parseGitRemote('user@host:2222:owner/repo')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseGitRemote('')).toBeNull();
  });

  it('strips trailing slash and .git extension', () => {
    expect(parseGitRemote('https://github.com/a/b/').path).toBe('a/b');
    expect(parseGitRemote('https://github.com/a/b.git/').path).toBe('a/b');
  });
});

describe('redactAuth', () => {
  it('redacts Authorization JSON value', () => {
    const out = redactAuth('{"authorization":"Bearer xyz123"}');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('xyz123');
  });

  it('redacts bearer token in free text', () => {
    const out = redactAuth('error: Bearer abcdef123456 is invalid');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('abcdef123456');
  });

  it('redacts token/api_key JSON fields', () => {
    const out = redactAuth('{"token":"t0p53cr3t","api_key":"k3y"}');
    expect(out).not.toContain('t0p53cr3t');
    expect(out).not.toContain('k3y');
  });

  it('passes clean text through unchanged', () => {
    const clean = 'just a regular error message';
    expect(redactAuth(clean)).toBe(clean);
  });

  it('handles empty/undefined input', () => {
    expect(redactAuth('')).toBe('');
    expect(redactAuth(undefined as unknown as string)).toBe(undefined);
  });
});
