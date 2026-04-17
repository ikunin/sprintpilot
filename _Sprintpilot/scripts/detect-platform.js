#!/usr/bin/env node

const { parseArgs } = require('../lib/runtime/args');
const { tryRun } = require('../lib/runtime/spawn');
const { tryGitStdout } = require('../lib/runtime/git');
const log = require('../lib/runtime/log');

function help() {
  log.out('Usage: detect-platform.js [--provider <auto|github|gitlab|bitbucket|gitea|git_only>]');
}

async function hasCli(name) {
  const r = await tryRun(name, ['--version'], { timeoutMs: 2000 });
  return r.exitCode === 0;
}

async function main() {
  const { opts } = parseArgs(process.argv.slice(2));
  if (opts.help) {
    help();
    process.exit(0);
  }
  const provider = opts.provider || 'auto';

  if (provider !== 'auto') {
    log.out(provider);
    return;
  }

  const [hasGh, hasGlab, hasBb, hasTea] = await Promise.all([
    hasCli('gh'),
    hasCli('glab'),
    hasCli('bb'),
    hasCli('tea'),
  ]);

  const detected = [];
  if (hasGh) detected.push('github');
  if (hasGlab) detected.push('gitlab');
  if (hasBb) detected.push('bitbucket');
  if (hasTea) detected.push('gitea');

  if (detected.length === 1) {
    log.out(detected[0]);
    return;
  }

  const remote = (await tryGitStdout(['remote', 'get-url', 'origin'])) || '';

  if (/github\.com[:/]/i.test(remote)) {
    log.out('github');
    return;
  }
  if (/gitlab\./i.test(remote)) {
    log.out('gitlab');
    return;
  }
  if (/bitbucket\.org[:/]/i.test(remote)) {
    log.out('bitbucket');
    return;
  }

  if (hasTea) {
    log.out('gitea');
    return;
  }
  if (hasGh) {
    log.out('github');
    return;
  }
  if (hasGlab) {
    log.out('gitlab');
    return;
  }
  if (hasBb) {
    log.out('bitbucket');
    return;
  }

  log.err(
    "WARN: no platform CLI found (gh, glab, bb, tea) and remote URL didn't match known platforms",
  );
  log.out('git_only');
}

main().catch((e) => {
  log.error(e.message || String(e));
  process.exit(1);
});
