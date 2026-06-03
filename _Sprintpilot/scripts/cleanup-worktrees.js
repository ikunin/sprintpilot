#!/usr/bin/env node

// cleanup-worktrees.js — remove orphan worktrees under .worktrees/.
//
// After `gh pr merge --delete-branch` (or any branch deletion), the
// branch is gone but the `.worktrees/<name>/` directory remains. Git's
// `git worktree prune` removes the `.git/worktrees/<name>/` metadata
// but NOT the actual directory. Without explicit cleanup, .worktrees/
// accumulates orphans every epic merge.
//
// This script:
//   1. Runs `git worktree prune --expire now` to clear metadata.
//   2. Walks `.worktrees/*` and removes directories whose branches no
//      longer resolve (locally and on origin).
//
// Honors `git.worktree.cleanup_on_merge` via the orchestrator's plan —
// this script is only invoked when that flag is true. Standalone use:
//
//   node _Sprintpilot/scripts/cleanup-worktrees.js \
//     [--worktrees-dir .worktrees] [--project-root <path>] [--dry-run]

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');

function git(cwd, args, opts) {
  return cp.spawnSync(
    'git',
    ['-C', cwd, ...args],
    Object.assign(
      {
        encoding: 'utf8',
        timeout: 10000,
      },
      opts || {},
    ),
  );
}

function localBranchExists(projectRoot, branch) {
  const r = git(projectRoot, ['show-ref', '--verify', '--quiet', 'refs/heads/' + branch], {
    stdio: 'ignore',
  });
  return r.status === 0;
}

function remoteBranchExists(projectRoot, branch) {
  const r = git(projectRoot, ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/' + branch], {
    stdio: 'ignore',
  });
  return r.status === 0;
}

function detectBranchFromGitfile(worktreeDir) {
  const gitfile = path.join(worktreeDir, '.git');
  let raw;
  try {
    raw = fs.readFileSync(gitfile, 'utf8');
  } catch (_e) {
    return { kind: 'unknown', branch: null };
  }
  const m = /^gitdir:\s*(.+)$/m.exec(raw);
  if (!m) return { kind: 'unknown', branch: null };
  const gitdir = m[1].trim();
  if (!fs.existsSync(gitdir)) {
    return { kind: 'orphan', branch: null };
  }
  const headPath = path.join(gitdir, 'HEAD');
  let head;
  try {
    head = fs.readFileSync(headPath, 'utf8').trim();
  } catch (_e) {
    return { kind: 'orphan', branch: null };
  }
  const refMatch = /^ref:\s*refs\/heads\/(.+)$/m.exec(head);
  if (!refMatch) return { kind: 'detached', branch: null };
  return { kind: 'attached', branch: refMatch[1] };
}

function main() {
  const { opts } = parseArgs(process.argv.slice(2));
  if (opts.help) {
    log.out(
      'Usage: cleanup-worktrees.js [--worktrees-dir .worktrees] [--project-root <path>] [--dry-run]',
    );
    process.exit(0);
  }
  const projectRoot = opts['project-root'] || process.cwd();
  const worktreesDir = opts['worktrees-dir']
    ? path.resolve(opts['worktrees-dir'])
    : path.join(projectRoot, '.worktrees');
  const dryRun = !!opts['dry-run'];

  const prune = git(projectRoot, ['worktree', 'prune', '--expire', 'now']);
  if (prune.status !== 0 && prune.error) {
    log.error('git worktree prune failed: ' + prune.error.message);
    process.exit(1);
  }

  if (!fs.existsSync(worktreesDir)) {
    log.out('SUMMARY:0:0:0');
    return;
  }
  let entries;
  try {
    entries = fs.readdirSync(worktreesDir, { withFileTypes: true });
  } catch (e) {
    log.error('cannot read ' + worktreesDir + ': ' + e.message);
    process.exit(1);
  }

  let inspected = 0;
  let removed = 0;
  let kept = 0;
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    inspected += 1;
    const wt = path.join(worktreesDir, ent.name);
    const info = detectBranchFromGitfile(wt);

    let orphan = false;
    if (info.kind === 'orphan') {
      orphan = true;
    } else if (info.kind === 'attached' && info.branch) {
      const localOk = localBranchExists(projectRoot, info.branch);
      const remoteOk = remoteBranchExists(projectRoot, info.branch);
      if (!localOk && !remoteOk) orphan = true;
    } else {
      kept += 1;
      continue;
    }

    if (!orphan) {
      kept += 1;
      continue;
    }

    log.out('ORPHAN:' + ent.name);
    if (dryRun) {
      removed += 1;
      continue;
    }
    const r = git(projectRoot, ['worktree', 'remove', '--force', wt], { stdio: 'ignore' });
    if (r.status !== 0) {
      try {
        fs.rmSync(wt, { recursive: true, force: true });
      } catch (e) {
        log.err('WARN: cannot remove ' + wt + ': ' + e.message);
        continue;
      }
    }
    removed += 1;
  }

  log.out('SUMMARY:' + inspected + ':' + removed + ':' + kept);
}

main();
