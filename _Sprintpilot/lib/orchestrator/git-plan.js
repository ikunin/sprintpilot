// git-plan.js — produce an argv sequence for a git_op action.
//
// Given (state, profile, action), return one of:
//   { branch, steps: [{ args, description, retry?, env?, ... }] }
//   { branch, steps: [], halt_action: { type: 'user_prompt', ... } }
//
// Step metadata fields honored by _Sprintpilot/scripts/run-step.js (and
// the LLM contract in workflow.orchestrator.md):
//   - args: string[]              argv (no shell interpolation)
//   - description: string         human-readable log line
//   - retry: { attempts, ... }    transient-failure retry policy
//   - env: { KEY: value }         step-scoped env overrides (used for
//                                 GH_HOST / GITLAB_URI on self-hosted)
//   - tolerate_exit_codes: [N]    non-zero codes treated as success
//   - optional: true              non-zero exit logged as warning, not
//                                 halting (used for best-effort fetches)
//
// `halt_action`: alternative plan shape used when the orchestrator can't
// emit executable steps for a given (platform, op) combination — e.g.
// MERGE_EPIC under bitbucket/gitea. decorateGitOp surfaces it as a
// top-level user_prompt action so the autopilot pauses for manual work.
//
// Argv-only — no shell strings. Mostly pure; the exceptions are:
//   - buildPrBody() reads profile.pr_template_path from disk (file
//     content is data, not control flow, so determinism holds when the
//     file content is fixed).
//   - planCreateBranch() is invoked after decorateGitOp probes git for
//     branch existence (the impurity lives in decorateGitOp, not here).
// Steps are deterministic given the same inputs.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { STATES } = require('./state-machine');

const STORY_BRANCH_RE = /^[a-z0-9][a-z0-9._-]*$/i;

function sanitizeStoryKey(key) {
  if (typeof key !== 'string') return null;
  // Per existing sanitize-branch.js: only allow [a-z0-9._-], lowercase.
  const s = key.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  if (!STORY_BRANCH_RE.test(s)) return null;
  return s;
}

// Truncate a branch name to `max` chars, appending `-<8-char hash>` so
// long story keys don't collide after truncation. 8 hex chars = 32 bits
// of entropy → ~65,000 truncated-stem variants before 50% collision
// odds per the birthday bound. Honors git's safe branch-name charset
// (no `/`, no shell metachars in the hash). Returns the input unchanged
// when under the limit, or when `max` is falsy.
const BRANCH_HASH_LEN = 8;
function truncateBranchName(branch, max) {
  if (!max || typeof max !== 'number' || branch.length <= max) return branch;
  const HASH_SUFFIX_LEN = BRANCH_HASH_LEN + 1; // `-` + hash chars
  if (max <= HASH_SUFFIX_LEN) {
    // Pathological config — fall back to the hash alone so we don't
    // produce an empty branch name.
    return crypto.createHash('sha1').update(branch).digest('hex').slice(0, max);
  }
  const hash = crypto.createHash('sha1').update(branch).digest('hex').slice(0, BRANCH_HASH_LEN);
  const keep = max - HASH_SUFFIX_LEN;
  // Trim any trailing separator so the joined name doesn't look like `foo--abc123`.
  const stem = branch.slice(0, keep).replace(/[-._]+$/, '');
  return `${stem}-${hash}`;
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
  // User-supplied branch: return verbatim. The user named that branch
  // deliberately and silently truncating it would break their mental
  // model + their `git push -u origin <name>` invocations.
  if (state && state.user_branch) return state.user_branch;
  const prefix = profile.branch_prefix || 'story/';
  // git.granularity: 'story' (default) or 'epic'. Nano + large can be epic.
  let name;
  if (profile.granularity === 'epic' && epicKey) {
    name = `${prefix}epic-${sanitizeStoryKey(epicKey) || 'unknown'}`;
  } else {
    const safe = sanitizeStoryKey(storyKey) || 'unknown';
    name = `${prefix}${safe}`;
  }
  // Honor git.max_branch_length (default 60). When the full branch name
  // exceeds the limit, truncate and append an 8-char hash so collisions
  // between similar story keys remain unique (32 bits of entropy).
  const max = profile.max_branch_length || 60;
  return truncateBranchName(name, max);
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
  const hasOrigin = profile.has_origin !== false;
  const steps = [];

  // Best-effort fetch so the new branch forks from the freshest base.
  // Non-blocking — `retry.on: 'network'` lets the runner ignore transient
  // failures. Skipped when there's no origin (local-only repo / tests).
  if (hasOrigin) {
    steps.push({
      args: ['git', 'fetch', 'origin', baseBranch],
      description: `fetch origin/${baseBranch} before branching`,
      retry: { attempts: 2, backoff_ms: [2000, 4000], on: 'network' },
      optional: true,
    });
  }

  // Branch already on disk (resume after partial failure, or second story
  // on an epic branch). Idempotent switch — never reset the branch from
  // base, since that would discard prior story work.
  if (state && state.branch_exists) {
    steps.push({
      args: ['git', 'switch', branch],
      description: `switch to existing branch ${branch} (already on disk)`,
    });
    return { branch, steps };
  }

  // Fresh story branch. `switch -c` fails if the branch exists; that is
  // intentional — the edge layer is responsible for probing and setting
  // `state.branch_exists` before we get here, so a collision here means
  // an unexpected race / stale state.
  steps.push({
    args: ['git', 'switch', '-c', branch, baseBranch],
    description: `create story branch ${branch} from ${baseBranch}`,
  });
  return { branch, steps };
}

