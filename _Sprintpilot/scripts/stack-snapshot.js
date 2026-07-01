#!/usr/bin/env node

// stack-snapshot.js — capture a snapshot of the current per-story branch
// stack so `land-this-pr.js` can land the active PR without losing the
// rest of the in-flight stack.
//
// Output: JSON to stdout (or --output <path>). Shape:
//   {
//     base_branch: string,
//     ts: ISO,
//     branches: [{ name, head, story_key, status, parent? }],
//     active_pr: { branch, number?, story_key } | null,
//   }
//
// Argv-only. Uses `git -C <projectRoot>` for every git call.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');

function help() {
  log.out(
    [
      'Usage: stack-snapshot.js [--project-root <path>] [--base-branch <name>]',
      '                         [--output <file>] [--active-branch <name>]',
      '                         [--story-key <key>] [--pr-number <n>]',
    ].join('\n'),
  );
}

function git(projectRoot, args) {
  try {
    return execFileSync('git', ['-C', projectRoot, ...args], { encoding: 'utf8' }).trim();
  } catch (_e) {
    return null;
  }
}

function listLocalBranches(projectRoot, prefix) {
  const raw = git(projectRoot, [
    'for-each-ref',
    '--format=%(refname:short)\t%(objectname)',
    `refs/heads/${prefix}`,
  ]);
  if (!raw) return [];
  return raw
    .split(/\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, head] = line.split('\t');
      return { name, head };
    });
}

function readSprintStatus(projectRoot) {
  const p = path.join(
    projectRoot,
    '_bmad-output',
    'implementation-artifacts',
    'sprint-status.yaml',
  );
  if (!fs.existsSync(p)) return null;
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (_e) {
    return null;
  }
}

function statusForStory(sprintStatusText, storyKey) {
  if (!sprintStatusText) return 'unknown';
  // Narrow regex — accept either "story_key: status" or block form.
  // Escape the key so a metacharacter in it can't alter the pattern.
  const safeKey = storyKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- pattern built from a regex-escaped, trusted story key
  const re = new RegExp(`^\\s*${safeKey}:\\s*(\\w+)`, 'm');
  const m = sprintStatusText.match(re);
  return m ? m[1] : 'unknown';
}

function snapshot(opts) {
  const projectRoot = path.resolve(opts['project-root'] || process.cwd());
  const baseBranch = opts['base-branch'] || 'main';
  const branches = listLocalBranches(projectRoot, 'story/').map((b) => ({
    ...b,
    story_key: b.name.slice('story/'.length),
  }));
  const sprintStatus = readSprintStatus(projectRoot);
  for (const b of branches) {
    b.status = statusForStory(sprintStatus, b.story_key);
  }
  const active =
    opts['active-branch'] && opts['story-key']
      ? {
          branch: opts['active-branch'],
          story_key: opts['story-key'],
          number: opts['pr-number'] ? Number(opts['pr-number']) : undefined,
        }
      : null;
  return {
    base_branch: baseBranch,
    ts: new Date().toISOString(),
    branches,
    active_pr: active,
  };
}

function main(argv) {
  const { opts } = parseArgs(argv, { booleanFlags: ['help'] });
  if (opts.help) {
    help();
    return 0;
  }
  const snap = snapshot(opts);
  const out = `${JSON.stringify(snap, null, 2)}\n`;
  if (opts.output) {
    fs.writeFileSync(path.resolve(opts.output), out, 'utf8');
  } else {
    process.stdout.write(out);
  }
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, snapshot, statusForStory };
