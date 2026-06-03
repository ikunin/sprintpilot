import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import resolveProfileMod from '../../_Sprintpilot/scripts/resolve-profile.js';

const { resolveProfile, getByDottedKey } = resolveProfileMod as {
  resolveProfile: (root: string) => { resolved: Record<string, unknown> };
  getByDottedKey: (obj: unknown, key: string) => unknown;
};

const REPO_ROOT = join(__dirname, '..', '..');

function seedProjectRoot(profile: string): string {
  const root = mkdtempSync(join(tmpdir(), 'sp-cbw-'));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  const src = join(REPO_ROOT, '_Sprintpilot', 'modules', 'autopilot', 'profiles');
  const dest = join(root, '_Sprintpilot', 'modules', 'autopilot', 'profiles');
  mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(src)) fs.copyFileSync(join(src, f), join(dest, f));
  mkdirSync(join(root, '_Sprintpilot', 'modules', 'autopilot'), { recursive: true });
  writeFileSync(
    join(root, '_Sprintpilot', 'modules', 'autopilot', 'config.yaml'),
    `autopilot:\n  complexity_profile: ${profile}\n`,
    'utf8',
  );
  return root;
}

let tmpRoot = '';
afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

describe('PR 7 — conditional_boot_work flag per profile', () => {
  it.each([
    ['nano', true],
    ['small', true],
    ['medium', true],
    ['large', false], // compliance profile — always full reconciliation
    ['legacy', false], // pinned pre-v2 behavior
  ])('%s resolves autopilot.conditional_boot_work = %s', (profile, expected) => {
    tmpRoot = seedProjectRoot(profile);
    const { resolved } = resolveProfile(tmpRoot);
    expect(getByDottedKey(resolved, 'autopilot.conditional_boot_work')).toBe(expected);
  });
});
