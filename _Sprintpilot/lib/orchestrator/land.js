// land.js — orchestrator helper for `merge_strategy: land_as_you_go`.
//
// This module composes existing scripts (stack-snapshot.js +
// land-this-pr.js) into a step plan the autopilot CLI executes after
// STORY_DONE. It does NOT define a BMad workflow — BMad's domain is
// story creation, dev, review, retrospective. This is orchestrator
// plumbing for the git layer.
//
// Pure: planLand(state, profile) → { steps, blocking_user_prompt? }
//
// Step shape mirrors git-plan.js: { args, description, retry? }. The CLI
// executes steps sequentially via execFileSync.

'use strict';

const path = require('node:path');

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// planLand(state, profile, options) → { steps, halt?, prompt? }
//   state.user_branch / state.story_key / state.current_epic → branch identity
//   profile.land_when                → no_wait | ci_pass | ci_and_review
//   profile.land_wait_minutes        → polling budget
//   profile.squash_on_merge          → forwarded to land-this-pr.js
//   options.scriptsDir               → absolute path to _Sprintpilot/scripts
//   options.snapshotPath             → tmp file path the snapshot will be written to
//   options.branch                   → resolved branch name (from git-plan.branchName)
//   options.platform                 → 'github' | 'gitlab' | 'git_only'
function planLand(state, profile, options) {
  if (!state || !state.story_key) {
    throw new Error('planLand: state.story_key required');
  }
  if (!profile) throw new Error('planLand: profile required');
  if (!options || !options.scriptsDir || !options.snapshotPath) {
    throw new Error('planLand: options.scriptsDir + snapshotPath required');
  }

  const branch = options.branch;
  if (!branch) throw new Error('planLand: options.branch required');

  const baseBranch = profile.base_branch || 'main';
  const landWhen = profile.land_when || 'ci_pass';
  const waitMinutes = Number.isFinite(profile.land_wait_minutes) ? profile.land_wait_minutes : 30;
  const squash = !!profile.squash_on_merge;

  const stackSnapshot = path.join(options.scriptsDir, 'stack-snapshot.js');
  const landThisPr = path.join(options.scriptsDir, 'land-this-pr.js');
  const createPr = path.join(options.scriptsDir, 'create-pr.js');

  const steps = [];

  // Step 1: capture the current stack snapshot so land-this-pr can reason
  // about the active PR + remaining branches.
  steps.push({
    args: [
      'node',
      stackSnapshot,
      '--project-root',
      options.projectRoot || '.',
      '--base-branch',
      baseBranch,
      '--active-branch',
      branch,
      '--story-key',
      state.story_key,
      '--output',
      options.snapshotPath,
    ],
    description: `snapshot stack for ${branch}`,
  });

  // Step 2: wait for CI / review depending on land_when.
  if (landWhen === 'ci_pass' || landWhen === 'ci_and_review') {
    const checkArgs = [
      'node',
      createPr,
      '--mode',
      'checks',
      '--branch',
      branch,
      '--wait-minutes',
      String(waitMinutes),
    ];
    if (landWhen === 'ci_and_review') {
      checkArgs.push('--require-approved-review');
    }
    steps.push({
      args: checkArgs,
      description: `wait for ${landWhen === 'ci_and_review' ? 'CI green + approved review' : 'CI green'} (max ${waitMinutes}m)`,
      retry: { attempts: 1, on: 'never' },
    });
  }

  // Step 3: generate the merge plan via land-this-pr.js.
  const landArgs = [
    'node',
    landThisPr,
    '--snapshot',
    options.snapshotPath,
    '--base',
    baseBranch,
  ];
  if (squash) landArgs.push('--squash');
  steps.push({
    args: landArgs,
    description: `land PR for ${branch} onto ${baseBranch}${squash ? ' (squash)' : ''}`,
  });

  return { steps, branch, base: baseBranch, land_when: landWhen };
}

// planRebaseRecovery(state, profile, options) → { steps }
//   Called when a land step hits `git merge --ff-only` failure. Attempts
//   an auto-rebase of the story branch onto latest origin/<base>; on
//   rebase conflict the CLI emits a user_prompt halt (caller's job).
function planRebaseRecovery(state, profile, options) {
  if (!options || !options.branch) throw new Error('planRebaseRecovery: branch required');
  const baseBranch = profile.base_branch || 'main';
  return {
    steps: [
      { args: ['git', 'fetch', 'origin'], description: 'fetch latest base' },
      {
        args: ['git', 'rebase', `origin/${baseBranch}`, options.branch],
        description: `rebase ${options.branch} onto origin/${baseBranch}`,
      },
    ],
    on_conflict: {
      type: 'user_prompt',
      reason: 'rebase_conflict',
      prompt: `Rebase conflict on ${options.branch} against origin/${baseBranch}. Resolve manually then resume autopilot — it will retry the land step.`,
    },
  };
}

// Classify a stderr blob from `git rebase` / `git merge` as a conflict or
// a transient/other failure. Used by the CLI to decide whether to halt
// or to retry.
function isRebaseConflict(stderrText) {
  if (typeof stderrText !== 'string') return false;
  const conflictMarkers = [
    /^CONFLICT \(.*\):/m,
    /\bAutomatic merge failed; fix conflicts/i,
    /\bCould not apply/i,
  ];
  return conflictMarkers.some((re) => re.test(stderrText));
}

module.exports = {
  planLand,
  planRebaseRecovery,
  isRebaseConflict,
  escapeRe,
};
