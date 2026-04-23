#!/usr/bin/env node

// dispatch-layer.js — orchestrator for parallel intra-epic story execution.
//
// Usage:
//   dispatch-layer.js --layer <key,key,...> [--max-parallel <n>]
//                     [--project-root <path>] [--branch-prefix <str>]
//                     [--base-branch <br>] [--dry-run]
//
// Responsibilities:
//   1. For each story in --layer (respecting --max-parallel concurrency),
//      create the story's worktree and branch. Worktree creation itself
//      happens synchronously (cheap after PR 10); actual sub-agent spawn
//      is delegated to the host agent via a plan file the host reads.
//   2. Emit a plan.json to the project at
//        _bmad-output/implementation-artifacts/.layer-plan.json
//      that the host workflow then consumes — invoking N sub-agents, one
//      per story, pointing each at its worktree + branch.
//   3. When the host reports back (all sub-agents complete), the top-level
//      workflow invokes `merge-shards.js --archive --layer <id>` to merge
//      each story's state shard into the authoritative project YAML.
//
// This script itself does NOT call an LLM. Host-specific multi-agent
// dispatch is up to workflow.md (gated on agent-adapter.js's confidence).

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');

const STORY_RE = /^[a-z0-9][a-z0-9-]*$/;
const PLAN_FILENAME = '.layer-plan.json';

function help() {
  log.out(
    [
      'Usage:',
      '  dispatch-layer.js --layer <key,key,...> [options]',
      '',
      'Options:',
      '  --max-parallel N    Upper bound on concurrent sub-agents (default 2).',
      '  --project-root P    Defaults to cwd.',
      '  --branch-prefix S   Branch name prefix (default story/).',
      '  --base-branch B     Branch point (default main).',
      '  --dry-run           Compute the plan but do not create worktrees.',
    ].join('\n'),
  );
}

function parseLayer(raw) {
  if (!raw) return { ok: false, error: '--layer is required' };
  const keys = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  for (const k of keys) {
    if (!STORY_RE.test(k)) {
      return { ok: false, error: `invalid story key '${k}': must match ${STORY_RE}` };
    }
  }
  if (keys.length === 0) {
    return { ok: false, error: '--layer must contain at least one story key' };
  }
  return { ok: true, value: keys };
}

function planLayer({ keys, maxParallel, projectRoot, branchPrefix, baseBranch }) {
  const effectiveParallel = Math.max(1, Math.min(maxParallel | 0, keys.length));
  const worktrees = keys.map((key) => ({
    story: key,
    worktree: path.join(projectRoot, '.worktrees', key),
    branch: `${branchPrefix}${key}`,
    base_branch: baseBranch,
  }));
  return {
    version: 1,
    created_at: new Date().toISOString(),
    effective_parallel: effectiveParallel,
    max_parallel: maxParallel,
    stories: worktrees,
  };
}

function writePlan(projectRoot, plan) {
  const dir = path.join(projectRoot, '_bmad-output', 'implementation-artifacts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, PLAN_FILENAME);
  const tmp = `${file}.tmp.${process.pid}.${process.hrtime.bigint().toString(36)}`;
  fs.writeFileSync(tmp, JSON.stringify(plan, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

function createWorktree({ projectRoot, worktree, branch, baseBranch }) {
  // Try -b first, fall back to checkout-existing-branch if already present.
  const args = ['worktree', 'add', worktree, '-b', branch];
  if (baseBranch) args.push(baseBranch);
  const first = spawnSync('git', ['-C', projectRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (first.status === 0) return { created: true, retried: false, stderr: first.stderr || '' };
  // Retry without -b (branch exists).
  const second = spawnSync(
    'git',
    ['-C', projectRoot, 'worktree', 'add', worktree, branch],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return {
    created: second.status === 0,
    retried: true,
    stderr: (first.stderr || '') + (second.stderr || ''),
  };
}

function dispatch({ keys, maxParallel, projectRoot, branchPrefix, baseBranch, dryRun }) {
  const plan = planLayer({ keys, maxParallel, projectRoot, branchPrefix, baseBranch });
  const results = {
    plan_file: null,
    effective_parallel: plan.effective_parallel,
    stories: [],
    dry_run: !!dryRun,
  };
  if (!dryRun) {
    for (const entry of plan.stories) {
      const out = createWorktree({
        projectRoot,
        worktree: entry.worktree,
        branch: entry.branch,
        baseBranch: entry.base_branch,
      });
      results.stories.push({ story: entry.story, worktree: entry.worktree, branch: entry.branch, ...out });
    }
    results.plan_file = writePlan(projectRoot, plan);
  } else {
    results.stories = plan.stories.map((e) => ({
      story: e.story,
      worktree: e.worktree,
      branch: e.branch,
      created: false,
      retried: false,
      stderr: '(dry-run)',
    }));
  }
  return results;
}

function main() {
  const { opts } = parseArgs(process.argv.slice(2), { booleanFlags: ['dry-run'] });
  if (opts.help) {
    help();
    process.exit(0);
  }
  const layer = parseLayer(opts.layer);
  if (!layer.ok) {
    log.error(layer.error);
    process.exit(1);
  }
  const maxParallel = opts['max-parallel'] !== undefined ? Number.parseInt(String(opts['max-parallel']), 10) : 2;
  if (Number.isNaN(maxParallel) || maxParallel < 1) {
    log.error(`invalid --max-parallel '${opts['max-parallel']}': must be a positive integer`);
    process.exit(1);
  }
  const projectRoot = opts['project-root'] || process.cwd();
  const branchPrefix = opts['branch-prefix'] !== undefined ? String(opts['branch-prefix']) : 'story/';
  const baseBranch = opts['base-branch'] !== undefined ? String(opts['base-branch']) : 'main';
  const dryRun = opts['dry-run'] === true;

  const result = dispatch({
    keys: layer.value,
    maxParallel,
    projectRoot,
    branchPrefix,
    baseBranch,
    dryRun,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  const allCreated = dryRun || result.stories.every((s) => s.created);
  process.exit(allCreated ? 0 : 1);
}

module.exports = {
  STORY_RE,
  PLAN_FILENAME,
  parseLayer,
  planLayer,
  writePlan,
  dispatch,
};

if (require.main === module) {
  main();
}
