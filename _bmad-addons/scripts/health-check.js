#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { parseArgs } = require('../lib/runtime/args');
const { tryGit, tryGitStdout } = require('../lib/runtime/git');
const { readStoryField } = require('../lib/runtime/yaml-lite');
const log = require('../lib/runtime/log');

function help() {
  log.out('Usage: health-check.js [--worktrees-dir path] [--base-branch main] [--status-file path]');
}

async function main() {
  const { opts } = parseArgs(process.argv.slice(2));
  if (opts.help) { help(); process.exit(0); }
  const worktreesDir = opts['worktrees-dir'] || '.worktrees';
  const baseBranch = opts['base-branch'] || 'main';
  const statusFile = opts['status-file'] || '';

  if (!fs.existsSync(worktreesDir) || !fs.statSync(worktreesDir).isDirectory()) {
    log.out('SUMMARY:0:0:0:0:0:0');
    return;
  }

  // Fetch remote to ensure accurate ahead-behind comparison.
  const hasRemote = await tryGitStdout(['remote', 'get-url', 'origin']);
  if (hasRemote) {
    const fetched = await tryGit(['fetch', 'origin']);
    if (fetched.exitCode !== 0) log.err('WARN: git fetch failed');
  } else {
    log.err("WARN: no 'origin' remote configured — commit comparison may be inaccurate");
  }

  let total = 0, cleanDone = 0, committed = 0, stale = 0, dirty = 0, orphan = 0;

  const statusText = statusFile && fs.existsSync(statusFile)
    ? fs.readFileSync(statusFile, 'utf8')
    : null;

  const entries = fs.readdirSync(worktreesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory());

  for (const entry of entries) {
    const wt = path.join(worktreesDir, entry.name);
    const name = entry.name;
    total++;

    const gitDirCheck = await tryGit(['-C', wt, 'rev-parse', '--git-dir']);
    if (gitDirCheck.exitCode !== 0) {
      log.out(`ORPHAN:${name}`);
      orphan++;
      continue;
    }

    const branch = await tryGitStdout(['-C', wt, 'branch', '--show-current']);
    if (!branch) {
      log.out(`ORPHAN:${name}`);
      orphan++;
      continue;
    }

    const statusOut = await tryGitStdout(['-C', wt, 'status', '--porcelain']);
    if (statusOut && statusOut.length > 0) {
      log.out(`DIRTY:${name}`);
      dirty++;
      continue;
    }

    if (statusText) {
      const storyStatus = readStoryField(statusText, name, 'status');
      if (storyStatus === 'done') {
        log.out(`CLEAN_DONE:${name}`);
        cleanDone++;
        continue;
      }
    }

    const ahead = await tryGitStdout(['log', '--oneline', `origin/${baseBranch}..${branch}`]);
    const count = ahead ? ahead.split(/\r?\n/).filter(Boolean).length : 0;
    if (count > 0) {
      log.out(`COMMITTED:${name}:${count}_commits`);
      committed++;
    } else {
      log.out(`STALE:${name}`);
      stale++;
    }
  }

  log.out(`SUMMARY:${total}:${cleanDone}:${committed}:${stale}:${dirty}:${orphan}`);
}

main().catch((e) => {
  log.error(e.message || String(e));
  process.exit(1);
});