function planCommitAndPush(state, profile, action, branch) {
  const files = Array.isArray(action.files) && action.files.length > 0 ? action.files : null;
  const message = action.message || buildStoryCommitMessage(state, profile);
  const baseBranch = profile.base_branch || 'main';
  const storyKey = state.story_key || 'sprint';
  const hasOrigin = profile.has_origin !== false;
  // Collected by buildPrBody when pr_template_path is configured but
  // unreadable. The edge layer (decorateGitOp) surfaces these via the
  // ledger so the failure is visible without writing to stderr from
  // inside a pure-ish plan function.
  const warnings = [];
  // push.auto: false → branches stay local. Both the story-branch push
  // and the base-branch push are suppressed; commits to base still happen
  // so `_bmad-output/` stays in sync locally, the user opts back in by
  // pushing manually.
  const pushAuto = profile.push_auto !== false;
  // push.create_pr: true + merge_strategy=stacked → open one PR per push.
  // Under granularity=story each push targets a unique branch → one PR per
  // story. Under granularity=epic every story pushes to the same epic
  // branch, so this step is called repeatedly but `create-pr.js` is
  // idempotent (it pre-checks `gh pr list --head` and short-circuits when
  // a PR already exists), giving us the documented "one PR per epic"
  // contract for free.
  //
  // The epic PR is later closed by MERGE_EPIC at the epic boundary; the
  // per-story PR (granularity=story) is closed by the user / external
  // automation. `land_as_you_go` opens its own PRs via land.js, so this
  // step is suppressed there.
  const granularity = profile.granularity || 'story';
  const createPr =
    profile.push_create_pr !== false &&
    (profile.merge_strategy || 'stacked') === 'stacked' &&
    hasOrigin &&
    pushAuto &&
    !profile.reuse_user_branch;

  // push.create_pr: false + merge_strategy=stacked + granularity=story →
  // direct-merge the story branch into base after pushing. Honors the
  // documented behavior in config.yaml#push.create_pr ("merge directly
  // to base after push"). Under granularity=epic the merge happens at
  // MERGE_EPIC instead — direct merge per story would merge incomplete
  // epic work to base on every story, which contradicts the epic
  // granularity contract.
  const directMerge =
    profile.push_create_pr === false &&
    (profile.merge_strategy || 'stacked') === 'stacked' &&
    granularity === 'story' &&
    hasOrigin &&
    pushAuto &&
    !profile.reuse_user_branch;

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
    // `--message=<msg>` form so a user-customized template producing a
    // leading `-` doesn't get parsed as a flag.
    args: ['git', 'commit', `--message=${message}`],
    description: `commit on ${branch}`,
  });
  if (hasOrigin && pushAuto) {
    steps.push({
      args: ['git', 'push', '-u', 'origin', branch],
      description: `push ${branch} (retry 4× exponential backoff on network)`,
      retry: { attempts: 4, backoff_ms: [2000, 4000, 8000, 16000], on: 'network' },
    });
  }

  // Open a PR for this story branch (one per branch under granularity=
  // story; idempotent under granularity=epic — see create-pr.js). Skipped
  // when push_create_pr=false, when push.auto=false (no remote ref to PR
  // from), when running land_as_you_go (land.js handles its own PR), or
  // when reuse_user_branch=true (one sprint-end PR, opened externally).
  if (createPr) {
    const prTitle = action.pr_title || message;
    const prBody = action.pr_body || buildPrBody(state, profile, state.project_root, warnings);
    const platform = profile.platform_provider || 'auto';
    const baseUrl = profile.platform_base_url || null;
    const prArgs = [
      'node',
      '_Sprintpilot/scripts/create-pr.js',
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
    if (baseUrl) prArgs.push('--base-url', baseUrl);
    steps.push({
      args: prArgs,
      description: `open PR for ${branch} → ${baseBranch} (idempotent — exits 0 if PR already exists)`,
      // create-pr.js may return exit 2 (SKIPPED — no CLI / git_only). Treat
      // that as success: the user opted into auto-PR but the platform CLI
      // isn't available, which is recoverable manually.
      tolerate_exit_codes: [0, 2],
    });
  }

  // Direct-merge mode (push.create_pr: false): merge the story branch
  // straight into base instead of opening a PR. The merge brings the
  // full story contents (code + _bmad-output) along, so Phase 2's
  // bmad-output-only sync is skipped. Returns to the story branch at
  // the end so subsequent stories under stacked can push again — even
  // though under granularity=story each story has its own branch and
  // won't be revisited.
  //
  // Conflict recovery: we use `git fetch` + `git merge --ff-only` rather
  // than `git pull --ff-only` so the failure mode is two distinct steps
  // (network vs. divergence) — the runner can retry the fetch but
  // surface the divergence as a user_prompt for manual rebase. There is
  // no automatic rebase recovery in direct-merge mode today; the user
  // owns reconciling a diverged base.
  if (directMerge) {
    const squash = !!profile.squash_on_merge;
    steps.push({
      args: ['git', 'switch', baseBranch],
      description: `switch to ${baseBranch} for direct merge`,
    });
    if (hasOrigin) {
      steps.push({
        args: ['git', 'fetch', 'origin', baseBranch],
        description: `fetch origin/${baseBranch} before merging`,
        retry: { attempts: 2, backoff_ms: [2000, 4000], on: 'network' },
        optional: true,
      });
      steps.push({
        args: ['git', 'merge', '--ff-only', `origin/${baseBranch}`],
        description: `fast-forward ${baseBranch} to origin (halts if base has diverged — manual rebase required)`,
      });
    }
    if (squash) {
      steps.push({
        args: ['git', 'merge', '--squash', branch],
        description: `squash-merge ${branch} into ${baseBranch}`,
      });
      // `--message=<msg>` form so a user-customized commit_template_story
      // that produces a leading `-` doesn't get interpreted as a flag.
      steps.push({
        args: ['git', 'commit', `--message=${message}`],
        description: `commit squash merge on ${baseBranch}`,
      });
    } else {
      // Same `--message=` form for the merge commit.
      steps.push({
        args: ['git', 'merge', '--no-ff', `--message=Merge ${branch}`, branch],
        description: `merge ${branch} into ${baseBranch} (no-ff)`,
      });
    }
    steps.push({
      args: ['git', 'push', 'origin', baseBranch],
      description: `push ${baseBranch}`,
      retry: { attempts: 4, backoff_ms: [2000, 4000, 8000, 16000], on: 'network' },
    });
    steps.push({
      args: ['git', 'switch', branch],
      description: `return to ${branch}`,
    });
    return { branch, steps, warnings: warnings.length ? warnings : undefined };
  }

  // Phase 2 — sync `_bmad-output/` to `<base_branch>`. BMad planning +
  // bookkeeping artifacts must land on main per story so `git log main`
  // is the canonical sprint audit trail. Without this, planning
  // artifacts, sprint-status, story files, and reviews exist only on
  // the story branch.
  //
  // Skipped entirely under direct-merge mode (push_create_pr=false): the
  // full merge into base already carries _bmad-output along, so a
  // dedicated docs-only commit would be redundant noise. Likewise
  // skipped under merge_strategy=land_as_you_go where land.js handles
  // the full merge.
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
    args: ['git', 'commit', '--allow-empty', `--message=docs(${storyKey}): BMad artifacts`],
    description: `commit BMad artifacts to ${baseBranch} (--allow-empty for no-diff stories)`,
  });
  if (hasOrigin && pushAuto) {
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

  return { branch, steps, warnings: warnings.length ? warnings : undefined };
}

