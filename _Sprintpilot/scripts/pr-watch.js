#!/usr/bin/env node

// pr-watch — poll pr-checks.js until a PR's CI reaches a terminal state
// (success or failure) or a timeout elapses. Used by the land_as_you_go
// branch of the autopilot workflow and by the land-stack rescue tool.
//
// Output (JSON to stdout):
//   {
//     platform, pr,
//     state: "success" | "failure" | "pending" | "unknown",
//     polled: <int>,                  // total fetchChecks invocations
//     consecutive_unknown: <int>,     // streak of `unknown` results at exit;
//                                     // 0 unless we're degrading
//     elapsed_seconds: <number>,
//     timed_out: <bool>,              // true if we hit `--timeout`
//     gave_up: <bool>,                // true if we bailed early after
//                                     // MAX_CONSECUTIVE_UNKNOWN unknowns
//                                     // (CLI missing, API hung, etc.)
//     // plus the most-recent pr-checks payload (checks[], summary, etc.)
//   }
//
// Exit codes:
//   0 — terminal state reached (success or failure); caller checks `state`.
//   2 — platform unavailable, pr-checks subprocess failed, or `gave_up`
//       fired (couldn't reach CI at all); payload still contains best-
//       effort state. The workflow treats this the same as "skip" / fall
//       back to manual stacking.
//   3 — timed out before reaching terminal state. CI was reachable but
//       didn't finish in `--timeout` seconds.

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

// Bail early after this many consecutive `unknown` results. An `unknown`
// state from `pr-checks` means we couldn't reach the platform CLI / API at
// all — repeating the same call yields the same answer, so there's no
// point burning the full timeout. After `MAX_CONSECUTIVE_UNKNOWN` failures
// we return with `gave_up: true` so callers can distinguish "we couldn't
// even ask CI" from "CI is genuinely still running".
const MAX_CONSECUTIVE_UNKNOWN = 3;

async function pollUntilTerminal({
  platform,
  pr,
  baseUrl,
  intervalMs,
  timeoutMs,
  maxConsecutiveUnknown = MAX_CONSECUTIVE_UNKNOWN,
}) {
  const start = Date.now();
  let polled = 0;
  let last = null;
  let consecutiveUnknown = 0;
  while (true) {
    polled++;
    last = await fetchChecks({ platform, pr, baseUrl });
    if (last.state === 'success' || last.state === 'failure') {
      return {
        ...last,
        polled,
        consecutive_unknown: 0,
        elapsed_seconds: (Date.now() - start) / 1000,
        timed_out: false,
        gave_up: false,
      };
    }
    if (last.state === 'unknown') {
      consecutiveUnknown++;
      if (consecutiveUnknown >= maxConsecutiveUnknown) {
        return {
          ...last,
          polled,
          consecutive_unknown: consecutiveUnknown,
          elapsed_seconds: (Date.now() - start) / 1000,
          timed_out: false,
          gave_up: true,
        };
      }
    } else {
      consecutiveUnknown = 0;
    }
    if (Date.now() - start >= timeoutMs) {
      return {
        ...last,
        polled,
        consecutive_unknown: consecutiveUnknown,
        elapsed_seconds: (Date.now() - start) / 1000,
        timed_out: true,
        gave_up: false,
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
  // gave_up means we couldn't reach the platform at all — surface as
  // platform-unavailable so callers can distinguish from "CI didn't
  // finish in time".
  if (result.gave_up || result.error || result.skipped) process.exit(2);
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
