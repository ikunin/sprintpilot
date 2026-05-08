#!/usr/bin/env node

// Extract a PR / MR number from a platform URL. Centralizes the per-
// platform regex so the autopilot workflow can replace its prose
// "trailing path segment after `/pull/`..." block with a single
// command.
//
// Usage:
//   extract-pr-number.js --url <url> --platform <github|gitlab|bitbucket|gitea>
//
// Output:
//   stdout: the integer PR number (e.g. `123`)
//   stderr: human-readable error on failure
//
// Exit codes:
//   0 — extracted; printed integer to stdout
//   1 — invalid argv
//   2 — URL did not match the platform's PR-number pattern

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');
const { isKnownPlatform } = require('../lib/runtime/platform');

// Per-platform path-segment regex. Each pattern targets the path that
// precedes the integer PR number; we capture the first integer that
// follows. Query strings and fragments are stripped before matching so
// `?tab=...` or `#note_42` tails don't confuse the result. Bitbucket
// supports both Cloud (`/pull-requests/`) and Data Center (`/pull-
// requests/`, `/pullrequests/`); the alternation handles both.
const PATTERNS = {
  github: /\/pull\/(\d+)/,
  gitlab: /\/-\/merge_requests\/(\d+)/,
  bitbucket: /\/(?:pull-requests|pullrequests)\/(\d+)/,
  gitea: /\/pulls\/(\d+)/,
};

function help() {
  log.out('Usage: extract-pr-number.js --url <url> --platform <github|gitlab|bitbucket|gitea>');
}

function stripQueryAndFragment(url) {
  return url.replace(/[?#].*$/, '');
}

function extract(url, platform) {
  const re = PATTERNS[platform];
  if (!re) return null;
  const m = stripQueryAndFragment(String(url || '')).match(re);
  return m ? Number(m[1]) : null;
}

function main() {
  const { opts } = parseArgs(process.argv.slice(2));
  if (opts.help) {
    help();
    process.exit(0);
  }
  const url = opts.url;
  const platform = opts.platform;
  if (!url) {
    log.error('--url is required');
    process.exit(1);
  }
  if (!isKnownPlatform(platform) || platform === 'git_only') {
    log.error(`--platform must be one of github|gitlab|bitbucket|gitea (got '${platform || ''}')`);
    process.exit(1);
  }
  const n = extract(url, platform);
  if (n === null) {
    log.error(`could not extract PR number from URL: ${url}`);
    process.exit(2);
  }
  log.out(String(n));
}

module.exports = { extract, PATTERNS };

if (require.main === module) {
  main();
}
