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
//   options.prTitle / options.prBody → PR metadata for create-pr.js --mode create.
//                                       Required so STORY_LAND can open its own
//                                       PR (planCommitAndPush skips PR creation
//                                       under merge_strategy=land_as_you_go).
//   options.platformBaseUrl          → optional; forwarded via --base-url for
//                                       on-prem GitLab/Bitbucket/Gitea.
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
  const platform = profile.platform_provider || options.platform || 'auto';
  const baseUrl = profile.platform_base_url || options.platformBaseUrl || null;

  const stackSnapshot = path.join(options.scriptsDir, 'stack-snapshot.js');
  const landThisPr = path.join(options.scriptsDir, 'land-this-pr.js');
  const createPr = path.join(options.scriptsDir, 'create-pr.js');

  const steps = [];

  // Step 0: open the PR if it doesn't exist yet. Under
  // merge_strategy=land_as_you_go, planCommitAndPush deliberately skips
  // PR creation (its createPr gate requires merge_strategy=stacked),
  // leaving STORY_LAND as the place to open the PR. Without this step,
  // the `--mode checks` polling below has no PR to poll against and
  // exits non-zero — the symptom users hit was "branches push, PRs
  // never open, autopilot needs to be unstuck". create-pr.js is
  // idempotent (gh pr list --head short-circuits when a PR exists), so
  // this step is safe to always run. tolerate_exit_codes [0, 2] matches
  // the stacked-mode path so a missing platform CLI degrades to a SKIP
  // rather than halting the land sequence.
  const prTitle = options.prTitle || `${state.story_key}`;
  const prBody = options.prBody || `Auto-opened by Sprintpilot STORY_LAND for ${state.story_key}.`;
  const createPrArgs = [
    'node',
    createPr,
    '--mode',
    'create',
    '--platform',
    platform,
    '--branch',
    branch,
    '--base',
    baseBranch,
    '--title',
    prTitle,
    '--body',
    prBody,
  ];
  if (baseUrl) createPrArgs.push('--base-url', baseUrl);
  steps.push({
    args: createPrArgs,
    description: `open PR for ${branch} → ${baseBranch} (idempotent — exits 0 if PR already exists)`,
    tolerate_exit_codes: [0, 2],
  });

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

  // Step 2: wait for CI / review depending on land_when. Honors
  // git.platform.provider (forwarded via --platform) so non-github
  // providers route to the correct CLI / API path inside create-pr.js.
  if (landWhen === 'ci_pass' || landWhen === 'ci_and_review') {
    const checkArgs = [
      'node',
      createPr,
      '--mode',
      'checks',
      '--platform',
      platform,
      '--branch',
      branch,
      '--base',
      baseBranch,
      '--wait-minutes',
      String(waitMinutes),
    ];
    if (baseUrl) {
      checkArgs.push('--base-url', baseUrl);
    }
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
