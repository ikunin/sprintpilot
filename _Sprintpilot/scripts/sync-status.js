#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { parseArgs } = require('../lib/runtime/args');
const {
  yamlSafe,
  hasStoryBlock,
  replaceStoryBlock,
  appendStoryBlock,
} = require('../lib/runtime/yaml-lite');
const log = require('../lib/runtime/log');

function help() {
  log.out('Usage: sync-status.js --story <key> --git-status-file <path> [git fields...]');
}

function atomicWrite(targetPath, content) {
  const dir = path.dirname(targetPath);
  if (dir && dir !== '.' && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Random suffix avoids collision between concurrent writers in the same ms.
  const suffix = crypto.randomBytes(4).toString('hex');
  const tmp = `${targetPath}.${process.pid}.${Date.now()}.${suffix}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, targetPath);
  } catch (e) {
    if (e.code === 'EXDEV') {
      // Cross-device rename (rare — bind mounts or the target path crossing
      // a mount boundary between its parent dir and the file itself). Since
      // we already have the full content in memory, skip the risky
      // copyFile-then-unlink dance (which isn't atomic — O_TRUNC can leave
      // the target truncated on failure) and just write the content
      // directly at the target.
      try {
        fs.writeFileSync(targetPath, content, 'utf8');
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* best effort */
        }
      }
      return;
    }
    // Any other error: clean up tmp so we don't leak cruft.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw e;
  }
}

function buildBlock(story, fields) {
  const lines = [`  ${story}:`];
  for (const { key, value, raw } of fields) {
    if (value === undefined || value === null || value === '') continue;
    if (raw) {
      lines.push(`    ${key}: ${value}`);
    } else {
      lines.push(`    ${key}: ${yamlSafe(value)}`);
    }
  }
  return lines.join('\n');
}

function buildHeader(baseBranch, platform) {
  return [
    '# Sprintpilot — Git Status',
    '# Tracks git metadata per story. Do not edit manually.',
    'git_integration:',
    '  enabled: true',
    `  base_branch: ${baseBranch || 'main'}`,
    `  platform: ${platform || ''}`,
    '',
    'stories:',
  ].join('\n');
}

function main() {
  const { opts } = parseArgs(process.argv.slice(2));
  if (opts.help) {
    help();
    process.exit(0);
  }

  const story = opts.story;
  const statusFile = opts['git-status-file'];

  if (!story || !statusFile) {
    log.error('--story and --git-status-file required');
    process.exit(1);
  }

  const branch = opts.branch;
  const worktree = opts.worktree;
  const storyCommit = opts.commit;
  const patchCommits = opts['patch-commits'];
  const pushStatus = opts['push-status'] || 'pending';
  const mergeStatus = opts['merge-status'];
  const prUrl = opts['pr-url'];
  const lintResult = opts['lint-result'];
  const platform = opts.platform;
  const baseBranch = opts['base-branch'] || 'main';
  // worktree-cleaned is a *tri-state*: unprovided means "don't touch prior
  // value", so we must NOT emit the field when the flag is absent. The
  // previous logic defaulted to 'false' and overwrote a prior 'true' every
  // call.
  const hasWorktreeCleaned = Object.hasOwn(opts, 'worktree-cleaned');
  let worktreeCleaned;
  if (hasWorktreeCleaned) {
    const v = opts['worktree-cleaned'];
    // Accept 'true'/'false' strings (any case) and boolean true.
    worktreeCleaned = v === true || String(v).toLowerCase() === 'true' ? 'true' : 'false';
  }

  const fields = [
    { key: 'branch', value: branch },
    { key: 'worktree', value: worktree },
    { key: 'story_commit', value: storyCommit },
    { key: 'patch_commits', value: patchCommits ? `[${patchCommits}]` : undefined, raw: true },
    { key: 'lint_result', value: lintResult },
    { key: 'push_status', value: pushStatus },
    { key: 'merge_status', value: mergeStatus },
    { key: 'pr_url', value: prUrl },
    { key: 'worktree_cleaned', value: worktreeCleaned, raw: true },
  ];

  const block = buildBlock(story, fields);
  const existing = fs.existsSync(statusFile) ? fs.readFileSync(statusFile, 'utf8') : '';

  let updated;
  if (!existing) {
    updated = `${buildHeader(baseBranch, platform)}\n${block}\n`;
  } else if (hasStoryBlock(existing, story)) {
    updated = replaceStoryBlock(existing, story, block);
  } else {
    updated = appendStoryBlock(existing, block);
  }

  atomicWrite(statusFile, updated);
  log.out(`OK:${story}:push=${pushStatus}`);
}

main();
