/**
 * Create and manage temporary project directories for e2e testing.
 * Each test gets an isolated git repo with BMAD installed.
 */

import { execFileSync, execSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ADDON_DIR = join(import.meta.dirname, '../../../_Sprintpilot');

export interface TempProject {
  /** Absolute path to the temporary project directory */
  dir: string;
  /** Absolute path to the bare git remote (if created) */
  remoteDir?: string;
  /** Clean up the temp directory */
  cleanup: () => void;
}

export interface TempProjectOptions {
  /** Whether to create a bare remote for push testing (default: false) */
  withRemote?: boolean;
  /** Use an existing remote URL instead of creating a bare local remote */
  remoteUrl?: string;
  /** Whether to install BMAD core (default: true) */
  installBmadCore?: boolean;
  /** Whether to install the addon (default: true) */
  installAddon?: boolean;
  /** Override git platform provider (default: "git_only") */
  platform?: string;
  /** Preserve directory on failure for debugging (env: BMAD_TEST_KEEP_ON_FAIL) */
  keepOnFail?: boolean;
}

function exec(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 30_000 }).trim();
}

/**
 * Create a fresh temporary project with git init and optional BMAD installation.
 */
export function createTempProject(options: TempProjectOptions = {}): TempProject {
  const {
    withRemote = false,
    remoteUrl,
    installBmadCore = true,
    installAddon = true,
    platform = 'git_only',
  } = options;

  const dir = mkdtempSync(join(tmpdir(), 'bmad-e2e-'));
  let remoteDir: string | undefined;

  // Initialize git repo
  exec('git init --initial-branch=main', dir);
  exec('git config user.email "test@bmad-e2e.com"', dir);
  exec('git config user.name "BMAD E2E Test"', dir);
  exec('git config commit.gpgsign false', dir);
  exec('git commit --allow-empty -m "initial commit"', dir);

  // Set up remote
  if (remoteUrl) {
    // Use a real remote URL (e.g. GitHub)
    exec(`git remote add origin "${remoteUrl}"`, dir);
    exec('git push -u origin main --force', dir);
  } else if (withRemote) {
    // Create a bare local remote for testing
    remoteDir = mkdtempSync(join(tmpdir(), 'bmad-e2e-remote-'));
    exec(`git init --bare "${remoteDir}"`, dir);
    exec(`git remote add origin "${remoteDir}"`, dir);
    exec('git push -u origin main', dir);
  }

  // Install BMAD core structure (minimal)
  if (installBmadCore) {
    const bmadDir = join(dir, '_bmad/bmm');
    mkdirSync(bmadDir, { recursive: true });
    writeFileSync(
      join(bmadDir, 'config.yaml'),
      `# BMAD Config (e2e test)\nproject:\n  name: e2e-test\n`,
    );
    // Create manifest so install.sh recognizes BMAD is present
    const configDir = join(dir, '_bmad/_config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'manifest.yaml'), `bmad:\n  version: "6.2.0"\n`);
  }

  // Install the addon
  if (installAddon && installBmadCore) {
    // Copy _Sprintpilot into the temp project
    const destAddons = join(dir, '_Sprintpilot');
    cpSync(ADDON_DIR, destAddons, { recursive: true });

    const installerCli = join(import.meta.dirname, '../../../bin/sprintpilot.js');
    try {
      execFileSync('node', [installerCli, 'install', '--tools', 'claude-code', '--yes'], {
        cwd: dir,
        encoding: 'utf-8',
        timeout: 30_000,
        stdio: 'pipe',
      });
    } catch {
      const skillsSrc = join(destAddons, 'skills');
      const skillsDest = join(dir, '.claude/skills');
      if (existsSync(skillsSrc)) {
        cpSync(skillsSrc, skillsDest, { recursive: true });
      }
    }

    // Override platform config
    const gitConfig = join(destAddons, 'modules/git/config.yaml');
    if (existsSync(gitConfig)) {
      const content = readFileSync(gitConfig, 'utf-8');
      const updated = content.replace(/provider:\s*auto/, `provider: ${platform}`);
      writeFileSync(gitConfig, updated);
    }
  }

  // Create output directories
  mkdirSync(join(dir, '_bmad-output/planning-artifacts'), { recursive: true });
  mkdirSync(join(dir, '_bmad-output/implementation-artifacts'), {
    recursive: true,
  });
  mkdirSync(join(dir, '_bmad-output/codebase-analysis'), { recursive: true });

  // Create .gitignore
  writeFileSync(join(dir, '.gitignore'), '.autopilot.lock\nnode_modules/\n.worktrees/\n');
  exec("git add .gitignore && git commit -m 'add gitignore'", dir);

  const cleanup = () => {
    const keepOnFail = process.env.BMAD_TEST_KEEP_ON_FAIL === '1';
    if (keepOnFail) {
      console.log(`[BMAD E2E] Preserving temp dir for debugging: ${dir}`);
      return;
    }
    // Clean up worktrees first
    try {
      exec('git worktree prune', dir);
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
    if (remoteDir) {
      rmSync(remoteDir, { recursive: true, force: true });
    }
  };

  return { dir, remoteDir, cleanup };
}

/**
 * Place a fixture file into the temp project.
 */
export function placeFixture(projectDir: string, relativePath: string, content: string): void {
  const fullPath = join(projectDir, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}