// Build the story commit message from profile.commit_template_story with
// placeholders expanded. Placeholders:
//   {story-key}    — state.story_key
//   {epic}         — state.current_epic (derived from story_key when absent)
//   {story-title}  — state.ac_summary (BMad's acceptance-criteria summary)
//                    fallback to story_key
// Honors the config.yaml#commit_templates.story contract.
function buildStoryCommitMessage(state, profile) {
  const tmpl = (profile && profile.commit_template_story) || 'feat({epic}): {story-title} ({story-key})';
  const storyKey = state.story_key || 'sprint';
  const epic = state.current_epic || deriveEpicFromStoryKey(storyKey) || 'sprint';
  const title = state.ac_summary || state.story_title || storyKey;
  return expandTemplate(tmpl, { 'story-key': storyKey, epic, 'story-title': title });
}

// Expand `{placeholder}` tokens in `template` from `vars`. Function-form
// replacement so `$1`/`$&`/`$$` etc. in substituted values are treated
// as literal characters (string-form `.replace` would interpret them
// as regex backreferences and corrupt LLM-authored text like
// "Add $1 button"). Unknown placeholders are left as-is.
//
// Case-sensitive: `{story-key}` matches but `{Story-Key}` does not.
// vars is case-sensitive too, so mixed-case in templates would silently
// produce no expansion — make it explicit at the regex level instead.
function expandTemplate(template, vars) {
  if (typeof template !== 'string') return '';
  return template.replace(/\{([a-z][a-z0-9-]*)\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      return String(vars[key]);
    }
    return match;
  });
}

