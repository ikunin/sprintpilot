/**
 * End-to-end test: v2.x → v2.x upgrade preserves user-edited configs.
 *
 * Mirrors the v1-migration.test.ts pattern but for the (much commoner)
 * case of upgrading from one v2 release to another. The bug this guards
 * against is the v2.1.0 regression where the installer's step-6 copy
 * loop nuked _Sprintpilot/modules/ wholesale.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from './helpers/run.js';

const V2_ADDON = '_Sprintpilot';

let dir: string;

function makeBmadCore(root: string) {
  mkdirSync(join(root, '_bmad/_config'), { recursive: true });
  writeFileSync(join(root, '_bmad/_config/manifest.yaml'), 'bmad:\n  version: "6.2.0"\n');
  mkdirSync(join(root, '_bmad/bmm'), { recursive: true });
  writeFileSync(join(root, '_bmad/bmm/config.yaml'), 'project:\n  name: v2-upgrade-test\n');
}

function freshInstall() {
  return runCli(['install', '--tools', 'claude-code', '--yes'], {
    cwd: dir,
    env: { BMAD_PROJECT_ROOT: dir },
  });
}

describe('v2.x → v2.x upgrade preserves user configs', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sp-v2-upgrade-'));
    makeBmadCore(dir);
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it('user-edited modules/git/config.yaml scalar survives a re-install', () => {
    // Step 1: fresh install.
    expect(freshInstall().status).toBe(0);
    const gitCfgPath = join(dir, V2_ADDON, 'modules/git/config.yaml');
    expect(existsSync(gitCfgPath)).toBe(true);

    // Step 2: user customizes a scalar. Change merge_strategy from default
    // 'stacked' to 'land_as_you_go'.
    const original = readFileSync(gitCfgPath, 'utf8');
    expect(original).toContain('merge_strategy: stacked');
    const edited = original.replace('merge_strategy: stacked', 'merge_strategy: land_as_you_go');
    writeFileSync(gitCfgPath, edited);

    // Step 3: re-install (simulating an upgrade).
    const r = freshInstall();
    expect(r.status, r.stdout + r.stderr).toBe(0);

    // Step 4: user's edit must survive.
    const after = readFileSync(gitCfgPath, 'utf8');
    expect(after).toContain('merge_strategy: land_as_you_go');

    // Bundled comments above the changed line must survive too.
    expect(after).toContain('# Merge strategy.');
    expect(after).toContain('#   stacked');

    // Other bundled defaults the user did not touch are still at their bundled values.
    expect(after).toContain('enabled: true');
    expect(after).toContain('base_branch: main');
  });

  it('user-edited .secrets-allowlist survives + bundled written as .bundled sidecar', () => {
    expect(freshInstall().status).toBe(0);
    const allowlist = join(dir, V2_ADDON, '.secrets-allowlist');
    writeFileSync(allowlist, '# user-customized allowlist\n**/my-special-fixture/**\n');

    const r = freshInstall();
    expect(r.status, r.stdout + r.stderr).toBe(0);

    const after = readFileSync(allowlist, 'utf8');
    expect(after).toContain('user-customized allowlist');
    expect(after).toContain('my-special-fixture');

    // The bundled version was written as a sidecar so the user can diff.
    const sidecar = `${allowlist}.bundled`;
    expect(existsSync(sidecar)).toBe(true);
    // Sidecar contains the bundled defaults (e.g. the comment header from
    // the shipped allowlist).
    const sidecarText = readFileSync(sidecar, 'utf8');
    expect(sidecarText.length).toBeGreaterThan(0);
    expect(sidecarText).not.toContain('user-customized allowlist');
  });

  it('user-edited templates/pr-body.md survives + bundled sidecar', () => {
    expect(freshInstall().status).toBe(0);
    const prBody = join(dir, V2_ADDON, 'modules/git/templates/pr-body.md');
    writeFileSync(prBody, '# CUSTOM PR TEMPLATE\n\nStory: {story-key}\n');

    const r = freshInstall();
    expect(r.status, r.stdout + r.stderr).toBe(0);

    const after = readFileSync(prBody, 'utf8');
    expect(after).toContain('CUSTOM PR TEMPLATE');

    const sidecar = `${prBody}.bundled`;
    expect(existsSync(sidecar)).toBe(true);
  });

  it('a user file that matches bundled exactly does not produce a .bundled sidecar', () => {
    expect(freshInstall().status).toBe(0);
    // Re-install without touching anything: user file == bundled. No
    // sidecar should appear.
    const r = freshInstall();
    expect(r.status, r.stdout + r.stderr).toBe(0);

    const sidecar = join(dir, V2_ADDON, '.secrets-allowlist.bundled');
    expect(existsSync(sidecar)).toBe(false);
  });

  it('leftover .bak-sprintpilot-migration files trigger the recovery banner', () => {
    expect(freshInstall().status).toBe(0);
    // Plant a leftover backup file at the project root.
    writeFileSync(join(dir, 'AGENTS.md.bak-sprintpilot-migration'), 'snapshot from prior install');

    const r = freshInstall();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('leftover config snapshots');
    expect(r.stdout).toContain('AGENTS.md.bak-sprintpilot-migration');
  });
});
