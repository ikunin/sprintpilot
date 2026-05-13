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

// branchName(profile, storyKey, epicKey, state?)
//   When `state?.user_branch` is set (because git.reuse_user_branch=true and
//   the user pre-created a working branch), every story commits to that
//   single branch — per-story/per-epic branches are NOT created.
//   Otherwise honor profile.granularity for story/epic per-unit branches.
//
// Format matches the legacy workflow (see git/config.yaml:12 + the legacy
// workflow.md:685+716): `<branch_prefix>epic-<epic_id>` for epic granularity
// and `<branch_prefix><story_key>` for story granularity. The default prefix
// is "story/", so under nano you get `story/epic-1` (not `epic/1`) — that's
// what the existing tooling and e2e tests expect.
function branchName(profile, storyKey, epicKey, state) {
  if (state && state.user_branch) return state.user_branch;
  const prefix = profile.branch_prefix || 'story/';
  // git.granularity: 'story' (default) or 'epic'. Nano + large can be epic.
  if (profile.granularity === 'epic' && epicKey) {
    return `${prefix}epic-${sanitizeStoryKey(epicKey) || 'unknown'}`;
  }
  const safe = sanitizeStoryKey(storyKey) || 'unknown';
  return `${prefix}${safe}`;
}

// commit_and_push_story — full sequence for STORY_DONE.
//   Phase 1 — commit + push the story branch (code lives here):
//     1. git add (specific files only — never -A / .)
//     2. git commit -m "<message>"
//     3. git push -u origin <branch>  (retried 4x with exponential backoff)
//   Phase 2 — sync `_bmad-output/` to <base_branch> (BMad artifacts live
//   on main so `git log main` is the canonical sprint audit trail):
//     4. git switch <base_branch>
//     5. git checkout <branch> -- _bmad-output
//     6. git add _bmad-output
//     7. git commit --allow-empty -m "docs(<story>): BMad artifacts"
//     8. git push origin <base_branch>  (retried 4x)
//     9. git switch <branch>            (return to story for next phase)
//   --allow-empty on step 7 covers multi-story sprints where _bmad-output/
//   on main already matches the story-branch version (e.g. epics.md was
//   authored during story 1, unchanged for story 2). The empty commit is
//   audit-trail noise but cheap.
function plan(state, profile, action) {
  if (!action || !action.type || action.type !== 'git_op') {
    throw new Error('git-plan.plan: action.type must be git_op');
  }
  const op = action.op;
  const branch = branchName(profile, state.story_key, state.current_epic, state);

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

function planCreateBranch(state, profile, branch) {
  // Branch reuse: when the user pre-created the branch, do not create a
  // new one. Just confirm HEAD is on the right branch (idempotent switch).
  if (state && state.user_branch) {
    return {
      branch,
      steps: [
        {
          args: ['git', 'switch', branch],
          description: `switch to user branch ${branch} (reuse mode)`,
        },
      ],
    };
  }
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
  const baseBranch = profile.base_branch || 'main';
  const storyKey = state.story_key || 'sprint';
  const hasOrigin = profile.has_origin !== false;

  const steps = [];

  // Phase 1 — commit + push the story branch (code lives here).
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
  if (hasOrigin) {
    steps.push({
      args: ['git', 'push', '-u', 'origin', branch],
      description: `push ${branch} (retry 4× exponential backoff on network)`,
      retry: { attempts: 4, backoff_ms: [2000, 4000, 8000, 16000], on: 'network' },
    });
  }

  // Phase 2 — sync `_bmad-output/` to `<base_branch>`. The legacy workflow
  // (workflow.legacy.md.bak:927–931) commits BMad planning + bookkeeping
  // artifacts to main after every planning skill; the orchestrator does
  // the same once per story at STORY_DONE. Without this, planning
  // artifacts, sprint-status, story files, and reviews exist only on the
  // story branch and `git log main` is empty of sprint history.
  steps.push({
    args: ['git', 'switch', baseBranch],
    description: `switch to ${baseBranch} to sync BMad artifacts`,
  });
  steps.push({
    args: ['git', 'checkout', branch, '--', '_bmad-output'],
    description: `bring _bmad-output/ from ${branch} into ${baseBranch}'s working tree`,
  });
  steps.push({
    args: ['git', 'add', '_bmad-output'],
    description: 'stage BMad artifacts',
  });
  steps.push({
    args: ['git', 'commit', '--allow-empty', '-m', `docs(${storyKey}): BMad artifacts`],
    description: `commit BMad artifacts to ${baseBranch} (--allow-empty for no-diff stories)`,
  });
  if (hasOrigin) {
    steps.push({
      args: ['git', 'push', 'origin', baseBranch],
      description: `push ${baseBranch}`,
      retry: { attempts: 4, backoff_ms: [2000, 4000, 8000, 16000], on: 'network' },
    });
  }
  steps.push({
    args: ['git', 'switch', branch],
    description: `return to ${branch} for the next phase`,
  });

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
