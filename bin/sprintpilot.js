#!/usr/bin/env node

const path = require('node:path');
const { Command } = require('commander');

const pkg = require('../package.json');
const { runInstall } = require('../lib/commands/install');
const { runUninstall } = require('../lib/commands/uninstall');
const { runCheckUpdate } = require('../lib/commands/check-update');
const { runResolveDocs } = require('../lib/commands/resolve-docs');
const { runLandStack } = require('../lib/commands/land-stack');
const { readAddonManifestVersion } = require('../lib/core/bmad-config');

async function resolveVersion() {
  const packageRoot = path.resolve(__dirname, '..');
  const projectManifest = path.join(process.cwd(), '_Sprintpilot', 'manifest.yaml');
  const packageManifest = path.join(packageRoot, '_Sprintpilot', 'manifest.yaml');
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
    .name('sprintpilot')
    .description(
      'Sprintpilot — autopilot and multi-agent addon for BMad Method: autonomous story execution, parallel agents, git workflow',
    )
    .version(await resolveVersion(), '-v, --version', 'Show version');

  program
    .command('install', { isDefault: true })
    .description('Install Sprintpilot into the current BMad Method project')
    .option(
      '--tools <list>',
      'Comma-separated tools (claude-code,cursor,windsurf,cline,roo,trae,kiro,gemini-cli,github-copilot,all)',
    )
    .option(
      '--profile <name>',
      'Complexity profile: nano | small | medium | large | legacy (default: medium)',
    )
    .option('--dry-run', 'Preview without making changes')
    .option('--force', 'Skip backup of existing skills')
    .option(
      '--migrate-v1',
      'Migrate from bmad-autopilot-addon v1 (auto-detected; this flag is for non-interactive CI)',
    )
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
    .description('Remove Sprintpilot from the current project')
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
    .command('resolve-docs [paths...]')
    .description(
      'Resolve <<<<<<< conflict markers in BMad state YAML files using domain-aware merge logic (sprint-status, git-status, decision-log, autopilot-state)',
    )
    .option('--dry-run', 'Print which files would be resolved without writing')
    .action(async (paths, options) => {
      try {
        await runResolveDocs({ paths, dryRun: !!options.dryRun });
      } catch (err) {
        bail(err);
      }
    });

  program
    .command('land-stack')
    .description(
      'Bottom-up rescue for stacked PRs — fetches the open-PR stack, merges each, watches CI, and advances the base branch. Auto-resolves BMad state-file conflicts via the merge driver; surfaces real-code conflicts for manual resolution.',
    )
    .option('--platform <p>', 'Platform override: github|gitlab|bitbucket|gitea (default: detect)')
    .option('--branch-prefix <p>', 'Branch prefix to filter open PRs (default: story/)')
    .option('--base-branch <b>', 'Base branch (default: main)')
    .option('--base-url <url>', 'API base URL for self-hosted Gitea/GitLab/Bitbucket')
    .option('--method <m>', 'Merge method: merge|squash|rebase (default: merge)')
    .option('--ci-timeout <sec>', 'Per-PR CI watch timeout in seconds (default: 600)')
    .option('--poll-interval <sec>', 'CI poll interval in seconds (default: 30)')
    .option('--no-delete-branch', 'Keep branches on the platform after merge')
    .option('--on-ci-failure <m>', 'On CI failure: halt|warn_and_continue (default: halt)')
    .option('--dry-run', 'Print the plan without executing')
    .option('--force', 'Proceed even if working tree is not clean')
    .option('--stack-from-file <path>', 'Read stack as JSON from file (testing hook)')
    .action(async (options) => {
      try {
        await runLandStack({
          platform: options.platform,
          branchPrefix: options.branchPrefix,
          baseBranch: options.baseBranch,
          baseUrl: options.baseUrl,
          method: options.method,
          ciTimeout: options.ciTimeout,
          pollInterval: options.pollInterval,
          deleteBranch: options.deleteBranch !== false,
          onCiFailure: options.onCiFailure,
          dryRun: !!options.dryRun,
          force: !!options.force,
          stackFromFile: options.stackFromFile,
        });
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