function deriveEpicFromStoryKey(storyKey) {
  if (typeof storyKey !== 'string') return null;
  const m = storyKey.match(/^(epic-[A-Za-z0-9_]+|[A-Za-z0-9_]+)-/);
  return m ? m[1] : null;
}

// Build the PR body. Precedence:
//   1. action.pr_body (caller override)  [handled by caller, not here]
//   2. profile.pr_template_path file contents (with placeholders expanded)
//   3. Minimal one-line default derived from state.
//
// The template file path is resolved relative to the project root (the
// directory git operates in). pr_template_path is configured in
// modules/git/config.yaml#push.pr_template (defaults to
// `modules/git/templates/pr-body.md`).
//
// Plain-text fallback only — argv is shell-safe today but downstream
// wrappers might pipe; defense in depth.
function buildPrBody(state, profile, projectRoot, warnings) {
  const storyKey = state.story_key || 'sprint';
  const title = state.ac_summary || storyKey;
  const profileName = (profile && profile.name) || 'medium';

  const tmplPath = profile && profile.pr_template_path;
  if (tmplPath && projectRoot) {
    // Resolve relative paths against the _Sprintpilot/ subtree per the
    // config convention. Absolute paths are used verbatim.
    const candidates = [];
    if (path.isAbsolute(tmplPath)) {
      candidates.push(tmplPath);
    } else {
      candidates.push(path.join(projectRoot, '_Sprintpilot', tmplPath));
      candidates.push(path.join(projectRoot, tmplPath));
    }
    for (const p of candidates) {
      try {
        const raw = fs.readFileSync(p, 'utf8');
        return expandTemplate(raw, {
          'story-key': storyKey,
          epic: state.current_epic || 'sprint',
          'story-title': title,
        });
      } catch (_e) {
        /* try next candidate */
      }
    }
    // Template configured but unreadable — record on the plan so the
    // edge layer can surface it (e.g. via ledger or stderr) without
    // git-plan.js itself touching stderr from a pure-ish function.
    // Tests can opt into asserting on these warnings; production
    // callers see them in the plan return value.
    if (warnings && Array.isArray(warnings)) {
      warnings.push(`pr_template_path "${tmplPath}" not found; using default body`);
    }
  }

  return `Story ${storyKey} — ${title}\n\nGenerated by Sprintpilot autopilot (profile: ${profileName}).`;
}

