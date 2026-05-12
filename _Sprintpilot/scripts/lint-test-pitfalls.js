#!/usr/bin/env node

// lint-test-pitfalls.js — scan test files for common LLM-authored mistakes
// that make tests pass locally but fail under different conditions or hide
// real bugs.
//
// Run as part of post-green-gates.js after the GREEN phase. Reports issues
// per file; exits 0 if no issues, 1 if any "block" issue found.
//
// Detected pitfalls:
//   - it.only / describe.only / xit / xdescribe — focused/disabled tests
//   - expect(true).toBe(true) and equivalent tautologies
//   - Promise without await (potential unhandled rejection in test)
//   - process.exit() inside a test (kills the runner)
//   - Hard-coded paths to /tmp / C:\ — not portable
//
// Pure-ish: takes a list of files via argv, reads via fs, prints JSON.

const fs = require('node:fs');
const path = require('node:path');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');

const PITFALLS = [
  {
    id: 'focused_or_skipped',
    severity: 'block',
    re: /\b(?:it|describe)\.only\b|\bxit\b|\bxdescribe\b/g,
    message: 'focused (.only) or skipped (xit/xdescribe) tests',
  },
  {
    id: 'tautological_expect',
    severity: 'block',
    re: /expect\(\s*(true|false|1|0|"")\s*\)\.toBe\(\s*\1\s*\)/g,
    message: 'tautological expect (e.g. expect(true).toBe(true))',
  },
  {
    id: 'process_exit_in_test',
    severity: 'block',
    re: /\bprocess\.exit\(/g,
    message: 'process.exit() inside test source — kills the runner',
  },
  {
    id: 'hardcoded_absolute_path',
    severity: 'warn',
    // Match /tmp/... or C:\... at start of a string literal
    re: /["'](\/tmp\/|[A-Za-z]:\\)/g,
    message: 'hard-coded absolute path — use os.tmpdir() / path.join()',
  },
  {
    id: 'missing_await_on_promise',
    severity: 'warn',
    re: /^\s*(?:fetch|axios|page|request)\s*\(/gm,
    message: 'looks like a promise call without await — verify intent',
  },
];

function help() {
  log.out(
    [
      'Usage: lint-test-pitfalls.js [--json] <files...>',
      '  --json    Emit structured JSON (default: human-readable)',
    ].join('\n'),
  );
}

function scanFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return { file: filePath, error: e.message, issues: [] };
  }
  const issues = [];
  for (const p of PITFALLS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text))) {
      const line = text.slice(0, m.index).split('\n').length;
      issues.push({
        id: p.id,
        severity: p.severity,
        line,
        message: p.message,
        match: m[0],
      });
    }
  }
  return { file: filePath, issues };
}

function main(argv) {
  const { opts, positional } = parseArgs(argv, { booleanFlags: ['json', 'help'] });
  if (opts.help) {
    help();
    return 0;
  }
  if (positional.length === 0) {
    help();
    return 2;
  }

  const reports = positional.map((f) => scanFile(path.resolve(f)));
  let blockCount = 0;
  let warnCount = 0;
  for (const r of reports) {
    for (const i of r.issues) {
      if (i.severity === 'block') blockCount += 1;
      else if (i.severity === 'warn') warnCount += 1;
    }
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ reports, blockCount, warnCount }, null, 2)}\n`);
  } else {
    for (const r of reports) {
      if (r.issues.length === 0) continue;
      log.out(`${r.file}:`);
      for (const i of r.issues) {
        log.out(`  L${i.line} [${i.severity}] ${i.message}: ${i.match}`);
      }
    }
    log.out(`\n${blockCount} blocking, ${warnCount} warning`);
  }
  return blockCount > 0 ? 1 : 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, scanFile, PITFALLS };
