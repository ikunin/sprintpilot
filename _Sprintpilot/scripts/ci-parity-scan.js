#!/usr/bin/env node

// ci-parity-scan — surface "local green / CI red" risk.
//
// pytest reports `N passed, M skipped` and the autopilot treats `M skipped`
// as fine — but many of those skips are environmental (postgres not
// running, model files not cached, GPU absent). On a fresh CI runner the
// same tests RUN and may FAIL. The autopilot has no way to distinguish
// "intentionally skipped" from "skipped because my workstation lacks X
// — would FAIL in CI".
//
// This script enumerates skipped tests across every supported runner
// (pytest, jest, vitest, go-test, cargo-test, rspec), classifies each
// skip's reason against configurable patterns, and emits a structured
// result the workflow can gate on.
//
// Output (always JSON to stdout):
//   {
//     "runners": [{ name, lang, detected, skips: [...] }, ...],
//     "summary": {
//       "intentional": <N>,
//       "env_dependent": <N>,
//       "unknown": <N>,
//       "would_run_in_ci": <bool>,   // true when env_dependent > 0
//       "byPattern": { "<pattern>": <N>, ... }
//     }
//   }
//
// Exit code: always 0. The workflow gate decides whether to surface a
// warning based on `summary.would_run_in_ci`.

const fs = require('node:fs');
const path = require('node:path');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');
const { ADAPTERS, adapterByName } = require('../lib/runtime/test-runners');

// File-extension classification + skip dirs reuses what lint-test-pitfalls
// uses; intentionally duplicated here so the two scripts stay independent.
const EXT_LANG = [
  { re: /\.py$/i, lang: 'python' },
  { re: /\.(js|jsx|ts|tsx)$/i, lang: 'js-ts' },
  { re: /\.go$/i, lang: 'go' },
  { re: /\.rs$/i, lang: 'rust' },
  { re: /\.rb$/i, lang: 'ruby' },
];

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.pytest_cache',
  '.mypy_cache',
  '.cargo',
  'coverage',
  '.next',
  '.turbo',
]);

function classifyByExt(file) {
  for (const { re, lang } of EXT_LANG) if (re.test(file)) return lang;
  return null;
}

function* walkDir(root, predicate) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      continue;
    }
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkDir(full, predicate);
      continue;
    }
    if (predicate(full)) yield full;
  }
}

const TEST_FILE_RE =
  /(\.test\.(js|jsx|ts|tsx)$|\.spec\.(js|jsx|ts|tsx)$|_test\.(go|py)$|_spec\.rb$|test_[\w-]+\.py$)/i;
const DEFAULT_TEST_DIRS = ['tests', 'test', '__tests__', 'spec'];

function discoverTestFiles(rootDir, explicit) {
  const found = new Set();
  if (explicit && explicit.length > 0) {
    for (const dir of explicit) {
      const abs = path.isAbsolute(dir) ? dir : path.join(rootDir, dir);
      if (!fs.existsSync(abs)) continue;
      const stat = fs.statSync(abs);
      if (stat.isFile()) {
        if (classifyByExt(abs)) found.add(abs);
        continue;
      }
      for (const f of walkDir(abs, (p) => classifyByExt(p) !== null)) {
        found.add(f);
      }
    }
    return Array.from(found);
  }
  for (const dir of DEFAULT_TEST_DIRS) {
    const abs = path.join(rootDir, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of walkDir(abs, (p) => classifyByExt(p) !== null)) {
      found.add(f);
    }
  }
  for (const f of walkDir(rootDir, (p) => TEST_FILE_RE.test(p) && classifyByExt(p) !== null)) {
    found.add(f);
  }
  return Array.from(found);
}

// =============================================================================
// Classification
// =============================================================================
//
// Default keyword bundles per the RFC. Both lists are matched case-
// insensitively against the skip's reason string. A skip can be classified
// only when at least one list matches; otherwise it lands in `unknown`
// (which the workflow can choose to ignore or surface for triage).

const DEFAULT_INTENTIONAL = ['slow', 'smoke', 'manual', 'wip', 'flaky', 'todo', 'pending'];

const DEFAULT_ENV_DEPENDENT = [
  'postgres',
  'database',
  'sqlite-only',
  'redis',
  'kafka',
  'rabbitmq',
  'gpu',
  'cuda',
  'model file',
  'weights',
  'checkpoint',
  'audio device',
  'hardware',
  'fixture directory',
  'fixtures directory',
  'test data',
  'integration env',
  'staging',
  'network',
  'internet',
  'docker',
];

function buildClassifier(intentional, envDependent) {
  const intRe = new RegExp(intentional.map(escRegex).join('|'), 'i');
  const envRe = new RegExp(envDependent.map(escRegex).join('|'), 'i');
  return (reason) => {
    const r = (reason || '').toString();
    if (envRe.test(r)) return 'env_dependent';
    if (intRe.test(r)) return 'intentional';
    return 'unknown';
  };
}

function escRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// =============================================================================
// Lightweight YAML reader for the ci_parity block (no js-yaml dep).
// =============================================================================
//
// Reads only the documented shape:
//   ci_parity:
//     enabled: true
//     patterns:
//       intentional: [a, b, c]
//       env_dependent: [x, y, z]
//
// Anything else is ignored — bad config never crashes the script; we fall
// back to defaults.

