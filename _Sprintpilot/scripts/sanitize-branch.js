#!/usr/bin/env node

const crypto = require('node:crypto');

const { parseArgs } = require('../lib/runtime/args');
const { tryGit } = require('../lib/runtime/git');
const log = require('../lib/runtime/log');

function help() {
  log.out('Usage: sanitize-branch.js <story-key> [--prefix story/] [--max-length 60]');
}

// Minimum length for truncation to produce a valid result: we need at least
// 1 char of name + '-' + 6-char hash = 8 chars.
const MIN_MAX_LENGTH = 8;

function sanitize(storyKey, maxLength) {
  let name = storyKey.toLowerCase();
  // Strip invalid git ref chars + control chars.
  name = name
    .replace(/[~^:?*[\\@{}"'!#$%+;=,<>|`\]]/g, '')
    .replace(/[\x00-\x1f]/g, '')
    // Path separators and path-traversal sequences — git treats `..` as
    // invalid and `/` creates ref namespaces, so a story key like
    // `../../etc/passwd` otherwise lands as a directory-traversing ref.
    .replace(/\.\.+/g, '-')
    .replace(/\//g, '-')
    .replace(/\s+/g, '-')
    .replace(/[&()]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '');

  if (!name) return null;

  if (name.length > maxLength) {
    const hash = crypto.createHash('sha256').update(name).digest('hex').slice(0, 6);
    const truncLen = maxLength - 7; // -6 for hash, -1 for separator
    name = `${name.slice(0, truncLen)}-${hash}`;
  }
  return name;
}

async function branchExists(fullName) {
  const r = await tryGit(['rev-parse', '--verify', fullName]);
  return r.exitCode === 0;
}

async function validateRefFormat(fullName) {
  const r = await tryGit(['check-ref-format', '--branch', fullName]);
  return r.exitCode === 0;
}

async function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));
  if (opts.help) {
    help();
    process.exit(0);
  }
  const storyKey = positional[0];
  const prefix = opts.prefix ?? 'story/';
  const maxLength = parseInt(opts['max-length'] || '60', 10);

  if (!storyKey) {
    log.error('story key required');
    process.exit(1);
  }

  if (!Number.isFinite(maxLength) || maxLength < MIN_MAX_LENGTH) {
    log.error(`--max-length must be at least ${MIN_MAX_LENGTH} (got ${maxLength})`);
    process.exit(1);
  }

  let name = sanitize(storyKey, maxLength);
  if (!name) {
    log.error(`story key '${storyKey}' produced empty branch name after sanitization`);
    process.exit(1);
  }

  let fullName = `${prefix}${name}`;
  if (await branchExists(fullName)) {
    const maxAttempts = 100;
    let counter = 2;
    while (counter <= maxAttempts) {
      if (!(await branchExists(`${prefix}${name}-${counter}`))) {
        name = `${name}-${counter}`;
        fullName = `${prefix}${name}`;
        break;
      }
      counter++;
    }
    if (counter > maxAttempts) {
      log.error(`branch collision limit (${maxAttempts}) exceeded for '${name}'`);
      process.exit(1);
    }
  }

  if (!(await validateRefFormat(fullName))) {
    log.error(`could not produce valid branch name from '${storyKey}'`);
    process.exit(1);
  }

  log.out(name);
}

main().catch((e) => {
  log.error(e.message || String(e));
  process.exit(1);
});
