#!/usr/bin/env node

// preflight-merge.js — dry-run merge conflict detection for cross-epic
// parallel execution (PR 12, experimental).
//
// Usage:
//   preflight-merge.js --epics <id,id,...> --base <branch>
//                      [--project-root <path>] [--branch-prefix <str>]
//                      [--lock-timeout-sec <n>]
//
// For every pair of epic branches (epic-<id>), attempts a no-commit
// dry-run merge against --base. If both merges succeed (no conflicts),
// the pair is "safe". Otherwise it's recorded as a conflict pair.
//
// Safety rails:
//   1. Lock acquisition via lock.js --file .sprintpilot/preflight.lock.
//      Only one preflight runs at a time; default timeout 60s.
//   2. Startup cleanup — if __sprintpilot_preflight branch exists from a
//      prior crashed run, force-delete it before proceeding.
//   3. Every merge attempt is followed by `git merge --abort` regardless
//      of outcome, ensuring the base branch is never left mid-merge.
//   4. Try/finally release the lock even on fatal errors.
//
// Output (stdout, JSON):
//   { safe_pairs: [["1","3"], ...], conflict_pairs: [["2","4"], ...] }

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');

const PREFLIGHT_BRANCH = '__sprintpilot_preflight';
const DEFAULT_LOCK_TIMEOUT_SEC = 60;
const LOCK_PATH_REL = path.join('.sprintpilot', 'preflight.lock');

function help() {
  log.out(
    [
      'Usage:',
      '  preflight-merge.js --epics <id,id,...> --base <branch>',
      '                     [--project-root <path>] [--branch-prefix <str>]',
      '                     [--lock-timeout-sec <n>]',
    ].join('\n'),
  );
}

function parseEpics(raw) {
  if (!raw) return { ok: false, error: '--epics is required' };
  const ids = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length < 2) {
    return { ok: false, error: '--epics must contain at least two IDs' };
  }
  for (const id of ids) {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) {
      return { ok: false, error: `invalid epic id '${id}': must match ^[a-z0-9][a-z0-9-]*$` };
    }
  }
  return { ok: true, value: ids };
}

function pairs(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) out.push([arr[i], arr[j]]);
  }
  return out;
}

