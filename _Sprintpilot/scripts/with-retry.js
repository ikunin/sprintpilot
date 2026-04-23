#!/usr/bin/env node

// with-retry.js — run a command with jittered-backoff retries on
// transient git ref-lock failures.
//
// Usage:
//   with-retry.js -- <command> [args...]
//   with-retry.js --attempts 3 --min-ms 500 --max-ms 2000 -- <command> [args...]
//   with-retry.js --pattern '<regex>' -- <command> [args...]
//
// Retry trigger:
//   stderr is scanned for the default ref-lock regex (case-insensitive):
//     cannot lock ref|Unable to create.*\.lock|Reference already exists|failed to lock|lock.ref
//   Custom regex via --pattern. Any command that matches the pattern AND
//   exits non-zero is retried up to --attempts times with jittered backoff
//   in [--min-ms, --max-ms]. All other non-zero exits are returned as-is
//   (no blind retry — safeguards against hiding real failures).
//
// Exit code: the last attempt's exit code. stdout + stderr are forwarded
// verbatim on each attempt.

const { spawnSync } = require('node:child_process');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_MIN_MS = 500;
const DEFAULT_MAX_MS = 2000;
const DEFAULT_REF_LOCK_PATTERN = /cannot lock ref|Unable to create.*\.lock|Reference already exists|failed to lock|lock\.ref/i;

function help() {
  log.out(
    [
      'Usage: with-retry.js [options] -- <command> [args...]',
      '',
      'Options:',
      '  --attempts N       Max attempts (default 3, min 1).',
      '  --min-ms N         Backoff lower bound (default 500).',
      '  --max-ms N         Backoff upper bound (default 2000).',
      '  --pattern REGEX    Override the retry-trigger regex (case-insensitive).',
      '  --no-shell         Always use execFile semantics (implicit — no shell).',
      '',
      'Retries only when stderr matches the pattern AND exit code is non-zero.',
    ].join('\n'),
  );
}

function jitteredDelay(minMs, maxMs) {
  const lo = Math.max(0, minMs);
  const hi = Math.max(lo, maxMs);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function sleepSync(ms) {
  // Node's child_process lacks a portable sleep; use spawnSync to block.
  if (ms <= 0) return;
  spawnSync(process.execPath, ['-e', `setTimeout(()=>process.exit(0), ${ms})`], {
    stdio: 'ignore',
  });
}

function shouldRetry(stderr, pattern) {
  if (!stderr) return false;
  return pattern.test(String(stderr));
}

function runOnce(cmd, args, inherit = false) {
  const res = spawnSync(cmd, args, {
    stdio: inherit ? 'inherit' : 'pipe',
    encoding: 'utf8',
  });
  return {
    status: res.status,
    signal: res.signal,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.error,
  };
}

function runWithRetry({ cmd, args, attempts = DEFAULT_ATTEMPTS, minMs = DEFAULT_MIN_MS, maxMs = DEFAULT_MAX_MS, pattern = DEFAULT_REF_LOCK_PATTERN, onAttempt = null }) {
  const actualAttempts = Math.max(1, attempts | 0);
  let last = null;
  for (let i = 0; i < actualAttempts; i++) {
    const res = runOnce(cmd, args);
    last = res;
    if (typeof onAttempt === 'function') onAttempt({ attempt: i + 1, ...res });
    if (res.status === 0) return { ...res, attempts: i + 1 };
    if (!shouldRetry(res.stderr, pattern)) return { ...res, attempts: i + 1 };
    if (i + 1 >= actualAttempts) break;
    sleepSync(jitteredDelay(minMs, maxMs));
  }
  return { ...last, attempts: actualAttempts };
}

function splitAtSeparator(argv) {
  const idx = argv.indexOf('--');
  if (idx === -1) return { flags: argv, cmdArgs: [] };
  return { flags: argv.slice(0, idx), cmdArgs: argv.slice(idx + 1) };
}

function main() {
  const { flags, cmdArgs } = splitAtSeparator(process.argv.slice(2));
  const { opts } = parseArgs(flags);
  if (opts.help || cmdArgs.length === 0) {
    help();
    process.exit(opts.help ? 0 : 1);
  }
  const attempts = opts.attempts !== undefined ? Number.parseInt(String(opts.attempts), 10) : DEFAULT_ATTEMPTS;
  const minMs = opts['min-ms'] !== undefined ? Number.parseInt(String(opts['min-ms']), 10) : DEFAULT_MIN_MS;
  const maxMs = opts['max-ms'] !== undefined ? Number.parseInt(String(opts['max-ms']), 10) : DEFAULT_MAX_MS;
  let pattern = DEFAULT_REF_LOCK_PATTERN;
  if (opts.pattern) {
    try {
      pattern = new RegExp(String(opts.pattern), 'i');
    } catch (e) {
      log.error(`invalid --pattern regex: ${e.message}`);
      process.exit(1);
    }
  }
  const [cmd, ...rest] = cmdArgs;
  const res = runWithRetry({ cmd, args: rest, attempts, minMs, maxMs, pattern });
  process.stdout.write(res.stdout);
  process.stderr.write(res.stderr);
  if (res.attempts > 1) {
    process.stderr.write(`with-retry: ${res.attempts} attempts, final exit ${res.status}\n`);
  }
  process.exit(res.status === null ? 1 : res.status);
}

module.exports = {
  DEFAULT_ATTEMPTS,
  DEFAULT_MIN_MS,
  DEFAULT_MAX_MS,
  DEFAULT_REF_LOCK_PATTERN,
  shouldRetry,
  jitteredDelay,
  runWithRetry,
  splitAtSeparator,
};

if (require.main === module) {
  main();
}
