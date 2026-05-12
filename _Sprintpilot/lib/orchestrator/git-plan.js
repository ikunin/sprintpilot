// git-plan.js — produce an argv sequence for a git_op action.
//
// Given (state, profile, action), return:
//   { steps: [{ args, description, retry? }] }
//
// Pure. Argv-only — no shell strings. The CLI edge executes each step in
// order, halting on first failure. Steps are deterministic: same inputs
// always produce the same argv.

'use strict';

const { STATES } = require('./state-machine');

const STORY_BRANCH_RE = /^[a-z0-9][a-z0-9._-]*$/i;

function sanitizeStoryKey(key) {
  if (typeof key !== 'string') return null;
  // Per existing sanitize-branch.js: only allow [a-z0-9._-], lowercase.
  const s = key.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  if (!STORY_BRANCH_RE.test(s)) return null;
  return s;
}

function branchName(profile, storyKey, epicKey) {
  const prefix = 'story/';
  // git.granularity: 'story' (default) or 'epic'. Nano + large can be epic.
  if (profile.granularity === 'epic' && epicKey) {
    return `epic/${sanitizeStoryKey(epicKey) || 'unknown'}`;
  }
  const safe = sanitizeStoryKey(storyKey) || 'unknown';
  return `${prefix}${safe}`;
}

// commit_and_push_story — full sequence for STORY_DONE.
//   1. git add (specific files only — never -A / .)
//   2. git commit -m "<message>"
//   3. git push -u origin <branch>  (retried 4x with exponential backoff)
function plan(state, profile, action) {
  if (!action || !action.type || action.type !== 'git_op') {
    throw new Error('git-plan.plan: action.type must be git_op');
  }
  const op = action.op;
  const branch = branchName(profile, state.story_key, state.current_epic);

  switch (op) {
    case 'commit_and_push_story':
      return planCommitAndPush(state, profile, action, branch);
    case 'merge_epic':
      return planMergeEpic(state, profile, action, branch);
    case 'push':
      return planPush(state, profile, action, branch);
    case 'fetch':
      return planFetch(state, profile);
    case 'create_branch':
      return planCreateBranch(state, profile, branch);
    default:
      throw new Error(`git-plan.plan: unknown op ${op}`);
  }
}

function planCreateBranch(_state, profile, branch) {
  const baseBranch = profile.base_branch || 'main';
  return {
    branch,
    steps: [
      // Create branch from base; -B is idempotent (creates or resets).
      // But for new-story creation we want to fail if it already exists,
      // so use -b instead. The CLI edge can downgrade to -B on retry.
      {
        args: ['git', 'switch', '-c', branch, baseBranch],
        description: `create story branch ${branch} from ${baseBranch}`,
      },
    ],
  };
}

function planCommitAndPush(state, profile, action, branch) {
  const files = Array.isArray(action.files) && action.files.length > 0 ? action.files : null;
  const message =
    action.message ||
    (state.story_key
      ? `feat(${state.story_key}): ${state.ac_summary || 'story done'}`
      : 'feat: story done');

  const steps = [];
  if (files) {
    steps.push({
      args: ['git', 'add', ...files],
      description: `stage ${files.length} file(s) explicitly`,
    });
  } else {
    // No explicit file list provided. Add all tracked changes only — the
    // CLI edge should populate `files` from the LLM's success.output.
    // Fall back to `-u` which stages tracked modifications without picking
    // up untracked files (which might include secrets).
    steps.push({
      args: ['git', 'add', '-u'],
      description: 'stage tracked modifications only (no -A / .)',
    });
  }
  steps.push({
    args: ['git', 'commit', '-m', message],
    description: `commit on ${branch}`,
  });
  if (profile.has_origin !== false) {
    steps.push({
      args: ['git', 'push', '-u', 'origin', branch],
      description: `push ${branch} (retry 4× exponential backoff on network)`,
      retry: { attempts: 4, backoff_ms: [2000, 4000, 8000, 16000], on: 'network' },
    });
  }
  return { branch, steps };
}

function planMergeEpic(state, profile, _action, branch) {
  const baseBranch = profile.base_branch || 'main';
  const squash = !!profile.squash_on_merge;
  const steps = [];

  if (profile.has_origin !== false) {
    steps.push({ args: ['git', 'fetch', 'origin'], description: 'sync with remote' });
  }
  steps.push({ args: ['git', 'switch', baseBranch], description: `switch to ${baseBranch}` });
  if (profile.has_origin !== false) {
    steps.push({
      args: ['git', 'merge', '--ff-only', `origin/${baseBranch}`],
      description: 'fast-forward base to remote',
    });
  }
  if (squash) {
    steps.push({
      args: ['git', 'merge', '--squash', branch],
      description: `squash-merge ${branch}`,
    });
    steps.push({
      args: ['git', 'commit', '-m', `feat(${state.current_epic || 'epic'}): squash merge`],
      description: 'squash commit',
    });
  } else {
    steps.push({
      args: ['git', 'merge', '--no-ff', '-m', `Merge ${branch}`, branch],
      description: `non-ff merge ${branch}`,
    });
  }
  if (profile.has_origin !== false) {
    steps.push({
      args: ['git', 'push', 'origin', baseBranch],
      description: `push ${baseBranch}`,
      retry: { attempts: 4, backoff_ms: [2000, 4000, 8000, 16000], on: 'network' },
    });
  }
  return { branch, steps };
}

function planPush(_state, profile, _action, branch) {
  if (profile.has_origin === false) return { branch, steps: [] };
  return {
    branch,
    steps: [
      {
        args: ['git', 'push', '-u', 'origin', branch],
        description: `push ${branch}`,
        retry: { attempts: 4, backoff_ms: [2000, 4000, 8000, 16000], on: 'network' },
      },
    ],
  };
}

function planFetch(_state, profile) {
  if (profile.has_origin === false) return { branch: null, steps: [] };
  return {
    branch: null,
    steps: [{ args: ['git', 'fetch', 'origin'], description: 'fetch origin' }],
  };
}

module.exports = {
  plan,
  branchName,
  sanitizeStoryKey,
  STATES,
};