function git(projectRoot, args, { allowFail = false } = {}) {
  const res = spawnSync('git', ['-C', projectRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!allowFail && res.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (status ${res.status}):\n${(res.stderr || '').trim()}`,
    );
  }
  return {
    status: res.status === null ? 1 : res.status,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
  };
}

function acquireLock(projectRoot, timeoutSec) {
  const lockFile = path.join(projectRoot, LOCK_PATH_REL);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const lockScript = path.join(__dirname, 'lock.js');
  const deadline = Date.now() + Math.max(1, timeoutSec) * 1000;
  // Single attempt with a few retries inside the timeout window — kept
  // synchronous with a tight busy-wait via spawnSync sleep.
  while (Date.now() < deadline) {
    const res = spawnSync(
      process.execPath,
      [lockScript, 'acquire', '--file', lockFile, '--stale-minutes', '30'],
      { encoding: 'utf8' },
    );
    const stdout = (res.stdout || '').trim();
    if (res.status === 0 && stdout.startsWith('ACQUIRED')) {
      return lockFile;
    }
    // Brief pause before retrying.
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>process.exit(0), 200)'], {
      stdio: 'ignore',
    });
  }
  throw new Error(`preflight lock not acquired within ${timeoutSec}s (held by another preflight)`);
}

function releaseLock(lockFile) {
  if (!lockFile) return;
  const lockScript = path.join(__dirname, 'lock.js');
  spawnSync(process.execPath, [lockScript, 'release', '--file', lockFile], {
    encoding: 'utf8',
    stdio: 'ignore',
  });
}

function startupCleanup(projectRoot) {
  // Refuse to run if HEAD is already on the preflight branch (paranoia).
  const head = git(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
  if (head.stdout === PREFLIGHT_BRANCH) {
    throw new Error(`refusing to run preflight: HEAD is on ${PREFLIGHT_BRANCH}. Switch first.`);
  }
  // Delete stale preflight branch if present.
  const exists = git(projectRoot, ['rev-parse', '--verify', PREFLIGHT_BRANCH], { allowFail: true });
  if (exists.status === 0) {
    git(projectRoot, ['branch', '-D', PREFLIGHT_BRANCH], { allowFail: true });
  }
}

function tryMergePair(projectRoot, base, branchA, branchB) {
  // Fresh preflight branch off base.
  git(projectRoot, ['checkout', '-B', PREFLIGHT_BRANCH, base]);
  try {
    // Merge A first (producing a merge commit). `--no-edit` keeps the
    // default message; a conflict leaves files in the index and we abort.
    const m1 = git(projectRoot, ['merge', '--no-ff', '--no-edit', branchA], { allowFail: true });
    if (m1.status !== 0) {
      git(projectRoot, ['merge', '--abort'], { allowFail: true });
      return { safe: false, conflict_at: branchA, detail: m1.stderr };
    }
    // Now merge B on top of the A-merged preflight.
    const m2 = git(projectRoot, ['merge', '--no-ff', '--no-edit', branchB], { allowFail: true });
    if (m2.status !== 0) {
      git(projectRoot, ['merge', '--abort'], { allowFail: true });
      return { safe: false, conflict_at: branchB, detail: m2.stderr };
    }
    return { safe: true };
  } finally {
    // Always return to base and drop the preflight branch (force-delete
    // because it contains commits that aren't on base).
    git(projectRoot, ['checkout', base], { allowFail: true });
    git(projectRoot, ['branch', '-D', PREFLIGHT_BRANCH], { allowFail: true });
  }
}

function preflight({ projectRoot, epics, base, branchPrefix, lockTimeoutSec }) {
  const lock = acquireLock(projectRoot, lockTimeoutSec);
  const safe_pairs = [];
  const conflict_pairs = [];
  try {
    startupCleanup(projectRoot);
    for (const [a, b] of pairs(epics)) {
      const bA = `${branchPrefix}epic-${a}`;
      const bB = `${branchPrefix}epic-${b}`;
      const res = tryMergePair(projectRoot, base, bA, bB);
      if (res.safe) safe_pairs.push([a, b]);
      else conflict_pairs.push([a, b]);
    }
  } finally {
    releaseLock(lock);
  }
  return { safe_pairs, conflict_pairs, checked: pairs(epics).length };
}

function main() {
  const { opts } = parseArgs(process.argv.slice(2));
  if (opts.help) {
    help();
    process.exit(0);
  }
  const epics = parseEpics(opts.epics);
  if (!epics.ok) {
    log.error(epics.error);
    process.exit(1);
  }
  if (!opts.base) {
    log.error('--base is required');
    process.exit(1);
  }
  const projectRoot = opts['project-root'] || process.cwd();
  const branchPrefix =
    opts['branch-prefix'] !== undefined ? String(opts['branch-prefix']) : 'story/';
  const timeout = opts['lock-timeout-sec']
    ? Number.parseInt(String(opts['lock-timeout-sec']), 10)
    : DEFAULT_LOCK_TIMEOUT_SEC;

  try {
    const result = preflight({
      projectRoot,
      epics: epics.value,
      base: String(opts.base),
      branchPrefix,
      lockTimeoutSec: timeout,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  } catch (e) {
    log.error(`preflight failed: ${e.message}`);
    process.exit(1);
  }
}

module.exports = {
  PREFLIGHT_BRANCH,
  DEFAULT_LOCK_TIMEOUT_SEC,
  LOCK_PATH_REL,
  parseEpics,
  pairs,
  preflight,
  tryMergePair,
  startupCleanup,
  acquireLock,
  releaseLock,
};

if (require.main === module) {
  main();
}
