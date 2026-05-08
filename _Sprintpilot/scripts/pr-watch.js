#!/usr/bin/env node

// pr-watch — poll pr-checks.js until a PR's CI reaches a terminal state
// (success or failure) or a timeout elapses. Used by the land_as_you_go
// branch of the autopilot workflow and by the land-stack rescue tool.
//
// Output (JSON to stdout):
//   {
//     platform, pr,
//     state: "success" | "failure" | "pending" | "unknown",
//     polled: <int>,
//     elapsed_seconds: <number>,
//     timed_out: <bool>,
//     // plus the most-recent pr-checks payload (checks[], summary, etc.)
//   }
//
// Exit codes:
//   0 — terminal state reached (success or failure); caller checks `state`.
//   2 — platform unavailable or pr-checks subprocess failed; payload still
//       contains best-effort state.
//   3 — timed out before reaching terminal state.

const path = require('node:path');

const { parseArgs } = require('../lib/runtime/args');
const { tryRun } = require('../lib/runtime/spawn');
const log = require('../lib/runtime/log');
const { isKnownPlatform } = require('../lib/runtime/platform');

const SCRIPT_DIR = __dirname;

function help() {
  log.out(
    'Usage: pr-watch.js --platform <p> --pr <number> [--timeout 600] [--interval 30] [--base-url <url>]',
  );
}

function emit(payload) {
  log.out(JSON.stringify(payload));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchChecks({ platform, pr, baseUrl }) {
  const args = ['--platform', platform, '--pr', String(pr)];
  if (baseUrl) args.push('--base-url', baseUrl);
  const r = await tryRun('node', [path.join(SCRIPT_DIR, 'pr-checks.js'), ...args], {
    timeoutMs: 30_000,
  });
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    return {
      platform,
      pr,
      state: 'unknown',
      checks: [],
      error: `pr-checks emitted non-JSON: ${e.message}`,
    };
  }
}

async function pollUntilTerminal({ platform, pr, baseUrl, intervalMs, timeoutMs }) {
  const start = Date.now();
  let polled = 0;
  let last = null;
  while (true) {
    polled++;
    last = await fetchChecks({ platform, pr, baseUrl });
    if (last.state === 'success' || last.state === 'failure') {
      return {
        ...last,
        polled,
        elapsed_seconds: (Date.now() - start) / 1000,
        timed_out: false,
      };
    }
    if (Date.now() - start >= timeoutMs) {
      return {
        ...last,
        polled,
        elapsed_seconds: (Date.now() - start) / 1000,
        timed_out: true,
      };
    }
    // Don't sleep past the timeout — clamp the next interval if needed.
    const remaining = timeoutMs - (Date.now() - start);
    await sleep(Math.min(intervalMs, remaining));
  }
}

async function main() {
  const { opts } = parseArgs(process.argv.slice(2));
  if (opts.help) {
    help();
    process.exit(0);
  }
  const platform = opts.platform;
  const pr = opts.pr;
  const timeoutSec = Number(opts.timeout || 600);
  const intervalSec = Number(opts.interval || 30);
  const baseUrl = opts['base-url'];

  if (!isKnownPlatform(platform)) {
    log.error(`unknown or missing --platform '${platform || ''}'`);
    process.exit(1);
  }
  if (!pr) {
    log.error('--pr is required');
    process.exit(1);
  }
  if (platform === 'git_only') {
    emit({
      platform: 'git_only',
      pr,
      state: 'unknown',
      polled: 0,
      elapsed_seconds: 0,
      timed_out: false,
      skipped: 'git_only platform: no CI to watch',
    });
    process.exit(2);
  }
  if (Number.isNaN(timeoutSec) || timeoutSec <= 0) {
    log.error('--timeout must be a positive number of seconds');
    process.exit(1);
  }
  if (Number.isNaN(intervalSec) || intervalSec <= 0) {
    log.error('--interval must be a positive number of seconds');
    process.exit(1);
  }

  const result = await pollUntilTerminal({
    platform,
    pr,
    baseUrl,
    intervalMs: intervalSec * 1000,
    timeoutMs: timeoutSec * 1000,
  });
  emit(result);
  if (result.timed_out) process.exit(3);
  if (result.error || result.skipped) process.exit(2);
  // success or failure → exit 0; caller decides what to do based on state.
  process.exit(0);
}

module.exports = { pollUntilTerminal, fetchChecks };

if (require.main === module) {
  main().catch((e) => {
    log.error(e.message || String(e));
    process.exit(1);
  });
}
