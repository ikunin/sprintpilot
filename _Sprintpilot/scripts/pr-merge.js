#!/usr/bin/env node

// pr-merge — merge a PR/MR via the platform's preferred path. Used by the
// land_as_you_go workflow and the land-stack rescue tool.
//
// Output (JSON):
//   { "platform": "github", "pr": 123, "merged": true, "method": "merge",
//     "url": "https://...", "branchDeleted": true }
//   { "platform": "gitea", "pr": 7, "merged": false, "error": "..." }
//
// Exit codes:
//   0 — PR merged.
//   1 — invalid argv or unrecoverable error.
//   2 — platform unavailable; payload contains the reason in `skipped`.
//   3 — merge declined (CI red, requires approvals, etc.); payload contains
//       the reason in `error`.

const { parseArgs } = require('../lib/runtime/args');
const { tryRun } = require('../lib/runtime/spawn');
const { postJson } = require('../lib/runtime/http');
const {
  hasCli,
  extractOwnerRepo,
  redactAuth,
  authHeader,
  defaultBaseUrl,
  isKnownPlatform,
} = require('../lib/runtime/platform');
const log = require('../lib/runtime/log');

function emit(payload) {
  log.out(JSON.stringify(payload));
}

function help() {
  log.out(
    "Usage: pr-merge.js --platform <p> --pr <number> [--method merge|squash|rebase] [--delete-branch] [--base-url <url>] [--message 'commit msg']",
  );
}

const VALID_METHODS = ['merge', 'squash', 'rebase'];

async function mergeGithub({ pr, method, deleteBranch }) {
  if (!(await hasCli('gh'))) {
    return {
      platform: 'github',
      pr,
      merged: false,
      skipped: 'gh CLI not found',
    };
  }
  const flagFor = { merge: '--merge', squash: '--squash', rebase: '--rebase' };
  const args = ['pr', 'merge', String(pr), flagFor[method]];
  if (deleteBranch) args.push('--delete-branch');
  const r = await tryRun('gh', args, { timeoutMs: 60_000 });
  if (r.exitCode !== 0) {
    return {
      platform: 'github',
      pr,
      merged: false,
      method,
      error: `gh pr merge failed: ${(r.stderr || r.stdout || '').trim()}`,
    };
  }
  return {
    platform: 'github',
    pr,
    merged: true,
    method,
    branchDeleted: !!deleteBranch,
  };
}

async function mergeGitlabCli({ pr, method, deleteBranch }) {
  // glab's flags differ between methods. `--squash` exists; rebase merge
  // not directly exposed (use `glab mr rebase` first then merge instead).
  const args = ['mr', 'merge', String(pr), '--yes'];
  if (method === 'squash') args.push('--squash');
  if (deleteBranch) args.push('--remove-source-branch');
  const r = await tryRun('glab', args, { timeoutMs: 60_000 });
  if (r.exitCode !== 0) {
    return {
      platform: 'gitlab',
      pr,
      merged: false,
      method,
      error: `glab mr merge failed: ${(r.stderr || r.stdout || '').trim()}`,
    };
  }
  return {
    platform: 'gitlab',
    pr,
    merged: true,
    method,
    branchDeleted: !!deleteBranch,
  };
}

async function mergeGitlab({ pr, method, deleteBranch }) {
  if (!(await hasCli('glab'))) {
    return {
      platform: 'gitlab',
      pr,
      merged: false,
      skipped: 'glab CLI not found',
    };
  }
  if (method === 'rebase') {
    // Two-step: rebase first, then merge.
    const rebase = await tryRun('glab', ['mr', 'rebase', String(pr)], { timeoutMs: 60_000 });
    if (rebase.exitCode !== 0) {
      return {
        platform: 'gitlab',
        pr,
        merged: false,
        method,
        error: `glab mr rebase failed: ${(rebase.stderr || rebase.stdout || '').trim()}`,
      };
    }
  }
  return mergeGitlabCli({ pr, method, deleteBranch });
}

async function mergeGiteaRest({ pr, method, deleteBranch, baseUrl, message }) {
  const auth = authHeader('gitea');
  if (!auth || !baseUrl) {
    return {
      platform: 'gitea',
      pr,
      merged: false,
      skipped: 'GITEA_TOKEN + --base-url required for REST fallback',
    };
  }
  const ownerRepo = await extractOwnerRepo();
  if (!ownerRepo) {
    return {
      platform: 'gitea',
      pr,
      merged: false,
      error: 'could not parse owner/repo from origin remote',
    };
  }
  const apiBase = baseUrl.replace(/\/+$/, '');
  const giteaMethod = method === 'squash' ? 'squash' : method === 'rebase' ? 'rebase' : 'merge';
  const res = await postJson(
    `${apiBase}/api/v1/repos/${ownerRepo}/pulls/${pr}/merge`,
    {
      Do: giteaMethod,
      delete_branch_after_merge: !!deleteBranch,
      ...(message ? { MergeMessageField: message } : {}),
    },
    { headers: auth },
  );
  // Gitea returns 200 on success.
  if (res.statusCode < 200 || res.statusCode >= 300) {
    return {
      platform: 'gitea',
      pr,
      merged: false,
      method,
      error: `Gitea API ${res.statusCode}: ${redactAuth(res.body)}`,
    };
  }
  return {
    platform: 'gitea',
    pr,
    merged: true,
    method,
    branchDeleted: !!deleteBranch,
  };
}

