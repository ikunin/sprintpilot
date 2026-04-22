#!/usr/bin/env node

// check-prereqs.js — verify Sprintpilot v2's environment prerequisites.
//
// Exit codes:
//   0 — all prereqs met (may include a warning for degraded mode)
//   1 — hard failure (user must resolve before continuing)
//
// Checks:
//   - Node >= 18 (package.json engines)
//   - Git >= 2.18 required for submodule --jobs / --reference (PR 10).
//     Git 2.5.0–2.17 works in degraded mode (no submodule speedup) —
//     emits a warning on stderr but exits 0.

const { execFileSync } = require('node:child_process');
const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');

const MIN_NODE = [18, 0, 0];
const MIN_GIT_STRICT = [2, 18, 0]; // submodule --jobs / --reference
const MIN_GIT_SOFT = [2, 5, 0]; // worktree basics

function help() {
  log.out('Usage: check-prereqs.js [--min-git <semver>]');
}

function parseSemver(str) {
  // Accept "2.18.0", "2.18", "git version 2.39.3 (Apple Git-145)", etc.
  const m = String(str).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return [
    Number.parseInt(m[1], 10),
    Number.parseInt(m[2], 10),
    m[3] ? Number.parseInt(m[3], 10) : 0,
  ];
}

function cmp(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

function fmt(v) {
  return `${v[0]}.${v[1]}.${v[2]}`;
}

function checkNode() {
  const v = parseSemver(process.version);
  if (!v) {
    log.error(`unable to parse node version '${process.version}'`);
    return { ok: false };
  }
  if (cmp(v, MIN_NODE) < 0) {
    log.error(`node ${fmt(v)} is too old; need >= ${fmt(MIN_NODE)}. Upgrade node.`);
    return { ok: false };
  }
  return { ok: true, version: fmt(v) };
}

function readGitVersion() {
  // execFileSync (not exec) — no shell, no injection surface.
  try {
    const out = execFileSync('git', ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    }).trim();
    return out;
  } catch {
    return null;
  }
}

function checkGit(minStrictArg) {
  const raw = readGitVersion();
  if (!raw) {
    log.error('git not found on PATH. Install git >= 2.18 (or 2.5 for degraded mode).');
    return { ok: false };
  }
  const v = parseSemver(raw);
  if (!v) {
    log.warn(`unable to parse git version string: ${raw}`);
    return { ok: true, version: raw, degraded: true };
  }
  const minStrict = minStrictArg ? parseSemver(minStrictArg) : MIN_GIT_STRICT;
  if (cmp(v, minStrict) >= 0) {
    return { ok: true, version: fmt(v), degraded: false };
  }
  if (cmp(v, MIN_GIT_SOFT) >= 0) {
    log.warn(
      `git ${fmt(v)} is below recommended ${fmt(minStrict)}. Degraded mode: submodule speedups disabled (PR 10 features).`,
    );
    return { ok: true, version: fmt(v), degraded: true };
  }
  log.error(
    `git ${fmt(v)} is too old; need >= ${fmt(MIN_GIT_SOFT)} minimum (${fmt(minStrict)} recommended).`,
  );
  return { ok: false, version: fmt(v) };
}

function main() {
  const { opts } = parseArgs(process.argv.slice(2));
  if (opts.help) {
    help();
    process.exit(0);
  }

  const node = checkNode();
  if (!node.ok) process.exit(1);

  const git = checkGit(opts['min-git']);
  if (!git.ok) process.exit(1);

  // Summary on stdout for scripting consumers.
  const summary = {
    node: node.version,
    git: git.version,
    git_degraded: git.degraded || false,
  };
  process.stdout.write(JSON.stringify(summary) + '\n');
  process.exit(0);
}

module.exports = {
  checkNode,
  checkGit,
  parseSemver,
  cmp,
  fmt,
  MIN_NODE,
  MIN_GIT_STRICT,
  MIN_GIT_SOFT,
};

if (require.main === module) {
  main();
}