// planMergeEpic — closes out an epic branch at MERGE_EPIC.
//
// Two modes, chosen by profile.push_create_pr:
//   • push_create_pr=true (default): merge via the platform PR using
//     `gh pr merge <branch> --squash|--merge --delete-branch`. The PR
//     must already exist (planCommitAndPush opens one per push under
//     stacked + granularity=epic and the idempotency in create-pr.js
//     means subsequent pushes re-use it). Squash governed by
//     profile.squash_on_merge — true under nano + epic per config.yaml.
//   • push_create_pr=false: local merge sequence (existing behavior),
//     fast-forward base from remote first, then merge the epic branch
//     and push base.
//
// Both paths honor profile.squash_on_merge. The PR-merge path also
// requires profile.platform_provider; non-github platforms fall through
// to the local-merge sequence with a description note.
function planMergeEpic(state, profile, _action, branch) {
  const baseBranch = profile.base_branch || 'main';
  const squash = !!profile.squash_on_merge;
  const hasOrigin = profile.has_origin !== false;
  const usePr = profile.push_create_pr !== false;
  const platform = profile.platform_provider || 'auto';
  // Prefer the epic-specific knob; fall back to land_wait_minutes for
  // legacy configs that only set the land-as-you-go value.
  const waitMinutes = Number.isFinite(profile.epic_merge_wait_minutes)
    ? profile.epic_merge_wait_minutes
    : Number.isFinite(profile.land_wait_minutes)
      ? profile.land_wait_minutes
      : 30;

  // PR-merge path. Two sub-paths by platform.
  if (usePr && hasOrigin) {
    // Self-hosted instances: thread platform_base_url onto the merge
    // step as an `env` map so the platform CLI targets the right host.
    // gh reads `GH_HOST` and uses a per-host token from `~/.config/gh/`.
    // glab reads `GITLAB_URI` (also `GITLAB_HOST` for older versions).
    // The step runner (run-step.js + the LLM contract in
    // workflow.orchestrator.md) merges `env` into `process.env` for the
    // step's lifetime. Empty `env` is a no-op.
    const env = {};
    if (profile.platform_base_url) {
      try {
        const url = new URL(profile.platform_base_url);
        env.GH_HOST = url.host;
        env.GITLAB_URI = profile.platform_base_url;
      } catch (_e) {
        // Malformed base_url — leave env empty; the merge will use the
        // default host and the user will see a clear "wrong host" error.
      }
    }

    // github / auto: gh pr merge. The autopilot can't safely merge
    // before CI checks complete (branch protection would reject the
    // merge), so we prepend a `create-pr.js --mode checks` wait step
    // when CI gating is plausible. epic_merge_wait_minutes (default 30)
    // is the wait budget; falls back to land_wait_minutes for older
    // configs that only set the land knob.
    if (platform === 'github' || platform === 'auto') {
      const scriptPath = '_Sprintpilot/scripts/create-pr.js';
      const mergeFlag = squash ? '--squash' : '--merge';
      return {
        branch,
        steps: [
          {
            args: [
              'node',
              scriptPath,
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
            ],
            description: `wait for CI green on epic ${branch} (max ${waitMinutes}m)`,
            // SKIPPED (exit 2 — no gh CLI / no checks configured) is OK:
            // gh pr merge will surface any real blocker.
            tolerate_exit_codes: [0, 2],
            retry: { attempts: 1, on: 'never' },
            env: Object.keys(env).length ? env : undefined,
          },
          // Switch to base before delete-branch so gh isn't asked to
          // delete the currently-checked-out branch (which fails on
          // worktree setups). Safe under any setup: a switch back isn't
          // needed because the epic is done — next state is RETROSPECTIVE
          // or sprint finalize.
          {
            args: ['git', 'switch', baseBranch],
            description:
              `switch to ${baseBranch} so gh can delete the merged branch.` +
              ` Halts on dirty working tree or missing local ${baseBranch} — recover with` +
              ` \`git stash\` (uncommitted changes) or \`git fetch origin ${baseBranch}:${baseBranch}\`` +
              ` (no local copy), then resume autopilot.`,
          },
          {
            args: ['gh', 'pr', 'merge', branch, mergeFlag, '--delete-branch'],
            description: `merge epic PR for ${branch} via gh (${squash ? 'squash' : 'merge'}, delete branch)`,
            env: Object.keys(env).length ? env : undefined,
          },
        ],
      };
    }
    // gitlab: glab mr merge. The autopilot follows the same wait-then-
    // merge structure but skips the wait step (create-pr.js --mode
    // checks returns SKIPPED for gitlab today).
    if (platform === 'gitlab') {
      const glabArgs = ['glab', 'mr', 'merge', branch];
      if (squash) glabArgs.push('--squash');
      glabArgs.push('--remove-source-branch', '--yes');
      return {
        branch,
        steps: [
          {
            args: ['git', 'switch', baseBranch],
            description:
              `switch to ${baseBranch} before MR merge.` +
              ` Halts on dirty working tree or missing local ${baseBranch} — recover with` +
              ` \`git stash\` or \`git fetch origin ${baseBranch}:${baseBranch}\`, then resume.`,
          },
          {
            args: glabArgs,
            description: `merge epic MR for ${branch} via glab${squash ? ' (squash)' : ''}`,
            env: Object.keys(env).length ? env : undefined,
          },
        ],
      };
    }
    // bitbucket / gitea: no autopilot-supported merge CLI today. Emit a
    // user_prompt halt so the user can close the PR manually rather
    // than silently dropping back to local merge (which would bypass
    // the platform's review state).
    if (platform === 'bitbucket' || platform === 'gitea') {
      return {
        branch,
        // Special-cased: the runner sees a plan with `halt_action` and
        // empty `steps`. autopilot.js#decorateGitOp converts the
        // halt_action into a top-level user_prompt action; the LLM
        // gets the prompt and pauses.
        halt_action: {
          type: 'user_prompt',
          reason: 'epic_merge_unsupported_platform',
          // Resume guidance: the orchestrator's adapt.js for MERGE_EPIC
          // phase advances unconditionally on `status: success`, so
          // there's no structured output to include here. Keeping the
          // resume command minimal avoids implying any specific schema
          // contract that doesn't exist.
          prompt:
            `Auto-merging epic PRs on ${platform} is not yet supported.\n\n` +
            `Manual steps:\n` +
            `  1. Merge the PR for branch '${branch}' into '${baseBranch}' via your ${platform} UI.\n` +
            `  2. Delete the source branch (if your workflow normally does so).\n` +
            `  3. Resume by running: autopilot record --signal '{"status":"success"}'`,
          platform,
          branch,
          base_branch: baseBranch,
        },
        steps: [],
      };
    }
  }

  // Local-merge fallback. Used when push_create_pr=false, has_origin is
  // false (local-only repo), or platform is git_only.
  const steps = [];
  if (hasOrigin) {
    steps.push({ args: ['git', 'fetch', 'origin'], description: 'sync with remote' });
  }
  steps.push({ args: ['git', 'switch', baseBranch], description: `switch to ${baseBranch}` });
  if (hasOrigin) {
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
    // current_epic may originate from sprint-status.yaml / LLM signals —
    // sanitize before interpolating into a commit message argv element.
    // The sanitizer enforces the same [a-z0-9._-] charset used for
    // branch names; non-matching segments fall back to 'epic'.
    const safeEpic = sanitizeStoryKey(state.current_epic) || 'epic';
    steps.push({
      args: ['git', 'commit', `--message=feat(${safeEpic}): squash merge`],
      description: 'squash commit',
    });
  } else {
    steps.push({
      args: ['git', 'merge', '--no-ff', `--message=Merge ${branch}`, branch],
      description: `non-ff merge ${branch}`,
    });
  }
  if (hasOrigin) {
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
