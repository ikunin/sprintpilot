#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { Command } = require('commander');

const pkg = require('../package.json');
const { runInstall } = require('../lib/commands/install');
const { runUninstall } = require('../lib/commands/uninstall');
const { runCheckUpdate } = require('../lib/commands/check-update');
const { readAddonManifestVersion } = require('../lib/core/bmad-config');

async function resolveVersion() {
  const packageRoot = path.resolve(__dirname, '..');
  const projectManifest = path.join(process.cwd(), '_bmad-addons', 'manifest.yaml');
  const packageManifest = path.join(packageRoot, '_bmad-addons', 'manifest.yaml');
  try {
    const fs = require('fs-extra');
    if (await fs.pathExists(projectManifest)) {
      const v = await readAddonManifestVersion(projectManifest);
      if (v) return v;
    }
    const v = await readAddonManifestVersion(packageManifest);
    if (v) return v;
  } catch {
    // fall through
  }
  return pkg.version;
}

function bail(err) {
  if (err && err.stack) {
    console.error(err.stack);
  } else if (err) {
    console.error(String(err));
  }
  process.exit(typeof err?.exitCode === 'number' ? err.exitCode : 1);
}

async function main() {
  const program = new Command();

  program
    .name('bmad-autopilot-addon')
    .description('BMAD Autopilot Add-On — autonomous story execution, multi-agent skills, git workflow')
    .version(await resolveVersion(), '-v, --version', 'Show version');

  program
    .command('install', { isDefault: true })
    .description('Install add-on into current BMAD project')
    .option('--tools <list>', 'Comma-separated tools (claude-code,cursor,windsurf,cline,roo,trae,kiro,gemini-cli,github-copilot,all)')
    .option('--dry-run', 'Preview without making changes')
    .option('--force', 'Skip backup of existing skills')
    .option('-y, --yes', 'Non-interactive mode')
    .action(async (options) => {
      try {
        await runInstall(options);
      } catch (err) {
        bail(err);
      }
    });

  program
    .command('uninstall')
    .description('Remove add-on from current project')
    .option('--force', 'Remove dirty worktrees without prompting')
    .action(async (options) => {
      try {
        await runUninstall(options);
      } catch (err) {
        bail(err);
      }
    });

  program
    .command('check-update')
    .description('Check if a newer version is available on npm')
    .action(async () => {
      try {
        await runCheckUpdate();
      } catch (err) {
        bail(err);
      }
    });

  program
    .command('help')
    .description('Show help')
    .action(() => program.help({ error: false }));

  await program.parseAsync(process.argv);
}

main().catch(bail);
