import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import resolveProfileMod from '../../_Sprintpilot/scripts/resolve-profile.js';

const { resolveProfile, getByDottedKey } = resolveProfileMod as {
  resolveProfile: (
    root: string,
    explicit?: string | null,
  ) => { profile: string; resolved: Record<string, unknown> };
  getByDottedKey: (obj: unknown, key: string) => unknown;
};

const REPO_ROOT = join(__dirname, '..', '..');

let tmpRoot = '';

function seedProjectRoot(profile?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'sp-nano-'));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  const src = join(REPO_ROOT, '_Sprintpilot', 'modules', 'autopilot', 'profiles');
  const dest = join(root, '_Sprintpilot', 'modules', 'autopilot', 'profiles');
  mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(src)) fs.copyFileSync(join(src, f), join(dest, f));
  if (profile) {
    mkdirSync(join(root, '_Sprintpilot', 'modules', 'autopilot'), { recursive: true });
    writeFileSync(
      join(root, '_Sprintpilot', 'modules', 'autopilot', 'config.yaml'),
      `autopilot:\n  complexity_profile: ${profile}\n`,
      'utf8',
    );
  }
  return root;
}

beforeEach(() => {
  tmpRoot = '';
});
afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

describe('PR 4 — nano routing', () => {
  it('nano resolves implementation_flow to quick', () => {
    tmpRoot = seedProjectRoot('nano');
    const { resolved } = resolveProfile(tmpRoot);
    expect(getByDottedKey(resolved, 'autopilot.implementation_flow')).toBe('quick');
  });

  it.each([
    'small',
    'medium',
    'large',
    'legacy',
  ])('non-nano profile %s resolves implementation_flow to full', (profile) => {
    tmpRoot = seedProjectRoot(profile);
    const { resolved } = resolveProfile(tmpRoot);
    expect(getByDottedKey(resolved, 'autopilot.implementation_flow')).toBe('full');
  });

  it('nano profile exposes the escalation safety-net config', () => {
    tmpRoot = seedProjectRoot('nano');
    const { resolved } = resolveProfile(tmpRoot);
    const nano = getByDottedKey(resolved, 'autopilot.nano') as Record<string, unknown> | undefined;
    expect(nano).toBeDefined();
    expect(nano!.fallback_on_tests_fail).toBe(true);
    expect(nano!.fallback_on_quick_dev_high_severity).toBe(true);
    expect(nano!.fallback_target).toBe('small');
  });

  it('non-nano profiles do not expose the nano escalation block', () => {
    tmpRoot = seedProjectRoot('medium');
    const { resolved } = resolveProfile(tmpRoot);
    expect(getByDottedKey(resolved, 'autopilot.nano')).toBeUndefined();
  });

  it('nano profile disables worktrees and sets epic granularity', () => {
    tmpRoot = seedProjectRoot('nano');
    const { resolved } = resolveProfile(tmpRoot);
    expect(getByDottedKey(resolved, 'git.worktree.enabled')).toBe(false);
    expect(getByDottedKey(resolved, 'git.granularity')).toBe('epic');
    expect(getByDottedKey(resolved, 'git.squash_on_merge')).toBe(true);
  });

  it('nano profile sets a bounded session_story_limit and skips retrospectives', () => {
    // Nano previously ran unlimited (0) which exposed the autopilot to
    // context-rot at the tail of long single-session runs — CRITICAL
    // cleanup actions were silently skipped. Nano now caps sessions at
    // 5 stories (quick-dev is cheap, so we can run longer than the 3
    // for full flow) while still forcing a fresh-context handoff.
    tmpRoot = seedProjectRoot('nano');
    const { resolved } = resolveProfile(tmpRoot);
    expect(getByDottedKey(resolved, 'autopilot.session_story_limit')).toBe(5);
    expect(getByDottedKey(resolved, 'autopilot.retrospective_mode')).toBe('skip');
  });
});
