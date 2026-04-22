import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import resolveProfileMod from '../../_Sprintpilot/scripts/resolve-profile.js';

const {
  VALID_PROFILES,
  DEFAULT_PROFILE,
  resolveProfile,
  readConfiguredProfile,
  getByDottedKey,
  deepMerge,
} = resolveProfileMod as {
  VALID_PROFILES: string[];
  DEFAULT_PROFILE: string;
  resolveProfile: (
    projectRoot: string,
    explicit?: string | null,
  ) => {
    profile: string;
    source: string;
    resolved: Record<string, unknown>;
    version_pinned: string | null;
  };
  readConfiguredProfile: (projectRoot: string) => { profile: string; source: string; raw?: string };
  getByDottedKey: (obj: unknown, key: string) => unknown;
  deepMerge: (a: unknown, b: unknown) => unknown;
};

// Shipping profile YAMLs at the repo root — tests point project-root at the
// repo checkout so they exercise the real files, not fixtures.
const REPO_ROOT = join(__dirname, '..', '..');

let tmpRoot: string;

function seedProjectRoot(configContents?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'sp-resolve-profile-'));
  // Copy the repo's profile YAMLs so the tests read real shipping content.
  const profilesSrc = join(REPO_ROOT, '_Sprintpilot', 'modules', 'autopilot', 'profiles');
  const profilesDest = join(root, '_Sprintpilot', 'modules', 'autopilot', 'profiles');
  mkdirSync(profilesDest, { recursive: true });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs');
  for (const entry of fs.readdirSync(profilesSrc)) {
    fs.copyFileSync(join(profilesSrc, entry), join(profilesDest, entry));
  }
  if (configContents !== undefined) {
    const cfgDir = join(root, '_Sprintpilot', 'modules', 'autopilot');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'config.yaml'), configContents, 'utf8');
  }
  return root;
}

beforeEach(() => {
  tmpRoot = '';
});
afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe('VALID_PROFILES', () => {
  it('exposes the five canonical profiles', () => {
    expect(VALID_PROFILES).toEqual(['nano', 'small', 'medium', 'large', 'legacy']);
  });
  it('defaults to medium', () => {
    expect(DEFAULT_PROFILE).toBe('medium');
  });
});

describe('readConfiguredProfile', () => {
  it('defaults to medium when config.yaml is absent', () => {
    tmpRoot = seedProjectRoot();
    const out = readConfiguredProfile(tmpRoot);
    expect(out.profile).toBe('medium');
    expect(out.source).toBe('missing-default');
  });
  it('defaults to medium when key is absent', () => {
    tmpRoot = seedProjectRoot('autopilot:\n  session_story_limit: 3\n');
    const out = readConfiguredProfile(tmpRoot);
    expect(out.profile).toBe('medium');
    expect(out.source).toBe('missing-default');
  });
  it('reads a valid profile', () => {
    tmpRoot = seedProjectRoot('autopilot:\n  complexity_profile: nano\n');
    const out = readConfiguredProfile(tmpRoot);
    expect(out.profile).toBe('nano');
    expect(out.source).toBe('config');
  });
  it('defaults on an invalid value', () => {
    tmpRoot = seedProjectRoot('autopilot:\n  complexity_profile: bogus\n');
    const out = readConfiguredProfile(tmpRoot);
    expect(out.profile).toBe('medium');
    expect(out.source).toBe('invalid');
    expect(out.raw).toBe('bogus');
  });
  it('reads a quoted value', () => {
    tmpRoot = seedProjectRoot('autopilot:\n  complexity_profile: "large"\n');
    const out = readConfiguredProfile(tmpRoot);
    expect(out.profile).toBe('large');
  });
  it('tolerates trailing comments', () => {
    tmpRoot = seedProjectRoot('autopilot:\n  complexity_profile: small  # our choice\n');
    const out = readConfiguredProfile(tmpRoot);
    expect(out.profile).toBe('small');
  });
});