function readConfig(projectRoot) {
  const file = path.join(projectRoot, '_Sprintpilot', 'modules', 'autopilot', 'config.yaml');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const out = { enabled: true, intentional: null, envDependent: null };
  // Walk under the `ci_parity:` block. Track the indent of the header
  // line so a sibling section at the same indent (e.g. `test_pitfalls:`
  // appearing after `ci_parity:` under `autopilot:`) cleanly terminates
  // the block instead of leaking siblings' `enabled:` keys into us.
  const lines = text.split(/\r?\n/);
  let blockIndent = -1;
  let inPatterns = false;
  for (const raw of lines) {
    const headerMatch = raw.match(/^(\s*)ci_parity:\s*$/);
    if (headerMatch) {
      blockIndent = headerMatch[1].length;
      inPatterns = false;
      continue;
    }
    if (blockIndent < 0) continue;
    if (raw.trim() === '') continue;
    const lineIndent = (raw.match(/^\s*/) || [''])[0].length;
    if (lineIndent <= blockIndent) {
      // A non-blank line at the header's indent (or shallower) ends the
      // block — sibling section, top-level key, or end of `autopilot:`.
      blockIndent = -1;
      continue;
    }
    const enabled = raw.match(/^\s+enabled:\s*(true|false)\s*$/);
    if (enabled) {
      out.enabled = enabled[1] === 'true';
      continue;
    }
    if (/^\s+patterns:\s*$/.test(raw)) {
      inPatterns = true;
      continue;
    }
    if (inPatterns) {
      const intMatch = raw.match(/^\s+intentional:\s*\[([^\]]*)\]/);
      if (intMatch) out.intentional = parseFlowList(intMatch[1]);
      const envMatch = raw.match(/^\s+env_dependent:\s*\[([^\]]*)\]/);
      if (envMatch) out.envDependent = parseFlowList(envMatch[1]);
    }
  }
  return out;
}

function parseFlowList(s) {
  return s
    .split(',')
    .map((x) => x.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

// =============================================================================
// Main
// =============================================================================

function help() {
  log.out(
    'Usage: ci-parity-scan.js [--test-dir <path>] [--runner <name>]... [--config <path>] [<paths>...]',
  );
}

function emit(payload) {
  log.out(JSON.stringify(payload));
}

function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));
  if (opts.help) {
    help();
    process.exit(0);
  }

  const projectRoot = process.cwd();
  const explicitDirs = []
    .concat(opts['test-dir'] ? [opts['test-dir']] : [])
    .concat(positional || []);

  const config = readConfig(projectRoot) || {
    enabled: true,
    intentional: null,
    envDependent: null,
  };
  if (!config.enabled) {
    emit({
      runners: [],
      summary: {
        intentional: 0,
        env_dependent: 0,
        unknown: 0,
        would_run_in_ci: false,
        byPattern: {},
        skipped: 'ci_parity.enabled = false',
      },
    });
    return;
  }

  const intentional = config.intentional || DEFAULT_INTENTIONAL;
  const envDependent = config.envDependent || DEFAULT_ENV_DEPENDENT;
  const classify = buildClassifier(intentional, envDependent);

  // --runner can be passed multiple times in the future; for now accept
  // a single value.
  const onlyRunner = opts.runner || null;
  const adapters = onlyRunner ? ADAPTERS.filter((a) => a.name === onlyRunner) : ADAPTERS;

  const files = discoverTestFiles(projectRoot, explicitDirs);
  const runners = [];
  let totalIntentional = 0;
  let totalEnvDep = 0;
  let totalUnknown = 0;
  const byPattern = {};

  for (const adapter of adapters) {
    const detected = adapter.detect(projectRoot);
    if (!detected) {
      runners.push({ name: adapter.name, lang: adapter.lang, detected: false, skips: [] });
      continue;
    }
    const raw = adapter.enumerateSkips(files);
    const classified = raw.map((s) => {
      const cls = classify(s.reason);
      if (cls === 'intentional') totalIntentional++;
      else if (cls === 'env_dependent') totalEnvDep++;
      else totalUnknown++;
      // Record the keyword that triggered classification (best-effort: first
      // matching token in the relevant list).
      const matched = matchKeyword(
        s.reason,
        cls === 'intentional' ? intentional : cls === 'env_dependent' ? envDependent : [],
      );
      if (matched) byPattern[matched] = (byPattern[matched] || 0) + 1;
      return { ...s, classified_as: cls, matched_pattern: matched };
    });
    runners.push({
      name: adapter.name,
      lang: adapter.lang,
      detected: true,
      skips: classified,
    });
  }

  emit({
    runners,
    summary: {
      intentional: totalIntentional,
      env_dependent: totalEnvDep,
      unknown: totalUnknown,
      would_run_in_ci: totalEnvDep > 0,
      byPattern,
    },
  });
}

function matchKeyword(reason, list) {
  if (!list || !list.length) return null;
  const r = (reason || '').toLowerCase();
  for (const k of list) {
    if (r.includes(k.toLowerCase())) return k;
  }
  return null;
}

module.exports = {
  buildClassifier,
  classifyByExt,
  discoverTestFiles,
  readConfig,
  parseFlowList,
  matchKeyword,
  DEFAULT_INTENTIONAL,
  DEFAULT_ENV_DEPENDENT,
  // re-export adapters so callers can drive them directly
  ADAPTERS,
  adapterByName,
};

if (require.main === module) {
  main();
}
