import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runScript } from './helpers/run.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sp-resolve-enum-'));
  // Stand up a minimal Sprintpilot project layout — resolve-profile.js
  // walks _Sprintpilot/modules/autopilot/profiles/ and config.yaml.
  const profilesDir = path.join(dir, '_Sprintpilot', 'modules', 'autopilot', 'profiles');
  mkdirSync(profilesDir, { recursive: true });
  writeFileSync(
    path.join(dir, '_Sprintpilot', 'modules', 'autopilot', 'config.yaml'),
    'autopilot:\n  complexity_profile: medium\n  merge_strategy: land_as_you_go\n  custom_value: surprising\n',
  );
  writeFileSync(path.join(profilesDir, '_base.yaml'), 'name: _base\n');
  for (const p of ['nano', 'small', 'medium', 'large', 'legacy']) {
    writeFileSync(
      path.join(profilesDir, `${p}.yaml`),
      `name: ${p}\n${p === 'legacy' ? 'version_pinned: 1.0.5\n' : ''}`,
    );
  }
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolve-profile.js get --enum / --default', () => {
  it('returns the configured value when it matches the enum', () => {
    const r = runScript(
      'resolve-profile',
      ['get', '--default', 'manual', '--enum', 'manual,land_as_you_go', 'autopilot.merge_strategy'],
      { cwd: dir },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('land_as_you_go');
  });

  it('falls back to --default when value is not in the enum', () => {
    const r = runScript(
      'resolve-profile',
      [
        'get',
        '--default',
        'safe-default',
        '--enum',
        'safe-default,other',
        'autopilot.custom_value',
      ],
      { cwd: dir },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('safe-default');
    // The warning was emitted to stderr.
    expect(r.stderr).toMatch(/not in allowed set/);
    expect(r.stderr).toMatch(/falling back/);
  });

  it('errors out when value is not in enum AND no --default is set', () => {
    const r = runScript(
      'resolve-profile',
      ['get', '--enum', 'allowed-only', 'autopilot.custom_value'],
      { cwd: dir },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not in allowed set/);
  });

  it('returns --default when key is missing from config', () => {
    const r = runScript(
      'resolve-profile',
      ['get', '--default', 'fallback', 'autopilot.does_not_exist'],
      { cwd: dir },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('fallback');
  });

  it('preserves prior behavior when neither --default nor --enum is given', () => {
    const r = runScript('resolve-profile', ['get', 'autopilot.merge_strategy'], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('land_as_you_go');
  });

  it('errors out when key is missing AND no --default is given (existing behavior)', () => {
    const r = runScript('resolve-profile', ['get', 'autopilot.does_not_exist'], { cwd: dir });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/key not found/);
  });
});
