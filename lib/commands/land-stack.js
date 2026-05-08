// `sprintpilot land-stack` — bottom-up rescue for stacked PRs.
//
// Even with merge_strategy: land_as_you_go available, plenty of sessions
// will run in `manual` mode (the default). When the stack needs to land,
// the human dev otherwise does it manually — five rounds of "rebase/merge,
// push, watch CI, fix, push, merge". This command automates that path.
//
// For each PR in topological order (bottom-up):
//   1. fetch origin, check out the branch
//   2. merge origin/<base_branch> into it
//        (the auto-merge driver from chunk 1 fires on conflicted state
//         files automatically — only real-code conflicts remain)
//   3. on remaining conflicts → HALT with the file list
//   4. push the rebased branch
//   5. watch CI via pr-watch.js
//   6. merge via pr-merge.js
//   7. checkout base, pull, advance to next PR
//
// Reuses chunk 5's stack-snapshot.js for stack detection and chunk 2's
// pr-list / pr-checks / pr-merge layer for cross-platform PR ops.

const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('fs-extra');
const pc = require('picocolors');

const execFileAsync = promisify(execFile);

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPTS_DIR = path.join(PACKAGE_ROOT, '_Sprintpilot', 'scripts');

class HaltError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HaltError';
    this.exitCode = 3;
  }
}

async function git(projectRoot, args, opts = {}) {
  const { stdout, stderr } = await execFileAsync('git', ['-C', projectRoot, ...args], {
    maxBuffer: 10 * 1024 * 1024,
    ...opts,
  });
  return { stdout: stdout.toString(), stderr: stderr.toString() };
}

async function tryGit(projectRoot, args, opts = {}) {
  try {
    const r = await git(projectRoot, args, opts);
    return { exitCode: 0, ...r };
  } catch (err) {
    return {
      exitCode: typeof err.code === 'number' ? err.code : 1,
      stdout: (err.stdout || '').toString(),
      stderr: (err.stderr || err.message || '').toString(),
    };
  }
}

async function nodeScript(projectRoot, scriptName, args) {
  // Run a Sprintpilot helper script. We use the package-bundled copy under
  // PACKAGE_ROOT so this command works whether or not the user has run
  // `sprintpilot install` in the current project (the project copy may
  // be stale). All scripts only read the project's git/config state, so
  // running from package vs project doesn't change behavior.
  const scriptPath = path.join(SCRIPTS_DIR, scriptName);
  const { stdout, stderr } = await execFileAsync('node', [scriptPath, ...args], {
    cwd: projectRoot,
    maxBuffer: 10 * 1024 * 1024,
  }).catch((err) => ({
    stdout: (err.stdout || '').toString(),
    stderr: (err.stderr || '').toString(),
    exitCode: typeof err.code === 'number' ? err.code : 1,
  }));
  return { stdout: stdout.toString(), stderr: stderr.toString() };
}

async function detectPlatform(projectRoot) {
  const r = await nodeScript(projectRoot, 'detect-platform.js', []);
  return r.stdout.trim();
}

async function fetchStack(projectRoot, opts) {
  const args = [
    '--platform',
    opts.platform,
    '--branch-prefix',
    opts.branchPrefix,
    '--base-branch',
    opts.baseBranch,
    '--merge-strategy',
    'manual',
  ];
  if (opts.baseUrl) args.push('--base-url', opts.baseUrl);
  const r = await nodeScript(projectRoot, 'stack-snapshot.js', args);
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(
      `stack-snapshot emitted non-JSON: ${e.message}; stderr: ${r.stderr.trim().slice(0, 200)}`,
    );
  }
  if (parsed.snapshot.degraded) {
    throw new Error(`Stack snapshot degraded: ${parsed.snapshot.degraded}`);
  }
  return parsed.snapshot.pending_merges || [];
}

async function watchCi(projectRoot, opts, prNumber) {
  const args = [
    '--platform',
    opts.platform,
    '--pr',
    String(prNumber),
    '--timeout',
    String(opts.ciTimeout),
    '--interval',
    String(opts.pollInterval),
  ];
  if (opts.baseUrl) args.push('--base-url', opts.baseUrl);
  const r = await nodeScript(projectRoot, 'pr-watch.js', args);
  return JSON.parse(r.stdout);
}

async function mergePr(projectRoot, opts, prNumber) {
  const args = ['--platform', opts.platform, '--pr', String(prNumber), '--method', opts.method];
  if (opts.deleteBranch) args.push('--delete-branch');
  if (opts.baseUrl) args.push('--base-url', opts.baseUrl);
  const r = await nodeScript(projectRoot, 'pr-merge.js', args);
  return JSON.parse(r.stdout);
}

