/**
 * End-to-end v1 → v2 migration test.
 * Simulates a bmad-autopilot-addon v1 layout and verifies `sprintpilot install`
 * cleanly replaces it without silent data loss.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from './helpers/run.js';

const V1_ADDON = '_bmad-addons';
const V2_ADDON = '_Sprintpilot';
const V1_MANIFEST = `addon:\n  name: bmad-ma-git\n  version: 1.0.21\n`;

let dir: string;

function makeBmadCore(root: string) {
  mkdirSync(join(root, '_bmad/_config'), { recursive: true });
  writeFileSync(join(root, '_bmad/_config/manifest.yaml'), 'bmad:\n  version: "6.2.0"\n');
  mkdirSync(join(root, '_bmad/bmm'), { recursive: true });
  writeFileSync(join(root, '_bmad/bmm/config.yaml'), 'project:\n  name: v1-migration-test\n');
}

function seedV1(
  root: string,
  opts: { withUserGitConfig?: boolean; withUserTemplates?: boolean } = {},
) {
  const v1 = join(root, V1_ADDON);
  mkdirSync(join(v1, 'modules/git/templates'), { recursive: true });
  mkdirSync(join(v1, 'modules/ma'), { recursive: true });
  mkdirSync(join(v1, 'modules/autopilot'), { recursive: true });
  mkdirSync(join(v1, 'skills/bmad-autopilot-on'), { recursive: true });
  mkdirSync(join(v1, 'skills/bmad-ma-code-review'), { recursive: true });
  writeFileSync(join(v1, 'manifest.yaml'), V1_MANIFEST);

  const userGitYaml = opts.withUserGitConfig
    ? "git:\n  enabled: true\n  base_branch: develop  # user-edited\n  branch_prefix: 'custom-story/'\n"
    : 'git:\n  enabled: true\n';
  writeFileSync(join(v1, 'modules/git/config.yaml'), userGitYaml);
  writeFileSync(
    join(v1, 'modules/ma/config.yaml'),
    'multi_agent:\n  enabled: true\n  max_parallel_analysis: 7  # user-edited\n',
  );
  writeFileSync(
    join(v1, 'modules/autopilot/config.yaml'),
    'autopilot:\n  session_story_limit: 5  # user-edited\n',
  );

  if (opts.withUserTemplates) {
    // Simulate user-customized templates — the snapshot must preserve these.
    writeFileSync(
      join(v1, 'modules/git/templates/commit-story.txt'),
      'feat({epic}): {story-title} [USER-CUSTOMIZED]\n',
    );
    writeFileSync(
      join(v1, 'modules/git/templates/pr-body.md'),
      '# USER CUSTOM PR TEMPLATE\n\nStory: {story-key}\n',
    );
  }

  // Seed a stale v1 skill dir inside .claude/skills/ to verify eviction
  mkdirSync(join(root, '.claude/skills/bmad-autopilot-on'), { recursive: true });
  writeFileSync(join(root, '.claude/skills/bmad-autopilot-on/SKILL.md'), 'legacy\n');

  // Seed AGENTS.md with the legacy marker block + surrounding user content
  writeFileSync(
    join(root, 'AGENTS.md'),
    [
      '# Project instructions',
      '',
      'Some user prose the migration must preserve.',
      '',
      '<!-- BEGIN:bmad-workflow-rules -->',
      '# legacy BMAD rules',
      'old content',
      '<!-- END:bmad-workflow-rules -->',
      '',
      '# Trailing section',
      'More user content.',
      '',
    ].join('\n'),
  );
}

describe('v1 → v2 migration', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sp-v1-mig-'));
    makeBmadCore(dir);
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it('--yes without --migrate-v1 aborts fast when v1 is detected (does not silently destroy)', () => {
    seedV1(dir);
    const r = runCli(['install', '--tools', 'claude-code', '--yes'], {
      cwd: dir,
      env: { BMAD_PROJECT_ROOT: dir },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/v1 install detected but --migrate-v1 was not passed/);
    // v1 dir must still exist — install refused to touch it
    expect(existsSync(join(dir, V1_ADDON))).toBe(true);
    expect(existsSync(join(dir, V2_ADDON))).toBe(false);
  });

  it('--migrate-v1 --yes preserves user config values (the critical P1 case)', () => {
    seedV1(dir, { withUserGitConfig: true });

    const r = runCli(['install', '--tools', 'claude-code', '--yes', '--migrate-v1'], {
      cwd: dir,
      env: { BMAD_PROJECT_ROOT: dir },
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);

    // v1 removed, v2 created
    expect(existsSync(join(dir, V1_ADDON))).toBe(false);
    expect(existsSync(join(dir, V2_ADDON))).toBe(true);

    // User's edited values survived. The CRITICAL guarantee this test
    // enforces: step 6's `copyDirWithSubstitution` (which overwrites) must
    // NOT clobber the carried v1 values.
    const gitCfg = readFileSync(join(dir, V2_ADDON, 'modules/git/config.yaml'), 'utf8');
    expect(gitCfg).toContain('base_branch: develop  # user-edited');
    expect(gitCfg).toContain("branch_prefix: 'custom-story/'");

    const maCfg = readFileSync(join(dir, V2_ADDON, 'modules/ma/config.yaml'), 'utf8');
    expect(maCfg).toContain('max_parallel_analysis: 7  # user-edited');

    const apCfg = readFileSync(join(dir, V2_ADDON, 'modules/autopilot/config.yaml'), 'utf8');
    expect(apCfg).toContain('session_story_limit: 5  # user-edited');

    // Manifest is v2
    const manifest = readFileSync(join(dir, V2_ADDON, 'manifest.yaml'), 'utf8');
    expect(manifest).toContain('name: sprintpilot');

    // v1-named skill dir was evicted from .claude/skills/
    expect(existsSync(join(dir, '.claude/skills/bmad-autopilot-on'))).toBe(false);
    // v2 skill dirs are present
    expect(existsSync(join(dir, '.claude/skills/sprint-autopilot-on'))).toBe(true);

    // AGENTS.md: legacy block stripped, a backup exists, user prose preserved
    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    expect(agents).not.toContain('<!-- BEGIN:bmad-workflow-rules -->');
    expect(agents).not.toContain('old content');
    expect(agents).toContain('Some user prose the migration must preserve.');
    expect(agents).toContain('More user content.');
    // v2 block was upserted into AGENTS.md
    expect(agents).toContain('<!-- BEGIN:sprintpilot-rules -->');
    // Backup of the pre-migration AGENTS.md was written
    expect(existsSync(join(dir, 'AGENTS.md.bak-sprintpilot-migration'))).toBe(true);
  });

  it('snapshot preserves user-customized templates, not just config.yaml (P13)', () => {
    seedV1(dir, { withUserTemplates: true });

    const r = runCli(['install', '--tools', 'claude-code', '--yes', '--migrate-v1'], {
      cwd: dir,
      env: { BMAD_PROJECT_ROOT: dir },
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);

    // The user-customized template files survived the migration.
    const commitStory = readFileSync(
      join(dir, V2_ADDON, 'modules/git/templates/commit-story.txt'),
      'utf8',
    );
    expect(commitStory).toContain('[USER-CUSTOMIZED]');

    const prBody = readFileSync(join(dir, V2_ADDON, 'modules/git/templates/pr-body.md'), 'utf8');
    expect(prBody).toContain('USER CUSTOM PR TEMPLATE');
  });

  it('repeated migration does not clobber the pristine backup (P14)', () => {
    seedV1(dir);
    // First migration.
    const r1 = runCli(['install', '--tools', 'claude-code', '--yes', '--migrate-v1'], {
      cwd: dir,
      env: { BMAD_PROJECT_ROOT: dir },
    });
    expect(r1.status, r1.stdout + r1.stderr).toBe(0);
    const pristineBackup = readFileSync(join(dir, 'AGENTS.md.bak-sprintpilot-migration'), 'utf8');
    expect(pristineBackup).toContain('Some user prose the migration must preserve.');
    expect(pristineBackup).toContain('<!-- BEGIN:bmad-workflow-rules -->');

    // Seed a fresh (different) v1 state and re-migrate.
    seedV1(dir);
    writeFileSync(
      join(dir, 'AGENTS.md'),
      [
        '# Different user prose',
        '<!-- BEGIN:bmad-workflow-rules -->',
        'different legacy',
        '<!-- END:bmad-workflow-rules -->',
        '',
      ].join('\n'),
    );
    const r2 = runCli(['install', '--tools', 'claude-code', '--yes', '--migrate-v1'], {
      cwd: dir,
      env: { BMAD_PROJECT_ROOT: dir },
    });
    expect(r2.status, r2.stdout + r2.stderr).toBe(0);

    // The original pristine backup content is STILL there unchanged.
    const stillPristine = readFileSync(join(dir, 'AGENTS.md.bak-sprintpilot-migration'), 'utf8');
    expect(stillPristine).toBe(pristineBackup);

    // The second-run backup went to a timestamped path.
    const { readdirSync } = require('node:fs');
    const entries = readdirSync(dir) as string[];
    const timestamped = entries.filter((f) => /^AGENTS\.md\.bak-sprintpilot-migration-/.test(f));
    expect(timestamped.length).toBe(1);
  });

  it('non-TTY stdin without --migrate-v1/--yes fails with actionable error (P16)', () => {
    seedV1(dir);
    const r = runCli(['install'], {
      cwd: dir,
      env: { BMAD_PROJECT_ROOT: dir },
      // stdio: pipe → stdin is not a TTY
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/stdin is not a TTY/i);
    expect(existsSync(join(dir, V1_ADDON))).toBe(true);
    expect(existsSync(join(dir, V2_ADDON))).toBe(false);
  });

  it('ambiguous v1: manifest names a different addon, skill dirs look v1 — refuses without --migrate-v1 (P17)', () => {
    seedV1(dir);
    writeFileSync(
      join(dir, V1_ADDON, 'manifest.yaml'),
      'addon:\n  name: some-other-addon\n  version: 0.1.0\n',
    );
    const r = runCli(['install', '--tools', 'claude-code', '--yes'], {
      cwd: dir,
      env: { BMAD_PROJECT_ROOT: dir },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/ambiguous v1 signature/i);
    expect(existsSync(join(dir, V1_ADDON))).toBe(true);
  });

  it('adds *.bak-sprintpilot-migration AND .sprintpilot-v1-snapshot*.json to .gitignore (P18, P21)', () => {
    seedV1(dir);
    const r = runCli(['install', '--tools', 'claude-code', '--yes', '--migrate-v1'], {
      cwd: dir,
      env: { BMAD_PROJECT_ROOT: dir },
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const gitignore = readFileSync(join(dir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('*.bak-sprintpilot-migration');
    expect(gitignore).toContain('.sprintpilot-v1-snapshot*.json');
  });

  it('gitignore entries are added even when v1 has no modules/ but only legacy markers (P20)', () => {
    // v1 with manifest + skill dirs but no modules/ — exercises the
    // legacy-markers-only code path where the snapshot is empty but
    // AGENTS.md still gets backed up.
    const v1 = join(dir, V1_ADDON);
    mkdirSync(join(v1, 'skills/bmad-autopilot-on'), { recursive: true });
    writeFileSync(join(v1, 'manifest.yaml'), V1_MANIFEST);
    writeFileSync(
      join(dir, 'AGENTS.md'),
      [
        '# Instructions',
        '<!-- BEGIN:bmad-workflow-rules -->',
        'legacy',
        '<!-- END:bmad-workflow-rules -->',
      ].join('\n'),
    );

    const r = runCli(['install', '--tools', 'claude-code', '--yes', '--migrate-v1'], {
      cwd: dir,
      env: { BMAD_PROJECT_ROOT: dir },
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);

    // Backup file created for AGENTS.md
    expect(existsSync(join(dir, 'AGENTS.md.bak-sprintpilot-migration'))).toBe(true);
    // .gitignore has the backup pattern even though there were no modules to snapshot
    const gitignore = readFileSync(join(dir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('*.bak-sprintpilot-migration');
  });

  it('user-global ~/.claude/skills/ is NOT touched (cross-project safety)', () => {
    seedV1(dir);

    // Fake HOME pointing to a directory with an unrelated bmad-* custom skill.
    // Verify the installer leaves it alone (scope: projectRoot only).
    const fakeHome = mkdtempSync(join(tmpdir(), 'sp-home-'));
    const userSkillsDir = join(fakeHome, '.claude/skills/bmad-autopilot-on');
    mkdirSync(userSkillsDir, { recursive: true });
    writeFileSync(join(userSkillsDir, 'SKILL.md'), 'user-owned\n');

    try {
      const r = runCli(['install', '--tools', 'claude-code', '--yes', '--migrate-v1'], {
        cwd: dir,
        env: { BMAD_PROJECT_ROOT: dir, HOME: fakeHome },
      });
      expect(r.status, r.stdout + r.stderr).toBe(0);

      // The user-level skill dir was NOT removed
      expect(existsSync(userSkillsDir)).toBe(true);
      expect(readFileSync(join(userSkillsDir, 'SKILL.md'), 'utf8')).toBe('user-owned\n');
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
