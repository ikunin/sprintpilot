#!/usr/bin/env node

// pr-checks — emit normalized CI state for a single PR/MR. Used by the
// land_as_you_go branch of the autopilot workflow and by the land-stack
// rescue tool to decide "wait / merge / halt".
//
// Output (JSON):
//   {
//     "platform": "github",
//     "pr": 123,
//     "state": "pending" | "success" | "failure" | "unknown",
//     "checks": [
//       { "name": "ci/test", "state": "success" | "pending" | "failure" }
//     ],
//     "summary": "3 of 3 succeeded"
//   }
//
// Exit codes:
//   0 — success (state may still be pending or failure; check `state`).
//   1 — invalid argv or unrecoverable error.
//   2 — platform unavailable; stdout still contains a degraded payload.

const { parseArgs } = require('../lib/runtime/args');
const { tryRun } = require('../lib/runtime/spawn');
const { tryGitStdout } = require('../lib/runtime/git');
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
  log.out('Usage: pr-checks.js --platform <p> --pr <number> [--branch <name>] [--base-url <url>]');
}

// Map raw conclusion strings into our 3-way space.
function classify(state) {
  const s = (state || '').toLowerCase();
  if (['success', 'passed', 'completed', 'green'].includes(s)) return 'success';
  if (
    ['failure', 'failed', 'error', 'errored', 'cancelled', 'canceled', 'red', 'timed_out'].includes(
      s,
    )
  ) {
    return 'failure';
  }
  if (
    [
      'pending',
      'queued',
      'running',
      'in_progress',
      'waiting_for_resource',
      'created',
      'preparing',
    ].includes(s)
  ) {
    return 'pending';
  }
  if (s === 'neutral' || s === 'skipped' || s === 'success_with_issues') return 'success';
  return 'unknown';
}

// Roll up an array of check states into a single overall state.
//   - any failure → failure
//   - any pending → pending
//   - all success → success
//   - empty       → unknown
function summarizeStates(states) {
  if (!states.length) return 'unknown';
  if (states.includes('failure')) return 'failure';
  if (states.includes('pending')) return 'pending';
  if (states.every((s) => s === 'success')) return 'success';
  return 'unknown';
}