// =============================================================================
// Per-PR landing
// =============================================================================

async function landOne(projectRoot, pr, opts, log) {
  const branch = pr.sourceBranch || pr.source;
  const base = opts.baseBranch;
  const prNumber = pr.pr || pr.number;
  log(pc.bold(`\n=== Landing PR #${prNumber}: ${branch} → ${base} ===`));

  log(`  fetch origin…`);
  const fetched = await tryGit(projectRoot, ['fetch', 'origin', '--prune']);
  if (fetched.exitCode !== 0) {
    throw new HaltError(`git fetch failed: ${fetched.stderr.trim()}`);
  }

  log(`  checkout ${branch}`);
  const checkout = await tryGit(projectRoot, ['checkout', branch]);
  if (checkout.exitCode !== 0) {
    // Try with -B to create from origin if missing locally.
    const recreate = await tryGit(projectRoot, ['checkout', '-B', branch, `origin/${branch}`]);
    if (recreate.exitCode !== 0) {
      throw new HaltError(
        `git checkout ${branch} failed: ${checkout.stderr.trim() || recreate.stderr.trim()}`,
      );
    }
  }

  log(`  merge origin/${base} into ${branch}…`);
  const merge = await tryGit(projectRoot, ['merge', `origin/${base}`, '--no-edit']);
  if (merge.exitCode !== 0) {
    // git merge exit codes:
    //   0   — clean (handled above by the !== 0 check skipping this block)
    //   1   — merge had conflicts (the auto-merge driver may have resolved
    //         some; we inspect --diff-filter=U for what's left)
    //   ≥ 2 — fatal error (uncommitted changes blocking merge, lock file,
    //         missing ref, etc.) — there's no in-progress merge to commit
    //         and treating it as "driver covered everything" would lead
    //         to a confusing `git commit` failure downstream.
    if (merge.exitCode !== 1) {
      throw new HaltError(
        `git merge origin/${base} failed (exit ${merge.exitCode}): ${
          merge.stderr.trim() || merge.stdout.trim() || 'no output'
        }`,
      );
    }
    // The auto-merge driver from chunk 1 should have resolved BMad state
    // files automatically. Check what's left in the unmerged set.
    const status = await tryGit(projectRoot, ['diff', '--name-only', '--diff-filter=U']);
    const conflicted = status.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (conflicted.length > 0) {
      // Real conflicts. Abort the merge so the dev's worktree returns to
      // a clean state, then surface the file list.
      await tryGit(projectRoot, ['merge', '--abort']);
      throw new HaltError(
        `PR #${prNumber}: real-code conflicts in:\n  ${conflicted.join('\n  ')}\nResolve manually on branch ${branch} then re-run \`sprintpilot land-stack\`.`,
      );
    }
    // No conflicts remain — auto-merge driver covered everything. The
    // driver's exit-0 marks each file as resolved (staged in the index),
    // so we go straight to commit. We deliberately do NOT run `git add
    // -u` here: that would also pick up unrelated dirty-but-tracked files
    // (line-ending churn from core.autocrlf, IDE-touched files, anything
    // the cleanliness check missed) and silently bake them into the
    // merge commit.
    log('  auto-merge driver resolved doc conflicts — committing merge…');
    const commit = await tryGit(projectRoot, ['commit', '--no-edit']);
    if (commit.exitCode !== 0) {
      throw new HaltError(`git commit failed after auto-merge: ${commit.stderr.trim()}`);
    }
  }

  log(`  push origin ${branch}`);
  const push = await tryGit(projectRoot, ['push', 'origin', branch]);
  if (push.exitCode !== 0) {
    throw new HaltError(`git push failed: ${push.stderr.trim()}`);
  }

  log(`  watch CI (timeout ${opts.ciTimeout}s)…`);
  const ci = await watchCi(projectRoot, opts, prNumber);
  if (ci.state !== 'success') {
    const msg = `PR #${prNumber}: CI ${ci.state}${ci.timed_out ? ' (timed out)' : ''}. ${ci.summary || ''}`;
    if (opts.onCiFailure === 'halt') throw new HaltError(msg);
    log(pc.yellow(`  WARN: ${msg}`));
    log(pc.yellow('  --on-ci-failure=warn_and_continue: leaving PR stacked, advancing.'));
    return { merged: false, reason: ci.state };
  }

  log(`  merge PR (--method ${opts.method}${opts.deleteBranch ? ' --delete-branch' : ''})…`);
  const mergeResult = await mergePr(projectRoot, opts, prNumber);
  if (!mergeResult.merged) {
    throw new HaltError(
      `PR #${prNumber}: platform refused merge: ${mergeResult.error || mergeResult.skipped || 'unknown'}`,
    );
  }

  log(`  checkout ${base} && pull`);
  const co = await tryGit(projectRoot, ['checkout', base]);
  if (co.exitCode !== 0) {
    throw new HaltError(`git checkout ${base} failed: ${co.stderr.trim()}`);
  }
  const pull = await tryGit(projectRoot, ['pull', 'origin', base]);
  if (pull.exitCode !== 0) {
    log(pc.yellow(`  WARN: git pull failed: ${pull.stderr.trim()} — base may be stale`));
  }

  log(pc.green(`  PR #${prNumber} merged (${opts.method}).`));
  return { merged: true, prNumber };
}

