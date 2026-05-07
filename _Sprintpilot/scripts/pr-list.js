#!/usr/bin/env node

// pr-list — emit a normalized JSON list of open PRs/MRs across all four
// supported platforms. Used by the stack-health snapshot (sync-status.js
// --stack-snapshot) and by the `sprintpilot land-stack` rescue tool.
//
// Output (always JSON to stdout):
//   {
//     "platform": "github",
//     "prs": [
//       {
//         "number": 123,
//         "sourceBranch": "story/1-1",
//         "targetBranch": "main",
//         "state": "open",
//         "url": "https://github.com/x/y/pull/123",
//         "mergeable": "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | null,
//         "mergeStateStatus": "CLEAN" | "DIRTY" | "BLOCKED" | "UNKNOWN" | null
//       }
//     ]
//   }
//
// Exit codes:
//   0 — success.
//   1 — invalid argv or unrecoverable error.
//   2 — platform unavailable (no CLI, no token); stdout still contains
//       `{ "platform": ..., "prs": [], "skipped": "..." }` so callers can
//       degrade gracefully.

const { parseArgs } = require('../lib/runtime/args');
const { tryRun } = require('../lib/runtime/spawn');
const { getJson } = require('../lib/runtime/http');
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
    'Usage: pr-list.js --platform <github|gitlab|bitbucket|gitea|git_only> [--state open|all] [--branch-prefix <prefix>] [--base-url <url>]',
  );
}

function filterByPrefix(prs, branchPrefix) {
  if (!branchPrefix) return prs;
  return prs.filter((pr) => (pr.sourceBranch || '').startsWith(branchPrefix));
}

