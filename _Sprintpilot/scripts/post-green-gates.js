#!/usr/bin/env node

// post-green-gates — run all post-GREEN advisory gates in one shot so the
// autopilot workflow only needs ONE line of prose for them. Today: the
// test-pitfalls lint (RFC #4) and the CI-parity scan (RFC #1). Both are
// non-blocking warnings; this helper aggregates their output into a
// summary string the workflow can pass to sync-status.js.
//
// Each gate respects its enabled-flag in
// _Sprintpilot/modules/autopilot/config.yaml and degrades gracefully when
// the underlying script can't run.
//
// Usage:
//   post-green-gates.js [--project-root <path>]
//
// Output (JSON to stdout):
//   {
//     "test_pitfalls": "<summary>" | "skipped" | "clean",
//     "ci_parity_uncertain": "true" | "" ,
//     "ci_parity_warning": "<msg>" | ""
//   }
//
// Exit code: always 0 (these gates never halt).

const fs = require('node:fs');
const path = require('node:path');

const { parseArgs } = require('../lib/runtime/args');
const { tryRun } = require('../lib/runtime/spawn');
const log = require('../lib/runtime/log');

const SCRIPT_DIR = __dirname;

function readConfigEnabled(projectRoot, sectionName) {
  // Lightweight check: returns true unless the section explicitly says
  // `enabled: false`. The full readConfig in each gate's own script
  // handles patterns / overrides — we just gate on/off here.
  const file = path.join(projectRoot, '_Sprintpilot', 'modules', 'autopilot', 'config.yaml');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return true; // missing config → keep gate enabled
  }
  const lines = text.split(/\r?\n/);
  let blockIndent = -1;
  for (const raw of lines) {
    const headerRe = new RegExp(`^(\\s*)${sectionName}:\\s*$`);
    const headerMatch = raw.match(headerRe);
    if (headerMatch) {
      blockIndent = headerMatch[1].length;
      continue;
    }
    if (blockIndent < 0) continue;
    if (raw.trim() === '') continue;
    const lineIndent = (raw.match(/^\s*/) || [''])[0].length;
    if (lineIndent <= blockIndent) {
      blockIndent = -1;
      continue;
    }
    const m = raw.match(/^\s+enabled:\s*(true|false)\s*$/);
    if (m) return m[1] === 'true';
  }
  return true;
}

async function runPitfalls(projectRoot) {
  if (!readConfigEnabled(projectRoot, 'test_pitfalls')) return 'skipped';
  const r = await tryRun(
    'node',
    [path.join(SCRIPT_DIR, 'lint-test-pitfalls.js'), '--format', 'json'],
    { cwd: projectRoot, timeoutMs: 60_000 },
  );
  if (r.exitCode !== 0) return 'skipped';
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return 'skipped';
  }
  const total = parsed?.summary?.total || 0;
  if (total === 0) return 'clean';
  const byLang = parsed?.summary?.byLang || {};
  const byLangText = Object.entries(byLang)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  return `${total} finding(s)${byLangText ? `: ${byLangText}` : ''}`;
}

async function runCiParity(projectRoot) {
  if (!readConfigEnabled(projectRoot, 'ci_parity')) {
    return { uncertain: '', warning: '' };
  }
  const r = await tryRun('node', [path.join(SCRIPT_DIR, 'ci-parity-scan.js')], {
    cwd: projectRoot,
    timeoutMs: 60_000,
  });
  if (r.exitCode !== 0) return { uncertain: '', warning: '' };
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return { uncertain: '', warning: '' };
  }
  if (!parsed?.summary?.would_run_in_ci) return { uncertain: '', warning: '' };
  const env = parsed.summary.env_dependent || 0;
  const patterns = Object.keys(parsed.summary.byPattern || {}).join(', ');
  return {
    uncertain: 'true',
    warning: `WARN: ${env} test${env === 1 ? '' : 's'} skipped due to local env (matched: ${patterns}). These WILL execute in CI.`,
  };
}

async function main() {
  const { opts } = parseArgs(process.argv.slice(2));
  const projectRoot = opts['project-root'] || process.cwd();
  const [pitfalls, ciParity] = await Promise.all([
    runPitfalls(projectRoot),
    runCiParity(projectRoot),
  ]);
  log.out(
    JSON.stringify({
      test_pitfalls: pitfalls,
      ci_parity_uncertain: ciParity.uncertain,
      ci_parity_warning: ciParity.warning,
    }),
  );
}

module.exports = { readConfigEnabled, runPitfalls, runCiParity };

if (require.main === module) {
  main().catch((e) => {
    log.error(e.message || String(e));
    process.exit(0); // never halt
  });
}