// =============================================================================
// Top-level orchestrator
// =============================================================================

async function runLandStack(options = {}) {
  const projectRoot = process.env.BMAD_PROJECT_ROOT || process.cwd();
  const log = options.log || console.log;

  // Resolve options + apply defaults.
  const opts = {
    platform: options.platform || (await detectPlatform(projectRoot)),
    branchPrefix: options.branchPrefix || 'story/',
    baseBranch: options.baseBranch || 'main',
    baseUrl: options.baseUrl || null,
    method: options.method || 'merge',
    ciTimeout: Number(options.ciTimeout || 600),
    pollInterval: Number(options.pollInterval || 30),
    deleteBranch: options.deleteBranch !== false,
    onCiFailure: options.onCiFailure || 'halt',
  };

  if (!['merge', 'squash', 'rebase'].includes(opts.method)) {
    throw new Error(`invalid --method '${opts.method}': must be merge|squash|rebase`);
  }
  if (!['halt', 'warn_and_continue'].includes(opts.onCiFailure)) {
    throw new Error(
      `invalid --on-ci-failure '${opts.onCiFailure}': must be halt|warn_and_continue`,
    );
  }

  if (opts.platform === 'git_only') {
    log('git_only platform — no PR-based stack to land. Use git merge directly.');
    return { landed: 0, total: 0 };
  }

  // Detect or use the explicit stack.
  let stack;
  if (options.stackFromFile) {
    stack = JSON.parse(fs.readFileSync(options.stackFromFile, 'utf8'));
  } else if (options.stack && options.stack.length > 0) {
    // Explicit PR list — refuse to proceed without sourceBranch info,
    // since we need it for git operations. Tell the user to drop --stack
    // and use auto-detection (which fetches sourceBranch from the platform).
    throw new Error(
      '--stack <pr,pr,...> is reserved for future use; for now, omit --stack to auto-detect via stack-snapshot',
    );
  } else {
    stack = await fetchStack(projectRoot, opts);
  }

  if (!stack || stack.length === 0) {
    log('No PRs in stack — nothing to land.');
    return { landed: 0, total: 0 };
  }

  // Print the plan.
  log(pc.bold(`Plan: land ${stack.length} PR${stack.length > 1 ? 's' : ''} bottom-up:`));
  for (const pr of stack) {
    const prNum = pr.pr || pr.number;
    const ci = pr.ci || 'unknown';
    const ms = pr.mergeStateStatus || pr.merge_state || 'UNKNOWN';
    log(
      `  - PR #${prNum}: ${pr.sourceBranch || pr.source} → ${pr.base || pr.targetBranch} (CI: ${ci}, merge: ${ms})`,
    );
  }

  if (options.dryRun) {
    log(pc.dim('Dry run complete. No changes made.'));
    return { landed: 0, total: stack.length, dryRun: true };
  }

  // Working-tree cleanliness check (skip on --force) — gated to here so
  // empty-stack and --dry-run paths don't require a clean tree.
  if (!options.force) {
    const status = await tryGit(projectRoot, ['status', '--porcelain']);
    if (status.exitCode === 0 && status.stdout.trim()) {
      throw new Error(
        'working tree not clean — commit/stash changes or pass --force to proceed anyway',
      );
    }
  }

  // Execute bottom-up.
  let landed = 0;
  for (const pr of stack) {
    const result = await landOne(projectRoot, pr, opts, log);
    if (result.merged) landed++;
  }

  log(pc.green(`\n${landed} of ${stack.length} PRs landed. ${opts.baseBranch} is at HEAD.`));
  return { landed, total: stack.length };
}

module.exports = { runLandStack, landOne, HaltError };
