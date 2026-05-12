#!/usr/bin/env node

// land-this-pr.js — produce the argv sequence that lands the active PR
// from a stack snapshot. Land = merge into base + delete the local
// branch + rebase the rest of the stack.
//
// Reads a stack snapshot produced by stack-snapshot.js (--snapshot <path>),
// outputs an ordered list of git commands. Does NOT execute them — the
// orchestrator CLI runs each step through its retry/error pipeline.
//
// merge_strategy honors the active profile's squash_on_merge.

const fs = require('node:fs');
const path = require('node:path');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');

function help() {
  log.out(
    [
      'Usage: land-this-pr.js --snapshot <path> [--squash] [--base <name>]',
      '                       [--output <path>]',
      '',
      'Reads a stack snapshot, outputs an argv-step plan to land the active PR.',
    ].join('\n'),
  );
}

function buildPlan(snapshot, opts) {
  if (!snapshot || !snapshot.active_pr) {
    return { steps: [], skipped: true, reason: 'no active_pr in snapshot' };
  }
  const base = opts.base || snapshot.base_branch || 'main';
  const branch = snapshot.active_pr.branch;
  const squash = !!opts.squash;

  const steps = [];
  steps.push({ args: ['git', 'fetch', 'origin'], description: 'sync remote' });
  steps.push({ args: ['git', 'switch', base], description: `switch to ${base}` });
  steps.push({
    args: ['git', 'merge', '--ff-only', `origin/${base}`],
    description: 'ff base to remote',
  });
  if (squash) {
    steps.push({ args: ['git', 'merge', '--squash', branch], description: 'squash-merge' });
    steps.push({
      args: ['git', 'commit', '-m', `feat(${snapshot.active_pr.story_key}): land`],
      description: 'squash commit',
    });
  } else {
    steps.push({
      args: ['git', 'merge', '--no-ff', '-m', `Merge ${branch}`, branch],
      description: 'non-ff merge',
    });
  }
  steps.push({
    args: ['git', 'push', 'origin', base],
    description: `push ${base}`,
    retry: { attempts: 4, backoff_ms: [2000, 4000, 8000, 16000], on: 'network' },
  });
  steps.push({
    args: ['git', 'branch', '-d', branch],
    description: `delete local ${branch}`,
  });

  // Rebase the rest of the stack onto the new base.
  const rest = (snapshot.branches || []).filter((b) => b.name !== branch && b.status !== 'done');
  for (const b of rest) {
    steps.push({
      args: ['git', 'rebase', base, b.name],
      description: `rebase ${b.name} onto ${base}`,
    });
  }

  return { steps, skipped: false, branch, base, rebased: rest.map((b) => b.name) };
}

function main(argv) {
  const { opts } = parseArgs(argv, { booleanFlags: ['help', 'squash'] });
  if (opts.help) {
    help();
    return 0;
  }
  if (!opts.snapshot) {
    log.error('--snapshot <path> required');
    return 2;
  }
  let snap;
  try {
    snap = JSON.parse(fs.readFileSync(path.resolve(opts.snapshot), 'utf8'));
  } catch (e) {
    log.error(`snapshot read failed: ${e.message}`);
    return 1;
  }
  const plan = buildPlan(snap, opts);
  const text = `${JSON.stringify(plan, null, 2)}\n`;
  if (opts.output) {
    fs.writeFileSync(path.resolve(opts.output), text, 'utf8');
  } else {
    process.stdout.write(text);
  }
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, buildPlan };
