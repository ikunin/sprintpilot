import { describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS module
import platformMod from '../../_Sprintpilot/lib/runtime/platform.js';

const {
  parseGitRemote,
  redactAuth,
  isKnownPlatform,
  defaultBaseUrl,
  authHeader,
  PLATFORMS,
  SAFE_SEGMENT,
} = platformMod as {
  parseGitRemote: (url: string) => { host: string; path: string } | null;
  redactAuth: (text: string) => string;
  isKnownPlatform: (p: string) => boolean;
  defaultBaseUrl: (p: string) => string | null;
  authHeader: (p: string) => Record<string, string> | null;
  PLATFORMS: string[];
  SAFE_SEGMENT: RegExp;
};

describe('PLATFORMS / isKnownPlatform', () => {
  it('lists exactly the supported platforms', () => {
    expect(PLATFORMS).toEqual(['github', 'gitlab', 'bitbucket', 'gitea', 'git_only']);
  });

  it('isKnownPlatform recognizes each one', () => {
    for (const p of PLATFORMS) expect(isKnownPlatform(p)).toBe(true);
    expect(isKnownPlatform('hgweb')).toBe(false);
    expect(isKnownPlatform('')).toBe(false);
  });
});

describe('SAFE_SEGMENT', () => {
  it('accepts safe path components', () => {
    expect(SAFE_SEGMENT.test('owner')).toBe(true);
    expect(SAFE_SEGMENT.test('my-repo.v2')).toBe(true);
    expect(SAFE_SEGMENT.test('1234')).toBe(true);
  });

  it('rejects unsafe inputs', () => {
    expect(SAFE_SEGMENT.test('../escape')).toBe(false);
    expect(SAFE_SEGMENT.test('with space')).toBe(false);
    expect(SAFE_SEGMENT.test('with/slash')).toBe(false);
    expect(SAFE_SEGMENT.test('')).toBe(false);
  });
});

describe('parseGitRemote (re-exported from platform)', () => {
  it('parses SSH shorthand', () => {
    expect(parseGitRemote('git@github.com:owner/repo.git')).toEqual({
      host: 'github.com',
      path: 'owner/repo',
    });
  });

  it('parses GitLab subgroup paths', () => {
    expect(parseGitRemote('git@gitlab.com:group/subgroup/project.git')).toEqual({
      host: 'gitlab.com',
      path: 'group/subgroup/project',
    });
  });

  it('parses https URLs', () => {
    expect(parseGitRemote('https://gitea.example.com/owner/repo')).toEqual({
      host: 'gitea.example.com',
      path: 'owner/repo',
    });
  });

  it('returns null for malformed input', () => {
    expect(parseGitRemote('')).toBe(null);
    expect(parseGitRemote('not a url')).toBe(null);
  });
});

describe('redactAuth', () => {
  it('redacts Authorization headers', () => {
    expect(redactAuth('"authorization": "Bearer abc123"')).toContain('[REDACTED]');
    expect(redactAuth('Authorization: Bearer abc123')).toContain('[REDACTED]');
  });

  it('redacts token-like fields', () => {
    expect(redactAuth('"token": "xoxb-secret"')).toContain('[REDACTED]');
    expect(redactAuth('"private_token": "glpat-foo"')).toContain('[REDACTED]');
  });

  it('leaves non-auth text alone', () => {
    expect(redactAuth('hello world')).toBe('hello world');
  });
});

describe('defaultBaseUrl', () => {
  it('returns API base for cloud platforms', () => {
    expect(defaultBaseUrl('github')).toBe('https://api.github.com');
    expect(defaultBaseUrl('gitlab')).toBe('https://gitlab.com/api/v4');
    expect(defaultBaseUrl('bitbucket')).toBe('https://api.bitbucket.org/2.0');
  });

  it('returns null for self-hosted-only platforms', () => {
    expect(defaultBaseUrl('gitea')).toBe(null);
    expect(defaultBaseUrl('git_only')).toBe(null);
  });
});

describe('authHeader', () => {
  it('returns null when token env is not set', () => {
    const cleanEnv = { ...process.env };
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITLAB_TOKEN;
    delete process.env.BITBUCKET_TOKEN;
    delete process.env.GITEA_TOKEN;
    try {
      expect(authHeader('github')).toBe(null);
      expect(authHeader('gitlab')).toBe(null);
      expect(authHeader('bitbucket')).toBe(null);
      expect(authHeader('gitea')).toBe(null);
    } finally {
      process.env = cleanEnv;
    }
  });

  it('builds the correct header per platform when token is set', () => {
    const cleanEnv = { ...process.env };
    process.env.GITHUB_TOKEN = 'gh-xxx';
    process.env.GITLAB_TOKEN = 'glpat-yyy';
    process.env.BITBUCKET_TOKEN = 'bb-zzz';
    process.env.GITEA_TOKEN = 'gitea-www';
    try {
      expect(authHeader('github')).toEqual({ Authorization: 'Bearer gh-xxx' });
      expect(authHeader('gitlab')).toEqual({ 'PRIVATE-TOKEN': 'glpat-yyy' });
      expect(authHeader('bitbucket')).toEqual({ Authorization: 'Bearer bb-zzz' });
      expect(authHeader('gitea')).toEqual({ Authorization: 'token gitea-www' });
    } finally {
      process.env = cleanEnv;
    }
  });
});
