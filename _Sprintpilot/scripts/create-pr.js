#!/usr/bin/env node

const { parseArgs } = require('../lib/runtime/args');
const { tryRun } = require('../lib/runtime/spawn');
const { tryGitStdout } = require('../lib/runtime/git');
const { extractUrl, headLines } = require('../lib/runtime/text');
const { postJson } = require('../lib/runtime/http');
const { hasCli, parseGitRemote, extractOwnerRepo, redactAuth } = require('../lib/runtime/platform');
const log = require('../lib/runtime/log');

function help() {
  log.out(
    "Usage: create-pr.js --platform <github|gitlab|bitbucket|gitea|git_only> --branch <name> --base <branch> --title 'title' --body 'body' [--base-url <url>]",
  );
}

async function main() {
  const { opts } = parseArgs(process.argv.slice(2), { booleanFlags: ['dry-run'] });
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

  if (!platform || !branch || !title) {
    log.error('--platform, --branch, and --title are required');
    process.exit(1);
  }

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

  if (platform === 'git_only') {
    log.out('SKIPPED');
    log.err('INFO: No platform CLI available. Push completed. Create PR manually:');
    log.err(`  Branch: ${branch} → ${baseBranch}`);
    process.exit(2);
  }

  if (platform === 'github') {
    if (!(await hasCli('gh'))) {
      log.err('WARN: gh CLI not found, skipping PR creation');
      log.out('SKIPPED');
      process.exit(2);
    }
    const r = await tryRun(
      'gh',
      ['pr', 'create', '--base', baseBranch, '--head', branch, '--title', title, '--body', body],
      { timeoutMs: 60_000 },
    );
    const combined = `${r.stdout}${r.stderr}`;
    if (r.exitCode !== 0) {
      log.error(`gh pr create failed: ${combined.trim()}`);
      process.exit(1);
    }
    log.out(combined.trim());
    return;
  }

  if (platform === 'gitlab') {
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

  if (platform === 'bitbucket') {
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

  if (platform === 'gitea') {
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

  log.error(`unknown platform '${platform}'`);
  process.exit(1);
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
