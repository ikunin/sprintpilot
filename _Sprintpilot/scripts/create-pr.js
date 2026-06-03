#!/usr/bin/env node

const { parseArgs } = require('../lib/runtime/args');
const { tryRun, run } = require('../lib/runtime/spawn');
const { tryGitStdout } = require('../lib/runtime/git');
const { extractUrl, headLines } = require('../lib/runtime/text');
const { postJson } = require('../lib/runtime/http');
const log = require('../lib/runtime/log');

function help() {
  log.out(
    "Usage: create-pr.js --mode <create|checks> --platform <github|gitlab|bitbucket|gitea|git_only> --branch <name> --base <branch> [--title 'title' --body 'body'] [--wait-minutes N] [--require-approved-review] [--base-url <url>]",
  );
  log.out('  --mode create (default) — open a PR. Requires --title.');
  log.out('  --mode checks          — poll an existing PR for CI / review status.');
}

async function hasCli(name) {
  const r = await tryRun(name, ['--version'], { timeoutMs: 2000 });
  return r.exitCode === 0;
}

// Resolve `--platform auto` to a concrete provider by probing for an
// installed CLI in priority order. Used by both --mode create and
// --mode checks. Returns 'git_only' when nothing is installed so the
// downstream branches surface a clear SKIPPED exit.
async function resolveAutoPlatform() {
  if (await hasCli('gh')) return 'github';
  if (await hasCli('glab')) return 'gitlab';
  if (await hasCli('bb')) return 'bitbucket';
  if (await hasCli('tea')) return 'gitea';
  return 'git_only';
}

// Accept only safe path components so a hostile remote URL can't inject
// into the REST API path. Both segments must match this pattern; the full
// path (repo name plus any GitLab subgroup segments) must contain only
// allowed characters. This prevents paths like `..`, URL-encoded slashes,
// or whitespace sneaking into the request.
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function parseGitRemote(url) {
  if (!url) return null;
  let u = url.trim();
  // Strip a trailing `.git` and trailing `/` from either form.
  u = u.replace(/\.git\/?$/, '').replace(/\/$/, '');

  // SCP-style: user@host:path (e.g. git@github.com:owner/repo,
  // git@github.com-work:org/sub/repo). Exclude URL-scheme inputs from this
  // branch — they belong to the URL parser below.
  if (!/^(?:https?|ssh|git):/i.test(u)) {
    // SCP-style cannot sensibly represent IPv6 hosts or ports — reject
    // inputs whose host portion starts with `[` or contains a second `:`
    // in the path (which would indicate an embedded port that would then
    // be interpolated into a REST URL).
    if (u.startsWith('[')) return null;
    const scp = u.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
    if (scp) {
      const host = scp[1];
      const path = scp[2].replace(/^\/+/, '');
      // Reject when the "path" contains a colon — that indicates a
      // non-standard `user@host:port:path` form which would silently
      // misroute to the wrong REST API path.
      if (path.includes(':')) return null;
      return { host, path };
    }
  }

  // URL form: https://host/path, ssh://git@host:port/path, git://host/path.
  try {
    const parsed = new URL(u);
    return { host: parsed.hostname, path: parsed.pathname.replace(/^\/+/, '') };
  } catch {
    return null;
  }
}

async function extractOwnerRepo() {
  const remoteUrl = (await tryGitStdout(['remote', 'get-url', 'origin'])) || '';
  const parts = parseGitRemote(remoteUrl);
  if (!parts) return '';
  const segments = parts.path.split('/').filter(Boolean);
  if (segments.length < 2) return '';
  // Validate every segment — ownerRepo gets interpolated into the REST URL.
  for (const seg of segments) {
    if (!SAFE_SEGMENT.test(seg)) return '';
  }
  return segments.join('/');
}