async function listGithub({ state, branchPrefix }) {
  if (!(await hasCli('gh'))) {
    return {
      platform: 'github',
      prs: [],
      skipped: 'gh CLI not found; install gh or skip this step',
    };
  }
  const r = await tryRun(
    'gh',
    [
      'pr',
      'list',
      '--state',
      state,
      '--limit',
      '100',
      '--json',
      'number,headRefName,baseRefName,state,url,mergeable,mergeStateStatus',
    ],
    { timeoutMs: 30_000 },
  );
  if (r.exitCode !== 0) {
    return {
      platform: 'github',
      prs: [],
      error: `gh pr list failed: ${(r.stderr || r.stdout || '').trim()}`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    return {
      platform: 'github',
      prs: [],
      error: `gh pr list emitted non-JSON: ${e.message}`,
    };
  }
  const prs = (parsed || []).map((p) => ({
    number: p.number,
    sourceBranch: p.headRefName,
    targetBranch: p.baseRefName,
    state: (p.state || '').toLowerCase(),
    url: p.url,
    mergeable: p.mergeable || null,
    mergeStateStatus: p.mergeStateStatus || null,
  }));
  return { platform: 'github', prs: filterByPrefix(prs, branchPrefix) };
}

async function listGitlab({ state, branchPrefix }) {
  if (!(await hasCli('glab'))) {
    return {
      platform: 'gitlab',
      prs: [],
      skipped: 'glab CLI not found; install glab or skip this step',
    };
  }
  const stateMap = { open: 'opened', all: 'all', closed: 'closed' };
  const r = await tryRun(
    'glab',
    ['mr', 'list', '--state', stateMap[state] || 'opened', '--output', 'json'],
    { timeoutMs: 30_000 },
  );
  if (r.exitCode !== 0) {
    return {
      platform: 'gitlab',
      prs: [],
      error: `glab mr list failed: ${(r.stderr || r.stdout || '').trim()}`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    return {
      platform: 'gitlab',
      prs: [],
      error: `glab mr list emitted non-JSON: ${e.message}`,
    };
  }
  // GitLab merge_status: can_be_merged | cannot_be_merged | unchecked.
  const mapMergeable = (m) => {
    if (m === 'can_be_merged') return 'MERGEABLE';
    if (m === 'cannot_be_merged') return 'CONFLICTING';
    return 'UNKNOWN';
  };
  const prs = (parsed || []).map((mr) => ({
    number: mr.iid,
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    state: (mr.state || '').toLowerCase().replace('opened', 'open'),
    url: mr.web_url,
    mergeable: mapMergeable(mr.merge_status),
    mergeStateStatus: mr.has_conflicts ? 'DIRTY' : 'CLEAN',
  }));
  return { platform: 'gitlab', prs: filterByPrefix(prs, branchPrefix) };
}

async function listGiteaRest({ state, branchPrefix, baseUrl }) {
  const auth = authHeader('gitea');
  if (!auth || !baseUrl) {
    return {
      platform: 'gitea',
      prs: [],
      skipped: 'GITEA_TOKEN + --base-url required for REST fallback',
    };
  }
  const ownerRepo = await extractOwnerRepo();
  if (!ownerRepo) {
    return {
      platform: 'gitea',
      prs: [],
      error: 'could not parse owner/repo from origin remote',
    };
  }
  const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/repos/${ownerRepo}/pulls?state=${state === 'all' ? 'all' : 'open'}&limit=100`;
  const res = await getJson(url, { headers: auth });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    return {
      platform: 'gitea',
      prs: [],
      error: `Gitea API ${res.statusCode}: ${redactAuth(res.body)}`,
    };
  }
  const prs = (res.json || []).map((pr) => ({
    number: pr.number,
    sourceBranch: pr.head?.ref,
    targetBranch: pr.base?.ref,
    state: pr.state,
    url: pr.html_url,
    mergeable:
      pr.mergeable === true ? 'MERGEABLE' : pr.mergeable === false ? 'CONFLICTING' : 'UNKNOWN',
    mergeStateStatus: pr.mergeable === false ? 'DIRTY' : 'CLEAN',
  }));
  return { platform: 'gitea', prs: filterByPrefix(prs, branchPrefix) };
}

async function listGitea({ state, branchPrefix, baseUrl }) {
  if (await hasCli('tea')) {
    const stateMap = { open: 'open', all: 'all', closed: 'closed' };
    const r = await tryRun(
      'tea',
      ['pr', 'list', '--state', stateMap[state] || 'open', '--output', 'json'],
      { timeoutMs: 30_000 },
    );
    if (r.exitCode === 0) {
      let parsed;
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        // fall through to REST
        parsed = null;
      }
      if (parsed) {
        const prs = (parsed || []).map((pr) => ({
          number: pr.index ?? pr.number,
          sourceBranch: pr.head?.ref || pr.head_ref,
          targetBranch: pr.base?.ref || pr.base_ref,
          state: pr.state,
          url: pr.html_url || pr.url,
          mergeable:
            pr.mergeable === true
              ? 'MERGEABLE'
              : pr.mergeable === false
                ? 'CONFLICTING'
                : 'UNKNOWN',
          mergeStateStatus: pr.mergeable === false ? 'DIRTY' : 'CLEAN',
        }));
        return { platform: 'gitea', prs: filterByPrefix(prs, branchPrefix) };
      }
    }
  }
  return listGiteaRest({ state, branchPrefix, baseUrl });
}

async function listBitbucket({ state, branchPrefix, baseUrl }) {
  // `bb` CLI's PR list output is inconsistent; default to REST fallback
  // when a token is available.
  const auth = authHeader('bitbucket');
  if (!auth) {
    return {
      platform: 'bitbucket',
      prs: [],
      skipped: 'BITBUCKET_TOKEN not set; PR listing requires API access',
    };
  }
  const ownerRepo = await extractOwnerRepo();
  if (!ownerRepo) {
    return {
      platform: 'bitbucket',
      prs: [],
      error: 'could not parse owner/repo from origin remote',
    };
  }
  const stateParam = state === 'all' ? '' : '?state=OPEN';
  const apiBase = (baseUrl || defaultBaseUrl('bitbucket')).replace(/\/+$/, '');
  const url = `${apiBase}/repositories/${ownerRepo}/pullrequests${stateParam}`;
  const res = await getJson(url, { headers: auth });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    return {
      platform: 'bitbucket',
      prs: [],
      error: `Bitbucket API ${res.statusCode}: ${redactAuth(res.body)}`,
    };
  }
  const values = res.json?.values || [];
  const prs = values.map((pr) => ({
    number: pr.id,
    sourceBranch: pr.source?.branch?.name,
    targetBranch: pr.destination?.branch?.name,
    state: (pr.state || '').toLowerCase(),
    url: pr.links?.html?.href,
    // Bitbucket Cloud doesn't expose a single mergeable flag on the list
    // payload — leave UNKNOWN; pr-checks fills this in per-PR.
    mergeable: 'UNKNOWN',
    mergeStateStatus: 'UNKNOWN',
  }));
  return { platform: 'bitbucket', prs: filterByPrefix(prs, branchPrefix) };
}

async function main() {
  const { opts } = parseArgs(process.argv.slice(2));
  if (opts.help) {
    help();
    process.exit(0);
  }
  const platform = opts.platform;
  const state = opts.state || 'open';
  const branchPrefix = opts['branch-prefix'] || '';
  const baseUrl = opts['base-url'];

  if (!isKnownPlatform(platform)) {
    log.error(`unknown or missing --platform '${platform || ''}'`);
    help();
    process.exit(1);
  }

  if (platform === 'git_only') {
    emit({
      platform: 'git_only',
      prs: [],
      skipped: 'git_only platform: no PRs to list',
    });
    process.exit(2);
  }

  let result;
  switch (platform) {
    case 'github':
      result = await listGithub({ state, branchPrefix });
      break;
    case 'gitlab':
      result = await listGitlab({ state, branchPrefix });
      break;
    case 'gitea':
      result = await listGitea({ state, branchPrefix, baseUrl });
      break;
    case 'bitbucket':
      result = await listBitbucket({ state, branchPrefix, baseUrl });
      break;
    default:
      log.error(`unknown platform '${platform}'`);
      process.exit(1);
  }

  emit(result);
  // Exit 2 when we couldn't reach the platform (skipped / error), so callers
  // can choose to retry or downgrade. Successful empty result still exit 0.
  if (result.skipped || result.error) process.exit(2);
}

module.exports = {
  filterByPrefix,
  // Exported so tests can substitute fakes.
  listGithub,
  listGitlab,
  listGitea,
  listBitbucket,
};

if (require.main === module) {
  main().catch((e) => {
    log.error(e.message || String(e));
    process.exit(1);
  });
}