describe('resolveProfile', () => {
  it('resolves nano: implementation_flow=quick, granularity=epic', () => {
    tmpRoot = seedProjectRoot();
    const out = resolveProfile(tmpRoot, 'nano');
    expect(out.profile).toBe('nano');
    expect(getByDottedKey(out.resolved, 'autopilot.implementation_flow')).toBe('quick');
    expect(getByDottedKey(out.resolved, 'git.granularity')).toBe('epic');
    expect(getByDottedKey(out.resolved, 'git.worktree.enabled')).toBe(false);
    expect(getByDottedKey(out.resolved, 'autopilot.retrospective_mode')).toBe('skip');
  });

  it('resolves medium from _base defaults', () => {
    tmpRoot = seedProjectRoot();
    const out = resolveProfile(tmpRoot, 'medium');
    expect(getByDottedKey(out.resolved, 'autopilot.implementation_flow')).toBe('full');
    expect(getByDottedKey(out.resolved, 'git.granularity')).toBe('story');
    expect(getByDottedKey(out.resolved, 'git.worktree.enabled')).toBe(true);
    expect(getByDottedKey(out.resolved, 'ma.parallel_stories')).toBe(false);
  });

  it('resolves large with parallelism defaults on', () => {
    tmpRoot = seedProjectRoot();
    const out = resolveProfile(tmpRoot, 'large');
    expect(getByDottedKey(out.resolved, 'ma.parallel_stories')).toBe(true);
    expect(getByDottedKey(out.resolved, 'ma.max_parallel_stories')).toBe(3);
    expect(getByDottedKey(out.resolved, 'autopilot.retrospective_mode')).toBe('stop');
    expect(getByDottedKey(out.resolved, 'autopilot.conditional_boot_work')).toBe(false);
  });

  it('resolves legacy standalone (no _base overlay)', () => {
    tmpRoot = seedProjectRoot();
    const out = resolveProfile(tmpRoot, 'legacy');
    expect(out.version_pinned).toBe('v1.0.5');
    // Legacy pins coalesce_state_writes: false etc — same as _base defaults
    // for most keys, but the key thing is legacy is self-sufficient.
    expect(getByDottedKey(out.resolved, 'autopilot.phase_timings')).toBe(false);
    expect(getByDottedKey(out.resolved, 'autopilot.coalesce_state_writes')).toBe(false);
  });

  it('honors user overrides in autopilot/config.yaml', () => {
    tmpRoot = seedProjectRoot(
      'autopilot:\n  complexity_profile: medium\n  session_story_limit: 10\n',
    );
    const out = resolveProfile(tmpRoot);
    expect(out.profile).toBe('medium');
    expect(getByDottedKey(out.resolved, 'autopilot.session_story_limit')).toBe(10);
  });

  it('honors user overrides in git/config.yaml', () => {
    tmpRoot = seedProjectRoot('autopilot:\n  complexity_profile: medium\n');
    const gitDir = join(tmpRoot, '_Sprintpilot', 'modules', 'git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(
      join(gitDir, 'config.yaml'),
      'git:\n  granularity: epic\n  worktree:\n    enabled: false\n',
      'utf8',
    );
    const out = resolveProfile(tmpRoot, 'medium');
    expect(getByDottedKey(out.resolved, 'git.granularity')).toBe('epic');
    expect(getByDottedKey(out.resolved, 'git.worktree.enabled')).toBe(false);
  });
});

describe('deepMerge', () => {
  it('merges nested objects', () => {
    const a = { x: { a: 1, b: 2 }, y: 3 };
    const b = { x: { b: 20, c: 30 }, z: 4 };
    expect(deepMerge(a, b)).toEqual({ x: { a: 1, b: 20, c: 30 }, y: 3, z: 4 });
  });

  it('replaces arrays wholesale', () => {
    expect(deepMerge({ x: [1, 2, 3] }, { x: [9] })).toEqual({ x: [9] });
  });

  it('overwrites leaf values', () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it('non-object source replaces target entirely', () => {
    expect(deepMerge({ a: 1 }, 42)).toBe(42);
  });
});

describe('getByDottedKey', () => {
  it('reaches a nested leaf', () => {
    expect(getByDottedKey({ a: { b: { c: 7 } } }, 'a.b.c')).toBe(7);
  });
  it('returns undefined on a missing path', () => {
    expect(getByDottedKey({ a: 1 }, 'a.b.c')).toBeUndefined();
  });
  it('returns undefined when intermediate is a leaf', () => {
    expect(getByDottedKey({ a: 5 }, 'a.b')).toBeUndefined();
  });
});
