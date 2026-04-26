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
  // Dedupe story keys — a duplicated key in --layer would otherwise
  // produce two entries pointing at the same worktree path and same
  // branch name, racing on `git worktree add`.
  const seen = new Set();
  const dedupedKeys = [];
  for (const k of keys) {
    if (seen.has(k)) continue;
    seen.add(k);
    dedupedKeys.push(k);
  }
  const effectiveParallel = Math.max(1, Math.min(maxParallel | 0, dedupedKeys.length));
  // CAP: only dispatch the first `effectiveParallel` stories. The
  // remaining keys are deferred — the autopilot loop will pick them up
  // in the next iteration after this batch completes. Pre-2.0.8 the
  // script created worktrees for ALL keys regardless of the cap, then
  // the workflow spawned N agents anyway, fully ignoring --max-parallel.
  const dispatchedKeys = dedupedKeys.slice(0, effectiveParallel);
  const deferredKeys = dedupedKeys.slice(effectiveParallel);
  const worktrees = dispatchedKeys.map((key) => ({
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
    deferred: deferredKeys,
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

// Match git's "branch already exists" diagnostic. We retry without -b
// only when the FIRST attempt failed for this specific reason —
// pre-2.0.8 the bare retry fired on ANY first-attempt failure and
// silently checked out whatever stale branch happened to exist at the
// requested name (e.g. last week's commits from an abandoned story).
const BRANCH_EXISTS_RE = /a branch named .* already exists/i;

function createWorktree({ projectRoot, worktree, branch, baseBranch }) {
  const args = ['worktree', 'add', worktree, '-b', branch];
  if (baseBranch) args.push(baseBranch);
  const first = spawnSync('git', ['-C', projectRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (first.status === 0) return { created: true, retried: false, stderr: first.stderr || '' };
  // Only retry without -b if git specifically reported the branch
  // already exists. Any other error (path collision, missing base
  // branch, dirty index, etc.) is propagated rather than masked.
  if (!BRANCH_EXISTS_RE.test(first.stderr || '')) {
    return {
      created: false,
      retried: false,
      stderr: first.stderr || '',
    };
  }
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

// After a worktree is created, disable gc.auto on it. The sequential
// path in workflow.md does this at line 738; pre-2.0.8 the parallel
// path skipped it, so concurrent sub-agents in heavy repos could
// trigger gc on each worktree mid-dispatch. Best-effort — never block
// dispatch on a config write.
function disableGcAutoOnWorktree(worktree) {
  spawnSync('git', ['-C', worktree, 'config', '--local', 'gc.auto', '0'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Roll back successful worktrees when a later create fails — leaves
// no orphaned worktrees on disk, no `.layer-plan.json` describing
// state that doesn't exist. Best-effort; rollback failures are logged
// but don't change the overall non-zero exit.
function rollbackWorktrees(projectRoot, created) {
  for (const entry of created) {
    const r = spawnSync(
      'git',
      ['-C', projectRoot, 'worktree', 'remove', '--force', entry.worktree],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (r.status !== 0) {
      log.warn(`failed to roll back worktree ${entry.worktree}: ${r.stderr || 'unknown'}`);
    }
  }
}

function dispatch({ keys, maxParallel, projectRoot, branchPrefix, baseBranch, dryRun }) {
  const plan = planLayer({ keys, maxParallel, projectRoot, branchPrefix, baseBranch });
  const results = {
    plan_file: null,
    effective_parallel: plan.effective_parallel,
    stories: [],
    deferred: plan.deferred,
    dry_run: !!dryRun,
  };
  if (dryRun) {
    results.stories = plan.stories.map((e) => ({
      story: e.story,
      worktree: e.worktree,
      branch: e.branch,
      created: false,
      retried: false,
      stderr: '(dry-run)',
    }));
    return results;
  }
  // Real dispatch. Track successful creates so we can roll them back if
  // a later create fails — leaving an orphan worktree + a plan file
  // claiming it succeeded was the v2.0.7 partial-failure bug.
  const succeeded = [];
  let failureIndex = -1;
  for (let i = 0; i < plan.stories.length; i++) {
    const entry = plan.stories[i];
    const out = createWorktree({
      projectRoot,
      worktree: entry.worktree,
      branch: entry.branch,
      baseBranch: entry.base_branch,
    });
    results.stories.push({
      story: entry.story,
      worktree: entry.worktree,
      branch: entry.branch,
      ...out,
    });
    if (out.created) {
      disableGcAutoOnWorktree(entry.worktree);
      succeeded.push(entry);
    } else {
      failureIndex = i;
      break; // stop creating; remaining keys are not attempted
    }
  }
  if (failureIndex !== -1) {
    rollbackWorktrees(projectRoot, succeeded);
    // Mark the previously-succeeded entries as rolled back so the
    // workflow doesn't think their worktrees still exist on disk.
    for (let i = 0; i < failureIndex; i++) {
      results.stories[i].rolled_back = true;
      results.stories[i].created = false;
    }
    // Mark untried-after-failure stories (the keys past failureIndex
    // that we never attempted) so the workflow can see what's missing.
    for (let i = failureIndex + 1; i < plan.stories.length; i++) {
      results.stories.push({
        story: plan.stories[i].story,
        worktree: plan.stories[i].worktree,
        branch: plan.stories[i].branch,
        created: false,
        retried: false,
        stderr: '(skipped — earlier dispatch failed)',
      });
    }
    // Do NOT write the plan file on partial failure — workflow.md
    // should never read a plan describing worktrees that don't exist.
    return results;
  }
  results.plan_file = writePlan(projectRoot, plan);
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
