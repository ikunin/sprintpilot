#!/usr/bin/env node

// auto-merge-bmad-docs.js — automatically merge BMad documentation
// updates (decision log, retrospectives, story files) from per-story
// branches into the base, without running the full per-story PR flow.
//
// Use case: after `bmad-create-story` or `bmad-retrospective` produces
// artifacts that don't affect product code, fast-merge them so the next
// story can build on the latest sprint state without waiting on review.
//
// Scope: only touches files under `_bmad-output/` and recognized
// SAFE paths. Refuses to merge a branch that has product-code changes.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');

const SAFE_PATHS = ['_bmad-output/', '_bmad/', 'docs/sprint/'];

function help() {
  log.out(
    [
      'Usage: auto-merge-bmad-docs.js --branch <name> [--base <name>]',
      '                                [--project-root <path>] [--check-only]',
      '',
      'Refuses to merge if the branch touches any path outside SAFE_PATHS:',
      `  ${SAFE_PATHS.join(', ')}`,
    ].join('\n'),
  );
}

function git(projectRoot, args) {
  return execFileSync('git', ['-C', projectRoot, ...args], { encoding: 'utf8' }).trim();
}

function changedFiles(projectRoot, branch, base) {
  return git(projectRoot, ['diff', '--name-only', `${base}...${branch}`])
    .split(/\n/)
    .filter(Boolean);
}

function classifyChanges(files) {
  const unsafe = files.filter((f) => !SAFE_PATHS.some((prefix) => f.startsWith(prefix)));
  return { safe: unsafe.length === 0, unsafe };
}

function main(argv) {
  const { opts } = parseArgs(argv, { booleanFlags: ['help', 'check-only'] });
  if (opts.help) {
    help();
    return 0;
  }
  if (!opts.branch) {
    log.error('--branch required');
    return 2;
  }
  const projectRoot = path.resolve(opts['project-root'] || process.cwd());
  const base = opts.base || 'main';

  let files;
  try {
    files = changedFiles(projectRoot, opts.branch, base);
  } catch (e) {
    log.error(`git diff failed: ${e.message}`);
    return 1;
  }

  const classification = classifyChanges(files);
  const result = {
    branch: opts.branch,
    base,
    files,
    ...classification,
  };

  if (opts['check-only']) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.safe ? 0 : 1;
  }

  if (!result.safe) {
    log.error(
      `refusing to auto-merge: branch touches ${result.unsafe.length} non-doc file(s): ${result.unsafe.slice(0, 5).join(', ')}${result.unsafe.length > 5 ? '...' : ''}`,
    );
    return 1;
  }

  // Safe — perform the merge.
  try {
    git(projectRoot, ['switch', base]);
    git(projectRoot, [
      'merge',
      '--no-ff',
      '-m',
      `Auto-merge BMad docs from ${opts.branch}`,
      opts.branch,
    ]);
  } catch (e) {
    log.error(`merge failed: ${e.message}`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify({ ...result, merged: true }, null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, classifyChanges, SAFE_PATHS };
