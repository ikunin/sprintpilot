#!/usr/bin/env node

// git-portable.js — cross-platform replacements for POSIX-shell git idioms
// that workflow.md previously inlined. Every subcommand emits a clean stdout
// value with no dependency on shell features (no `2>/dev/null`, no `||`, no
// `$(...)` substitution, no `grep`/`echo`/`true`).
//
// Usage:
//   git-portable.js count-worktrees [--project-root <path>]
//   git-portable.js config-get <key> [--default <value>] [--scope local|global|system]
//                                    [--project-root <path>]
//   git-portable.js common-dir      [--project-root <path>]
//   git-portable.js safe-add <path>... [--project-root <path>]
//
// Subcommands
//
//   count-worktrees
//     Replaces: `git worktree list --porcelain 2>/dev/null | grep -c '^worktree '`
//     Stdout: an integer. Exits 0. Falls back to the integer 2 (matching
//     workflow.md's "fail-open to 2 to force the full boot path" semantic)
//     when git fails for any reason.
//
//   config-get <key> [--default <value>]
//     Replaces: `git config --get <key> 2>/dev/null || echo <value>`
//     Stdout: the config value, or <value> on absence ("unset" if not given).
//     --scope chooses the git config scope (default: local + global cascade,
//     i.e. plain `git config --get`).
//
//   common-dir
//     Replaces: `GIT_COMMON=$(git -C <root> rev-parse --git-common-dir)`
//     Stdout: the absolute path of the common git directory. Exit 1 on
//     failure (the caller should error out — this is load-bearing for
//     submodule init).
//
//   safe-add <path>...
//     Replaces: `git add <path1> <path2> ... 2>/dev/null || true`
//     Filters paths to those that exist on disk, then runs `git add` on
//     the survivors only. Emits a JSON summary on stdout:
//       { "added": ["a", "b"], "skipped": ["c"] }
//     Exit 0 always (best-effort by design). When zero paths exist,
//     `added: []` and `git add` is not invoked.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');

const VALID_COMMANDS = ['count-worktrees', 'config-get', 'common-dir', 'safe-add'];
const VALID_SCOPES = ['local', 'global', 'system'];

function help() {
  log.out(
    [
      'Usage:',
      '  git-portable.js count-worktrees [--project-root <path>]',
      '  git-portable.js config-get <key> [--default <value>] [--scope local|global|system] [--project-root <path>]',
      '  git-portable.js common-dir      [--project-root <path>]',
      '  git-portable.js safe-add <path>... [--project-root <path>]',
      '',
      'Cross-platform replacements for POSIX-shell git idioms used in workflow.md.',
      'No shell features (pipes, redirects, $(), || ) — safe under cmd.exe and PowerShell.',
    ].join('\n'),
  );
}

function git(projectRoot, args) {
  return spawnSync('git', ['-C', projectRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

// ---------------------------------------------------------------
// count-worktrees
// ---------------------------------------------------------------

function countWorktrees(projectRoot) {
  const res = git(projectRoot, ['worktree', 'list', '--porcelain']);
  if (res.status !== 0) return 2; // fail-open per workflow contract
  const out = String(res.stdout || '');
  let count = 0;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) count++;
  }
  return count;
}

// ---------------------------------------------------------------
// config-get
// ---------------------------------------------------------------

function configGet(projectRoot, key, { defaultValue, scope }) {
  const args = ['config'];
  if (scope) args.push(`--${scope}`);
  args.push('--get', key);
  const res = git(projectRoot, args);
  if (res.status === 0) {
    return String(res.stdout || '').trim();
  }
  // git config --get exits 1 when the key is absent. Return default.
  return defaultValue;
}

// ---------------------------------------------------------------
// common-dir
// ---------------------------------------------------------------

function commonDir(projectRoot) {
  const res = git(projectRoot, ['rev-parse', '--git-common-dir']);
  if (res.status !== 0) {
    return { ok: false, error: String(res.stderr || '').trim() };
  }
  const raw = String(res.stdout || '').trim();
  if (!raw) return { ok: false, error: 'empty output' };
  // git emits a relative path when run from inside the repo root; resolve
  // against projectRoot for an absolute, parser-safe value.
  const abs = path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw);
  return { ok: true, value: abs };
}

// ---------------------------------------------------------------
// safe-add
// ---------------------------------------------------------------

function safeAdd(projectRoot, paths) {
  const added = [];
  const skipped = [];
  for (const p of paths) {
    const abs = path.isAbsolute(p) ? p : path.join(projectRoot, p);
    if (fs.existsSync(abs)) {
      added.push(p);
    } else {
      skipped.push(p);
    }
  }
  if (added.length === 0) return { added, skipped };
  const res = git(projectRoot, ['add', '--', ...added]);
  if (res.status !== 0) {
    // Surface partial-failure detail on stderr, but never throw.
    log.warn(`git add failed (${res.status}): ${String(res.stderr || '').trim()}`);
  }
  return { added, skipped };
}

// ---------------------------------------------------------------
// CLI
// ---------------------------------------------------------------

function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));
  if (opts.help || positional.length === 0) {
    help();
    process.exit(opts.help ? 0 : 1);
  }
  const command = positional[0];
  if (!VALID_COMMANDS.includes(command)) {
    log.error(`unknown command '${command}'. Valid: ${VALID_COMMANDS.join(', ')}`);
    process.exit(1);
  }
  const projectRoot = opts['project-root'] || process.cwd();

  if (command === 'count-worktrees') {
    process.stdout.write(`${countWorktrees(projectRoot)}\n`);
    return;
  }

  if (command === 'config-get') {
    const key = positional[1];
    if (!key) {
      log.error('config-get requires <key>');
      process.exit(1);
    }
    const defaultValue = opts.default !== undefined ? String(opts.default) : 'unset';
    const scope = opts.scope ? String(opts.scope) : null;
    if (scope && !VALID_SCOPES.includes(scope)) {
      log.error(`invalid --scope '${scope}'. Valid: ${VALID_SCOPES.join(', ')}`);
      process.exit(1);
    }
    process.stdout.write(`${configGet(projectRoot, key, { defaultValue, scope })}\n`);
    return;
  }

  if (command === 'common-dir') {
    const r = commonDir(projectRoot);
    if (!r.ok) {
      log.error(`failed to resolve git common dir: ${r.error}`);
      process.exit(1);
    }
    process.stdout.write(`${r.value}\n`);
    return;
  }

  if (command === 'safe-add') {
    const paths = positional.slice(1);
    if (paths.length === 0) {
      log.error('safe-add requires at least one <path>');
      process.exit(1);
    }
    const summary = safeAdd(projectRoot, paths);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return;
  }
}

module.exports = {
  VALID_COMMANDS,
  VALID_SCOPES,
  countWorktrees,
  configGet,
  commonDir,
  safeAdd,
};

if (require.main === module) {
  main();
}