async function checksGithub({ pr }) {
  if (!(await hasCli('gh'))) {
    return {
      platform: 'github',
      pr,
      state: 'unknown',
      checks: [],
      skipped: 'gh CLI not found',
    };
  }
  // `gh pr checks` JSON output: array of { name, state, conclusion, link, bucket }
  const r = await tryRun(
    'gh',
    ['pr', 'checks', String(pr), '--json', 'name,state,conclusion,bucket'],
    {
      timeoutMs: 30_000,
    },
  );
  if (r.exitCode !== 0 && r.exitCode !== 8) {
    // exit 8 = some checks failing; gh treats that as a non-zero but we
    // still get JSON on stdout. Anything else is an error.
    return {
      platform: 'github',
      pr,
      state: 'unknown',
      checks: [],
      error: `gh pr checks failed: ${(r.stderr || r.stdout || '').trim()}`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    return {
      platform: 'github',
      pr,
      state: 'unknown',
      checks: [],
      error: `gh pr checks emitted non-JSON: ${e.message}`,
    };
  }
  const checks = (parsed || []).map((c) => ({
    name: c.name,
    state: classify(c.bucket || c.conclusion || c.state),
  }));
  const overall = summarizeStates(checks.map((c) => c.state));
  const succ = checks.filter((c) => c.state === 'success').length;
  return {
    platform: 'github',
    pr,
    state: overall,
    checks,
    summary: `${succ} of ${checks.length} succeeded`,
  };
}

async function checksGitlab({ pr, branch }) {
  if (!(await hasCli('glab'))) {
    return {
      platform: 'gitlab',
      pr,
      state: 'unknown',
      checks: [],
      skipped: 'glab CLI not found',
    };
  }
  const args = pr
    ? ['mr', 'view', String(pr), '--output', 'json']
    : ['mr', 'view', '--output', 'json'];
  const r = await tryRun('glab', args, { timeoutMs: 30_000 });
  if (r.exitCode !== 0) {
    return {
      platform: 'gitlab',
      pr,
      state: 'unknown',
      checks: [],
      error: `glab mr view failed: ${(r.stderr || r.stdout || '').trim()}`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    return {
      platform: 'gitlab',
      pr,
      state: 'unknown',
      checks: [],
      error: `glab mr view emitted non-JSON: ${e.message}`,
    };
  }
  // GitLab's MR JSON has `head_pipeline` or `pipeline` with `status`.
  const pipelineStatus =
    parsed?.head_pipeline?.status ||
    parsed?.pipeline?.status ||
    parsed?.detailed_merge_status ||
    null;
  const state = classify(pipelineStatus);
  return {
    platform: 'gitlab',
    pr: parsed?.iid ?? pr,
    state,
    checks: pipelineStatus ? [{ name: 'pipeline', state }] : [],
    summary: pipelineStatus ? `pipeline ${pipelineStatus}` : 'no pipeline found',
    branch: branch || parsed?.source_branch || null,
  };
}

async function checksGiteaRest({ pr, baseUrl }) {
  const auth = authHeader('gitea');
  if (!auth || !baseUrl) {
    return {
      platform: 'gitea',
      pr,
      state: 'unknown',
      checks: [],
      skipped: 'GITEA_TOKEN + --base-url required for REST fallback',
    };
  }
  const ownerRepo = await extractOwnerRepo();
  if (!ownerRepo) {
    return {
      platform: 'gitea',
      pr,
      state: 'unknown',
      checks: [],
      error: 'could not parse owner/repo from origin remote',
    };
  }
  const apiBase = baseUrl.replace(/\/+$/, '');
  // First fetch the PR to learn the head SHA, then statuses on that SHA.
  const prRes = await getJson(`${apiBase}/api/v1/repos/${ownerRepo}/pulls/${pr}`, {
    headers: auth,
  });
  if (prRes.statusCode < 200 || prRes.statusCode >= 300) {
    return {
      platform: 'gitea',
      pr,
      state: 'unknown',
      checks: [],
      error: `Gitea API ${prRes.statusCode}: ${redactAuth(prRes.body)}`,
    };
  }
  const sha = prRes.json?.head?.sha;
  if (!sha) {
    return {
      platform: 'gitea',
      pr,
      state: 'unknown',
      checks: [],
      error: 'PR payload missing head.sha',
    };
  }
  const statusRes = await getJson(`${apiBase}/api/v1/repos/${ownerRepo}/commits/${sha}/status`, {
    headers: auth,
  });
  if (statusRes.statusCode < 200 || statusRes.statusCode >= 300) {
    return {
      platform: 'gitea',
      pr,
      state: 'unknown',
      checks: [],
      error: `Gitea status API ${statusRes.statusCode}: ${redactAuth(statusRes.body)}`,
    };
  }
  const statuses = statusRes.json?.statuses || [];
  const checks = statuses.map((s) => ({ name: s.context, state: classify(s.state) }));
  const overall = checks.length
    ? summarizeStates(checks.map((c) => c.state))
    : classify(statusRes.json?.state);
  const succ = checks.filter((c) => c.state === 'success').length;
  return {
    platform: 'gitea',
    pr,
    state: overall,
    checks,
    summary: `${succ} of ${checks.length} succeeded`,
  };
}

async function checksGitea(args) {
  // Prefer REST since `tea pr checks` output is inconsistent; tea CLI is
  // a fallback only when no token is configured.
  if (process.env.GITEA_TOKEN && args.baseUrl) {
    return checksGiteaRest(args);
  }
  if (await hasCli('tea')) {
    const r = await tryRun('tea', ['pr', 'checks', String(args.pr)], { timeoutMs: 30_000 });
    if (r.exitCode === 0) {
      // tea outputs human text; surface as a single check.
      const overall = /failed|error/i.test(r.stdout)
        ? 'failure'
        : /pending|running/i.test(r.stdout)
          ? 'pending'
          : 'success';
      return {
        platform: 'gitea',
        pr: args.pr,
        state: overall,
        checks: [{ name: 'tea-summary', state: overall }],
        summary: r.stdout.trim().slice(0, 200),
      };
    }
  }
  return checksGiteaRest(args);
}

async function checksBitbucket({ pr, baseUrl }) {
  const auth = authHeader('bitbucket');
  if (!auth) {
    return {
      platform: 'bitbucket',
      pr,
      state: 'unknown',
      checks: [],
      skipped: 'BITBUCKET_TOKEN not set',
    };
  }
  const ownerRepo = await extractOwnerRepo();
  if (!ownerRepo) {
    return {
      platform: 'bitbucket',
      pr,
      state: 'unknown',
      checks: [],
      error: 'could not parse owner/repo from origin remote',
    };
  }
  const apiBase = (baseUrl || defaultBaseUrl('bitbucket')).replace(/\/+$/, '');
  // Fetch the PR to learn the source commit SHA, then statuses on it.
  const prRes = await getJson(`${apiBase}/repositories/${ownerRepo}/pullrequests/${pr}`, {
    headers: auth,
  });
  if (prRes.statusCode < 200 || prRes.statusCode >= 300) {
    return {
      platform: 'bitbucket',
      pr,
      state: 'unknown',
      checks: [],
      error: `Bitbucket API ${prRes.statusCode}: ${redactAuth(prRes.body)}`,
    };
  }
  const sha = prRes.json?.source?.commit?.hash;
  if (!sha) {
    return {
      platform: 'bitbucket',
      pr,
      state: 'unknown',
      checks: [],
      error: 'PR payload missing source.commit.hash',
    };
  }
  const statusRes = await getJson(`${apiBase}/repositories/${ownerRepo}/commit/${sha}/statuses`, {
    headers: auth,
  });
  if (statusRes.statusCode < 200 || statusRes.statusCode >= 300) {
    return {
      platform: 'bitbucket',
      pr,
      state: 'unknown',
      checks: [],
      error: `Bitbucket statuses API ${statusRes.statusCode}: ${redactAuth(statusRes.body)}`,
    };
  }
  // Bitbucket states: SUCCESSFUL | FAILED | INPROGRESS | STOPPED.
  const map = {
    SUCCESSFUL: 'success',
    FAILED: 'failure',
    INPROGRESS: 'pending',
    STOPPED: 'failure',
  };
  const checks = (statusRes.json?.values || []).map((s) => ({
    name: s.key || s.name,
    state: map[s.state] || classify(s.state),
  }));
  const overall = summarizeStates(checks.map((c) => c.state));
  const succ = checks.filter((c) => c.state === 'success').length;
  return {
    platform: 'bitbucket',
    pr,
    state: overall,
    checks,
    summary: `${succ} of ${checks.length} succeeded`,
  };
}

async function main() {
  const { opts } = parseArgs(process.argv.slice(2));
  if (opts.help) {
    help();
    process.exit(0);
  }
  const platform = opts.platform;
  const pr = opts.pr;
  const branch = opts.branch || (await tryGitStdout(['rev-parse', '--abbrev-ref', 'HEAD']));
  const baseUrl = opts['base-url'];

  if (!isKnownPlatform(platform)) {
    log.error(`unknown or missing --platform '${platform || ''}'`);
    help();
    process.exit(1);
  }

  if (platform === 'git_only') {
    emit({
      platform: 'git_only',
      pr: pr || null,
      state: 'unknown',
      checks: [],
      skipped: 'git_only platform',
    });
    process.exit(2);
  }

  if (!pr && platform !== 'gitlab') {
    log.error('--pr is required (except on gitlab where current branch can disambiguate)');
    process.exit(1);
  }

  let result;
  switch (platform) {
    case 'github':
      result = await checksGithub({ pr });
      break;
    case 'gitlab':
      result = await checksGitlab({ pr, branch });
      break;
    case 'gitea':
      result = await checksGitea({ pr, baseUrl });
      break;
    case 'bitbucket':
      result = await checksBitbucket({ pr, baseUrl });
      break;
    default:
      log.error(`unknown platform '${platform}'`);
      process.exit(1);
  }

  emit(result);
  if (result.skipped || result.error) process.exit(2);
}

module.exports = {
  classify,
  summarizeStates,
  checksGithub,
  checksGitlab,
  checksGitea,
  checksBitbucket,
};

if (require.main === module) {
  main().catch((e) => {
    log.error(e.message || String(e));
    process.exit(1);
  });
}