// Strip Authorization header values and obvious token fields from a response
// body before we echo it to the user's terminal or logs.
function redactAuth(text) {
  if (!text) return text;
  return String(text)
    .replace(/("?authorization"?\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
    .replace(/(bearer\s+)\S+/gi, '$1[REDACTED]')
    .replace(
      /("?(?:token|access_token|api_key|private_token)"?\s*[:=]\s*")[^"]*(")/gi,
      '$1[REDACTED]$2',
    );
}

async function main() {
  const { opts } = parseArgs(process.argv.slice(2), {
    booleanFlags: ['dry-run', 'require-approved-review'],
  });
  if (opts.help) {
    help();
    process.exit(0);
  }

  const platform = opts.platform;
  const branch = opts.branch;
  const baseBranch = opts.base || 'main';
  const title = opts.title;
  const body = opts.body || '';
  const baseUrl = opts['base-url'];
  const dryRun = !!opts['dry-run'];
  const mode = opts.mode || 'create';
  const waitMinutes = Number.parseFloat(opts['wait-minutes'] || '30');
  const requireApprovedReview = !!opts['require-approved-review'];

  // --mode checks: poll the platform for CI / review status of an
  // existing PR. Required by land.js when merge_strategy=land_as_you_go +
  // land_when ∈ {ci_pass, ci_and_review}. Distinct argument surface from
  // --mode create (no --title needed).
  if (mode === 'checks') {
    if (!platform || !branch) {
      log.error('--mode checks requires --platform and --branch');
      process.exit(1);
    }
    const resolved = platform === 'auto' ? await resolveAutoPlatform() : platform;
    await runChecksMode({
      platform: resolved,
      branch,
      baseBranch,
      waitMinutes,
      requireApprovedReview,
      baseUrl,
    });
    return;
  }

  if (!platform || !branch || !title) {
    log.error('--platform, --branch, and --title are required');
    process.exit(1);
  }

  // Resolve `auto` to a concrete provider via CLI probing. This honors
  // the documented default in modules/git/config.yaml#platform.provider.
  // Without this resolution, the platform === 'github'/'gitlab'/... if-
  // chain below falls through to "unknown platform" exit 1.
  const resolvedPlatform = platform === 'auto' ? await resolveAutoPlatform() : platform;

  const remote = await tryGitStdout(['remote', 'get-url', 'origin']);
  if (!remote) {
    log.out('SKIPPED');
    log.err('INFO: No git remote configured. Push and create PR manually:');
    log.err(`  git remote add origin <url>`);
    log.err(`  git push -u origin ${branch}`);
    process.exit(2);
  }

  if (dryRun) {
    log.out(`DRY RUN: would create ${platform} PR/MR`);
    log.out(`  Branch: ${branch} → ${baseBranch}`);
    log.out(`  Title: ${title}`);
    log.out(`  Body: ${headLines(body, 3)}...`);
    return;
  }

  if (resolvedPlatform === 'git_only') {
    log.out('SKIPPED');
    log.err('INFO: No platform CLI available. Push completed. Create PR manually:');
    log.err(`  Branch: ${branch} → ${baseBranch}`);
    process.exit(2);
  }

  if (resolvedPlatform === 'github') {
    if (!(await hasCli('gh'))) {
      log.err('WARN: gh CLI not found, skipping PR creation');
      log.out('SKIPPED');
      process.exit(2);
    }
    // Idempotency: if a PR already exists for this branch (granularity=
    // epic re-pushes onto the same branch, or a manual resume), return
    // its URL and exit 0 instead of hitting `gh pr create` which fails
    // hard with "a pull request for branch X already exists".
    //
    // `gh pr list --head <branch> --json url --limit 1` is the canonical
    // "PRs for this head" query. It exits 0 with `[]` when no PR exists
    // (distinct from `gh pr view` which exits 1 for both "no PR" and
    // "auth failed" — ambiguous). We only short-circuit on a non-empty
    // array; any other exit falls through to `gh pr create` so transient
    // errors don't suppress PR creation forever.
    const existing = await tryRun(
      'gh',
      ['pr', 'list', '--head', branch, '--json', 'url', '--limit', '1', '--jq', '.[0].url // ""'],
      { timeoutMs: 15_000 },
    );
    if (existing.exitCode === 0) {
      const url = (existing.stdout || '').trim();
      if (url) {
        log.out(url);
        return;
      }
    }
    const r = await tryRun(
      'gh',
      ['pr', 'create', '--base', baseBranch, '--head', branch, '--title', title, '--body', body],
      { timeoutMs: 60_000 },
    );
    const combined = `${r.stdout}${r.stderr}`;
    if (r.exitCode !== 0) {
      // Backstop: gh's "already exists" error message can race with our
      // pre-check (push lands a PR between `view` and `create`). Detect
      // it in stderr and treat as success.
      if (/already exists/i.test(combined)) {
        log.out(combined.trim());
        return;
      }
      log.error(`gh pr create failed: ${combined.trim()}`);
      process.exit(1);
    }
    log.out(combined.trim());
    return;
  }

  if (resolvedPlatform === 'gitlab') {
    if (!(await hasCli('glab'))) {
      log.err('WARN: glab CLI not found, skipping MR creation');
      log.out('SKIPPED');
      process.exit(2);
    }
    const r = await tryRun(
      'glab',
      [
        'mr',
        'create',
        '--source-branch',
        branch,
        '--target-branch',
        baseBranch,
        '--title',
        title,
        '--description',
        body,
        '--remove-source-branch',
        '--yes',
      ],
      { timeoutMs: 60_000 },
    );
    const combined = `${r.stdout}${r.stderr}`;
    if (r.exitCode !== 0) {
      log.error(`glab mr create failed: ${combined.trim()}`);
      process.exit(1);
    }
    const url = extractUrl(combined);
    log.out(url || combined.trim());
    return;
  }

  if (resolvedPlatform === 'bitbucket') {
    if (await hasCli('bb')) {
      const r = await tryRun(
        'bb',
        [
          'pr',
          'create',
          '--source',
          branch,
          '--destination',
          baseBranch,
          '--title',
          title,
          '--description',
          body,
        ],
        { timeoutMs: 60_000 },
      );
      const combined = `${r.stdout}${r.stderr}`;
      if (r.exitCode !== 0) {
        log.error(`bb pr create failed: ${combined.trim()}`);
        process.exit(1);
      }
      const url = extractUrl(combined);
      log.out(url || combined.trim());
      return;
    }
    if (process.env.BITBUCKET_TOKEN) {
      const ownerRepo = await extractOwnerRepo();
      try {
        const res = await postJson(
          `https://api.bitbucket.org/2.0/repositories/${ownerRepo}/pullrequests`,
          {
            title,
            source: { branch: { name: branch } },
            destination: { branch: { name: baseBranch } },
            description: body,
          },
          { headers: { Authorization: `Bearer ${process.env.BITBUCKET_TOKEN}` } },
        );
        if (res.statusCode === 201) {
          const href = res.json?.links?.html?.href;
          if (href) {
            log.out(href);
            return;
          }
          log.out('CREATED (URL not extracted from response)');
          return;
        }
        log.error(`Bitbucket API returned ${res.statusCode}: ${redactAuth(res.body)}`);
        process.exit(1);
      } catch (e) {
        log.error(`Bitbucket API request failed: ${e.message}`);
        process.exit(1);
      }
    }
    log.out('SKIPPED');
    log.err('INFO: Neither bb CLI nor BITBUCKET_TOKEN found. Create PR manually:');
    log.err(`  Branch: ${branch} → ${baseBranch}`);
    process.exit(2);
  }

  if (resolvedPlatform === 'gitea') {
    if (await hasCli('tea')) {
      const r = await tryRun(
        'tea',
        [
          'pr',
          'create',
          '--base',
          baseBranch,
          '--head',
          branch,
          '--title',
          title,
          '--description',
          body,
        ],
        { timeoutMs: 60_000 },
      );
      const combined = `${r.stdout}${r.stderr}`;
      if (r.exitCode !== 0) {
        log.error(`tea pr create failed: ${combined.trim()}`);
        process.exit(1);
      }
      const url = extractUrl(combined);
      log.out(url || combined.trim());
      return;
    }
    if (process.env.GITEA_TOKEN && baseUrl) {
      const ownerRepo = await extractOwnerRepo();
      try {
        const res = await postJson(
          `${baseUrl.replace(/\/+$/, '')}/api/v1/repos/${ownerRepo}/pulls`,
          { base: baseBranch, head: branch, title, body },
          { headers: { Authorization: `token ${process.env.GITEA_TOKEN}` } },
        );
        if (res.statusCode === 201) {
          const href = res.json?.html_url;
          if (href) {
            log.out(href);
            return;
          }
          log.out('CREATED (URL not extracted from response)');
          return;
        }
        log.error(`Gitea API returned ${res.statusCode}: ${redactAuth(res.body)}`);
        process.exit(1);
      } catch (e) {
        log.error(`Gitea API request failed: ${e.message}`);
        process.exit(1);
      }
    }
    log.out('SKIPPED');
    log.err('INFO: Neither tea CLI nor GITEA_TOKEN+base_url found. Create PR manually:');
    log.err(`  Branch: ${branch} → ${baseBranch}`);
    process.exit(2);
  }

  log.error(`unknown platform '${resolvedPlatform}'`);
  process.exit(1);
}

// --mode checks: poll an existing PR's CI status (and optionally review
// status) until success, failure, or timeout. Polling interval is 30s
// with ±5s of uniform jitter; the watchdog cap is `waitMinutes`.
//
// Effective per-cycle wall time can be up to ~60s when `gh pr checks`
// itself takes the full 30s of its --timeoutMs before timing out on a
// pending check, plus a 30s±5s sleep. Therefore the actual elapsed
// time before declaring "timed out" can exceed `waitMinutes` by up to
// ~one cycle (~60s). Set wait-minutes with that overhead in mind.
//
// gh exit codes for `gh pr checks <branch>`:
//   0 — all required checks passed
//   8 — checks still pending (not all completed)
//   anything else — at least one required check failed
//
// On non-github platforms (or when CLI is missing), exits 2 (SKIPPED) so
// land.js can surface a user_prompt rather than blocking on a feature
// we can't deliver.
async function runChecksMode({
  platform,
  branch,
  baseBranch,
  waitMinutes,
  requireApprovedReview,
  baseUrl,
}) {
  // `platform` has already been resolved (auto → concrete) in main(),
  // so we only branch on concrete provider strings here.
  if (platform === 'github') {
    if (!(await hasCli('gh'))) {
      log.err('WARN: gh CLI not found, cannot poll PR checks');
      log.out('SKIPPED');
      process.exit(2);
    }
    const deadline = Date.now() + Math.max(0, waitMinutes) * 60_000;
    let lastSummary = '';
    while (Date.now() < deadline) {
      const r = await tryRun('gh', ['pr', 'checks', branch], { timeoutMs: 30_000 });
      lastSummary = (r.stdout || '').trim().split('\n').slice(0, 5).join('\n');
      if (r.exitCode === 0) {
        // All required checks passed. If review is required, poll for that too.
        if (!requireApprovedReview) {
          log.out(`checks passed for ${branch}`);
          return;
        }
        const reviewOk = await pollReviewApproved(branch, deadline);
        if (reviewOk) {
          log.out(`checks passed + review approved for ${branch}`);
          return;
        }
        log.error(`checks passed but review not approved before deadline for ${branch}`);
        process.exit(1);
      }
      if (r.exitCode === 8) {
        // Pending — wait and retry. Add ±5s jitter so concurrent
        // autopilot sessions (e.g. ma.parallel_stories) don't pile up
        // gh-API calls in lockstep every 30 seconds.
        await sleep(jitteredInterval(30_000, 5_000));
        continue;
      }
      // Hard failure (e.g. exit 1) — at least one required check failed.
      log.error(`checks failed for ${branch}:\n${lastSummary}`);
      process.exit(1);
    }
    log.error(`timed out after ${waitMinutes}m waiting for checks on ${branch}\n${lastSummary}`);
    process.exit(1);
  }

  if (
    platform === 'gitlab' ||
    platform === 'bitbucket' ||
    platform === 'gitea' ||
    platform === 'git_only'
  ) {
    // Polling is not yet implemented for these providers. Surface a
    // SKIPPED exit so land.js can prompt the user.
    log.err(`INFO: --mode checks polling not yet implemented for ${platform}. Verify manually.`);
    log.out('SKIPPED');
    process.exit(2);
  }

  log.error(`unknown platform '${platform}'`);
  process.exit(1);
}

async function pollReviewApproved(branch, deadline) {
  while (Date.now() < deadline) {
    const r = await tryRun(
      'gh',
      ['pr', 'view', branch, '--json', 'reviewDecision', '--jq', '.reviewDecision'],
      { timeoutMs: 15_000 },
    );
    const decision = (r.stdout || '').trim();
    if (decision === 'APPROVED') return true;
    if (decision === 'CHANGES_REQUESTED') return false; // hard fail — no point waiting
    // REVIEW_REQUIRED, empty string, or any other state → keep polling
    // with the same ±5s jitter as the checks loop.
    await sleep(jitteredInterval(30_000, 5_000));
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Compute a polling interval with ±jitterMs of uniform random noise so
// concurrent pollers (parallel autopilot sessions) don't hit gh's API
// in lockstep.
function jitteredInterval(baseMs, jitterMs) {
  const delta = Math.floor((Math.random() - 0.5) * 2 * jitterMs);
  return Math.max(1000, baseMs + delta);
}

// Export pure helpers so they can be unit-tested directly. The script
// itself still runs `main()` when invoked as a module.
module.exports = { parseGitRemote, redactAuth };

// Only invoke main when this file is the entry point, not when it's
// require()d from a test.
if (require.main === module) {
  main().catch((e) => {
    log.error(e.message || String(e));
    process.exit(1);
  });
}
