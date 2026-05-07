import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// @ts-expect-error — CommonJS module
import installerMod from '../../lib/commands/install-merge-driver';

const {
  installMergeDriver,
  uninstallMergeDriver,
  buildBlock,
  upsertBlock,
  stripBlock,
  hasBlock,
  STATE_FILES,
} = installerMod as {
  installMergeDriver: (root: string, opts?: { dryRun?: boolean; log?: object }) => Promise<unknown>;
  uninstallMergeDriver: (root: string, opts?: { dryRun?: boolean; log?: object }) => Promise<unknown>;
  buildBlock: () => string;
  upsertBlock: (text: string) => string;
  stripBlock: (text: string) => string;
  hasBlock: (text: string) => boolean;
  STATE_FILES: string[];
};

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sp-merge-install-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  // Stage the merge-driver script next to where the installer expects it.
  mkdirSync(path.join(dir, '_Sprintpilot', 'scripts'), { recursive: true });
  writeFileSync(
    path.join(dir, '_Sprintpilot', 'scripts', 'auto-merge-bmad-docs.js'),
    '#!/usr/bin/env node\nprocess.exit(0);\n',
  );
  return dir;
}

const SILENT_LOG = { log: () => {}, warn: () => {} };

describe('buildBlock / upsertBlock / stripBlock', () => {
  it('builds a block with all four state files', () => {
    const block = buildBlock();
    for (const f of STATE_FILES) expect(block).toContain(f);
    expect(block).toMatch(/# BEGIN:sprintpilot-merge-driver/);
    expect(block).toMatch(/# END:sprintpilot-merge-driver/);
  });

  it('upsertBlock is idempotent', () => {
    const once = upsertBlock('# existing\n*.txt text\n');
    const twice = upsertBlock(once);
    expect(twice).toBe(once);
  });

  it('stripBlock removes the block cleanly', () => {
    const before = '# existing\n*.txt text\n';
    const inserted = upsertBlock(before);
    const stripped = stripBlock(inserted).replace(/\s+$/, '');
    expect(stripped).toBe(before.replace(/\s+$/, ''));
  });

  it('hasBlock detects presence', () => {
    expect(hasBlock('# nothing\n')).toBe(false);
    expect(hasBlock(buildBlock())).toBe(true);
  });
});

describe('installMergeDriver / uninstallMergeDriver', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeRepo();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes .gitattributes block and registers git config', async () => {
    await installMergeDriver(dir, { log: SILENT_LOG });
    const ga = readFileSync(path.join(dir, '.gitattributes'), 'utf8');
    expect(ga).toContain('# BEGIN:sprintpilot-merge-driver');
    for (const f of STATE_FILES) expect(ga).toContain(f);
    const driver = execFileSync('git', ['-C', dir, 'config', '--local', 'merge.bmad-doc.driver'], {
      encoding: 'utf8',
    }).trim();
    expect(driver).toContain('auto-merge-bmad-docs.js');
    expect(driver).toContain('%A %O %B %P');
  });

  it('is idempotent on repeat install', async () => {
    await installMergeDriver(dir, { log: SILENT_LOG });
    const first = readFileSync(path.join(dir, '.gitattributes'), 'utf8');
    await installMergeDriver(dir, { log: SILENT_LOG });
    const second = readFileSync(path.join(dir, '.gitattributes'), 'utf8');
    expect(second).toBe(first);
  });

  it('preserves existing .gitattributes content', async () => {
    writeFileSync(path.join(dir, '.gitattributes'), '*.sh text eol=lf\n', 'utf8');
    await installMergeDriver(dir, { log: SILENT_LOG });
    const ga = readFileSync(path.join(dir, '.gitattributes'), 'utf8');
    expect(ga).toContain('*.sh text eol=lf');
    expect(ga).toContain('# BEGIN:sprintpilot-merge-driver');
  });

  it('uninstall strips block and removes git config section', async () => {
    await installMergeDriver(dir, { log: SILENT_LOG });
    await uninstallMergeDriver(dir, { log: SILENT_LOG });
    if (existsSync(path.join(dir, '.gitattributes'))) {
      const ga = readFileSync(path.join(dir, '.gitattributes'), 'utf8');
      expect(ga).not.toContain('# BEGIN:sprintpilot-merge-driver');
    }
    let configError = false;
    try {
      execFileSync('git', ['-C', dir, 'config', '--local', 'merge.bmad-doc.driver'], {
        stdio: 'ignore',
      });
    } catch {
      configError = true;
    }
    expect(configError).toBe(true);
  });

  it('removes .gitattributes when it becomes empty after uninstall', async () => {
    // No prior content, so installing then uninstalling should leave the
    // file removed rather than empty.
    await installMergeDriver(dir, { log: SILENT_LOG });
    await uninstallMergeDriver(dir, { log: SILENT_LOG });
    expect(existsSync(path.join(dir, '.gitattributes'))).toBe(false);
  });

  it('skips git-config registration when no .git dir', async () => {
    const noGitDir = mkdtempSync(path.join(tmpdir(), 'sp-no-git-'));
    mkdirSync(path.join(noGitDir, '_Sprintpilot', 'scripts'), { recursive: true });
    writeFileSync(
      path.join(noGitDir, '_Sprintpilot', 'scripts', 'auto-merge-bmad-docs.js'),
      'x',
    );
    try {
      const result = (await installMergeDriver(noGitDir, { log: SILENT_LOG })) as {
        gitConfig: string;
      };
      expect(result.gitConfig).toBe('skipped');
      // .gitattributes still gets written (so files are tagged for when git
      // is initialized later).
      expect(existsSync(path.join(noGitDir, '.gitattributes'))).toBe(true);
    } finally {
      rmSync(noGitDir, { recursive: true, force: true });
    }
  });

  it('refuses to register driver if script file is missing', async () => {
    const noScriptDir = mkdtempSync(path.join(tmpdir(), 'sp-no-script-'));
    execFileSync('git', ['init', '-q'], { cwd: noScriptDir });
    try {
      const result = (await installMergeDriver(noScriptDir, { log: SILENT_LOG })) as {
        skipped: string;
      };
      expect(result.skipped).toBe('script-missing');
    } finally {
      rmSync(noScriptDir, { recursive: true, force: true });
    }
  });

  it('dry-run does not modify the working tree', async () => {
    await installMergeDriver(dir, { dryRun: true, log: SILENT_LOG });
    expect(existsSync(path.join(dir, '.gitattributes'))).toBe(false);
    let configError = false;
    try {
      execFileSync('git', ['-C', dir, 'config', '--local', 'merge.bmad-doc.driver'], {
        stdio: 'ignore',
      });
    } catch {
      configError = true;
    }
    expect(configError).toBe(true);
  });
});