async function mergeGitea(args) {
  // Prefer REST when token + base-url are available — `tea pr merge` lacks
  // a stable JSON output and doesn't expose squash/rebase options.
  if (process.env.GITEA_TOKEN && args.baseUrl) {
    return mergeGiteaRest(args);
  }
  if (await hasCli('tea')) {
    // tea takes `--style merge|squash|rebase|rebase-merge`. Without it,
    // squash/rebase are silently downgraded to a plain merge — caller asked
    // for X but got a merge-commit. Map our methods through.
    const styleMap = { merge: 'merge', squash: 'squash', rebase: 'rebase' };
    const style = styleMap[args.method] || 'merge';
    const cliArgs = ['pr', 'merge', String(args.pr), '--style', style];
    const r = await tryRun('tea', cliArgs, { timeoutMs: 60_000 });
    if (r.exitCode !== 0) {
      return {
        platform: 'gitea',
        pr: args.pr,
        merged: false,
        method: args.method,
        error: `tea pr merge failed: ${(r.stderr || r.stdout || '').trim()}`,
      };
    }
    return {
      platform: 'gitea',
      pr: args.pr,
      merged: true,
      method: args.method,
      // tea CLI doesn't expose branch-delete; caller handles that separately.
      branchDeleted: false,
    };
  }
  return mergeGiteaRest(args);
}

async function mergeBitbucket({ pr, method, deleteBranch, baseUrl, message }) {
  const auth = authHeader('bitbucket');
  if (!auth) {
    return {
      platform: 'bitbucket',
      pr,
      merged: false,
      skipped: 'BITBUCKET_TOKEN not set',
    };
  }
  const ownerRepo = await extractOwnerRepo();
  if (!ownerRepo) {
    return {
      platform: 'bitbucket',
      pr,
      merged: false,
      error: 'could not parse owner/repo from origin remote',
    };
  }
  const apiBase = (baseUrl || defaultBaseUrl('bitbucket')).replace(/\/+$/, '');
  const bbMethod =
    method === 'squash' ? 'squash' : method === 'rebase' ? 'fast_forward' : 'merge_commit';
  const res = await postJson(
    `${apiBase}/repositories/${ownerRepo}/pullrequests/${pr}/merge`,
    {
      // Atlassian's documented body shape uses `type: 'pullrequest'`; the
      // earlier `pullrequest_merge_parameters` we shipped is from older
      // JIRA-style examples and is rejected by the current Bitbucket
      // Cloud API.
      type: 'pullrequest',
      merge_strategy: bbMethod,
      close_source_branch: !!deleteBranch,
      ...(message ? { message } : {}),
    },
    { headers: auth },
  );
  if (res.statusCode < 200 || res.statusCode >= 300) {
    return {
      platform: 'bitbucket',
      pr,
      merged: false,
      method,
      error: `Bitbucket API ${res.statusCode}: ${redactAuth(res.body)}`,
    };
  }
  return {
    platform: 'bitbucket',
    pr,
    merged: true,
    method,
    branchDeleted: !!deleteBranch,
  };
}

async function main() {
  const { opts } = parseArgs(process.argv.slice(2), { booleanFlags: ['delete-branch'] });
  if (opts.help) {
    help();
    process.exit(0);
  }
  const platform = opts.platform;
  const pr = opts.pr;
  const method = opts.method || 'merge';
  const deleteBranch = !!opts['delete-branch'];
  const baseUrl = opts['base-url'];
  const message = opts.message;

  if (!isKnownPlatform(platform)) {
    log.error(`unknown or missing --platform '${platform || ''}'`);
    help();
    process.exit(1);
  }

  if (!VALID_METHODS.includes(method)) {
    log.error(`invalid --method '${method}': must be one of ${VALID_METHODS.join('|')}`);
    process.exit(1);
  }

  if (platform === 'git_only') {
    emit({ platform: 'git_only', pr, merged: false, skipped: 'git_only platform' });
    process.exit(2);
  }
  if (!pr) {
    log.error('--pr is required');
    process.exit(1);
  }

  let result;
  switch (platform) {
    case 'github':
      result = await mergeGithub({ pr, method, deleteBranch });
      break;
    case 'gitlab':
      result = await mergeGitlab({ pr, method, deleteBranch });
      break;
    case 'gitea':
      result = await mergeGitea({ pr, method, deleteBranch, baseUrl, message });
      break;
    case 'bitbucket':
      result = await mergeBitbucket({ pr, method, deleteBranch, baseUrl, message });
      break;
    default:
      log.error(`unknown platform '${platform}'`);
      process.exit(1);
  }

  emit(result);
  if (result.skipped) process.exit(2);
  if (result.error) process.exit(3);
}

module.exports = {
  VALID_METHODS,
  mergeGithub,
  mergeGitlab,
  mergeGitea,
  mergeBitbucket,
};

if (require.main === module) {
  main().catch((e) => {
    log.error(e.message || String(e));
    process.exit(1);
  });
}
