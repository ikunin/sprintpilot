#!/usr/bin/env node

// submodule-lock.js — serialize concurrent `git submodule update` calls
// across worktrees so they don't stomp each other's index.lock.
//
// Usage:
//   submodule-lock.js acquire --submodule <name> [--project-root <path>]
//   submodule-lock.js release --submodule <name> [--project-root <path>]
//   submodule-lock.js check   --submodule <name> [--project-root <path>]
//
// Lock path:
//   <project-root>/.sprintpilot/submodule-locks/<slug>.lock
//   (outside .git/ so git doesn't warn about foreign files)
//
// Thin wrapper over lock.js --file <lockPath>. Submodule names are
// slugified for filesystem safety (only [a-z0-9-] survive).

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');

const VALID_ACTIONS = ['acquire', 'release', 'check'];
const LOCK_SCRIPT = path.join(__dirname, 'lock.js');

function help() {
  log.out(
    [
      'Usage:',
      '  submodule-lock.js acquire --submodule <name> [--project-root <path>]',
      '  submodule-lock.js release --submodule <name>',
      '  submodule-lock.js check   --submodule <name>',
    ].join('\n'),
  );
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function lockPathFor(projectRoot, submodule) {
  const slug = slugify(submodule);
  if (!slug) throw new Error(`invalid submodule name: '${submodule}' slugifies to empty`);
  return path.join(projectRoot, '.sprintpilot', 'submodule-locks', `${slug}.lock`);
}

function ensureDirFor(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function runLockScript(action, lockFile) {
  const res = spawnSync(
    process.execPath,
    [LOCK_SCRIPT, action, '--file', lockFile, '--stale-minutes', '30'],
    { encoding: 'utf8' },
  );
  return {
    status: res.status === null ? 1 : res.status,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
  };
}

function acquire(projectRoot, submodule) {
  const lockFile = lockPathFor(projectRoot, submodule);
  ensureDirFor(lockFile);
  return runLockScript('acquire', lockFile);
}

function release(projectRoot, submodule) {
  const lockFile = lockPathFor(projectRoot, submodule);
  return runLockScript('release', lockFile);
}

function check(projectRoot, submodule) {
  const lockFile = lockPathFor(projectRoot, submodule);
  return runLockScript('check', lockFile);
}

function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));
  if (opts.help || positional.length === 0) {
    help();
    process.exit(opts.help ? 0 : 1);
  }
  const action = positional[0];
  if (!VALID_ACTIONS.includes(action)) {
    log.error(`unknown action '${action}'. Valid: ${VALID_ACTIONS.join(', ')}`);
    process.exit(1);
  }
  const submodule = opts.submodule;
  if (!submodule) {
    log.error('--submodule is required');
    process.exit(1);
  }
  const projectRoot = opts['project-root'] || process.cwd();

  let res;
  try {
    if (action === 'acquire') res = acquire(projectRoot, submodule);
    else if (action === 'release') res = release(projectRoot, submodule);
    else res = check(projectRoot, submodule);
  } catch (e) {
    log.error(e.message);
    process.exit(1);
  }
  if (res.stdout) process.stdout.write(`${res.stdout}\n`);
  if (res.stderr) process.stderr.write(`${res.stderr}\n`);
  process.exit(res.status);
}

module.exports = {
  VALID_ACTIONS,
  slugify,
  lockPathFor,
  acquire,
  release,
  check,
};

if (require.main === module) {
  main();
}
