#!/usr/bin/env node

// lint-test-pitfalls — pattern-matching lint that catches common test
// patterns that pass locally but fail in CI (lifecycle hooks loading
// absent resources, async loop leaks, fixture-by-literal-path, etc.).
//
// Severity is always at most warning — the script never halts the
// autopilot. The post-GREEN gate surfaces matches in the session
// summary so the dev can react before the next story stacks on top.
//
// Usage:
//   lint-test-pitfalls.js [--test-dir <path>] [--config <path>]
//                         [--format text|json] [<additional dirs>...]
//
// Defaults:
//   --test-dir          common test directories under cwd
//                       (`tests/`, `test/`, `__tests__/`, `spec/`)
//                       plus loose-file conventions (*_test.go, *.test.ts).
//   --config            tries _Sprintpilot/modules/autopilot/test-pitfalls.yaml
//                       first (project override), then
//                       _Sprintpilot/templates/test-pitfalls.yaml (default).
//   --format            text — one finding per line: <file>:<line>: <id>: <msg>
//                       json — { findings: [...], summary: { total, byLang } }
//
// Exit codes:
//   0 — always (this script never halts).

const fs = require('node:fs');
const path = require('node:path');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');

const EXT_LANG = [
  { re: /\.py$/i, lang: 'python' },
  { re: /\.(js|jsx|ts|tsx)$/i, lang: 'js-ts' },
  { re: /\.go$/i, lang: 'go' },
  { re: /\.rs$/i, lang: 'rust' },
  { re: /\.rb$/i, lang: 'ruby' },
];

const DEFAULT_TEST_DIRS = ['tests', 'test', '__tests__', 'spec'];
// File-name patterns that signal "this is a test file" outside the canonical
// test directories — go's *_test.go convention, jest/vitest *.test.ts, etc.
const TEST_FILE_RE =
  /(\.test\.(js|jsx|ts|tsx)$|_test\.(go|py)$|_spec\.rb$|test_[\w-]+\.py$|\.spec\.(js|jsx|ts|tsx)$)/i;

function classifyFile(filePath) {
  for (const { re, lang } of EXT_LANG) {
    if (re.test(filePath)) return lang;
  }
  return null;
}

// Recursive walk that skips heavy / cached directories.
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

function* walkDir(root, predicate) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') {
      // Allow leading-dot-named test files (e.g. .test.js?) but skip dotted
      // directories like `.git`, `.venv` — predicate filters dot-files
      // explicitly when we don't recurse into them.
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      if (entry.isDirectory()) continue;
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

function discoverTestFiles(rootDir, explicit) {
  const found = new Set();
  if (explicit && explicit.length > 0) {
    for (const dir of explicit) {
      const abs = path.isAbsolute(dir) ? dir : path.join(rootDir, dir);
      if (!fs.existsSync(abs)) continue;
      const stat = fs.statSync(abs);
      if (stat.isFile()) {
        if (classifyFile(abs)) found.add(abs);
        continue;
      }
      // A directory: every supported source file under it is "a test" if the
      // user pointed us at it explicitly. We don't try to be clever about
      // which files are "real" tests — the patterns themselves are the gate.
      for (const f of walkDir(abs, (p) => classifyFile(p) !== null)) {
        found.add(f);
      }
    }
    return Array.from(found);
  }
  // Auto-discovery: classic test dirs first.
  for (const dir of DEFAULT_TEST_DIRS) {
    const abs = path.join(rootDir, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of walkDir(abs, (p) => classifyFile(p) !== null)) {
      found.add(f);
    }
  }
  // Plus loose-file conventions across the whole tree.
  for (const f of walkDir(rootDir, (p) => TEST_FILE_RE.test(p) && classifyFile(p) !== null)) {
    found.add(f);
  }
  return Array.from(found);
}

// =============================================================================
// Pattern-bundle YAML reader (constrained shape; no js-yaml dep).
// =============================================================================
//
// Handles only the documented shape:
//   patterns:
//     - id: ...
//       lang: ...
//       grep: '...'
//       message: "..."
//
// Values are either bare scalars, single-quoted, or double-quoted. Embedded
// escaped quotes (\\\" or \\\\) in a quoted scalar are preserved as written.

function unquote(raw) {
  const t = raw.trim();
  if (t === '') return '';
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
}

function parsePatternBundle(text) {
  const lines = text.split(/\r?\n/);
  // Strip leading comment-only / blank lines until we see `patterns:`.
  let i = 0;
  for (; i < lines.length; i++) {
    if (/^patterns:\s*$/.test(lines[i])) {
      i++;
      break;
    }
  }
  const patterns = [];
  let current = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const headerMatch = line.match(/^\s*-\s+([A-Za-z_][\w-]*):\s*(.*)$/);
    if (headerMatch) {
      if (current) patterns.push(current);
      current = {};
      current[headerMatch[1]] = unquote(headerMatch[2]);
      continue;
    }
    const fieldMatch = line.match(/^\s+([A-Za-z_][\w-]*):\s*(.*)$/);
    if (fieldMatch && current) {
      current[fieldMatch[1]] = unquote(fieldMatch[2]);
    }
    // Anything else terminates the patterns: list (or is a malformed line we
    // silently skip — pattern bundles are user-editable).
  }
  if (current) patterns.push(current);
  return patterns;
}

function loadPatterns({ projectRoot, configPath }) {
  const candidates = [];
  if (configPath) candidates.push(configPath);
  candidates.push(
    path.join(projectRoot, '_Sprintpilot', 'modules', 'autopilot', 'test-pitfalls.yaml'),
  );
  candidates.push(path.join(projectRoot, '_Sprintpilot', 'templates', 'test-pitfalls.yaml'));
  // Also support running from the package root (developer mode).
  candidates.push(path.resolve(__dirname, '..', 'templates', 'test-pitfalls.yaml'));

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        const text = fs.readFileSync(c, 'utf8');
        return { source: c, patterns: parsePatternBundle(text) };
      } catch {
        // try next
      }
    }
  }
  return { source: null, patterns: [] };
}

// =============================================================================
// Pattern matching
// =============================================================================

function compilePattern(pat) {
  // We compile the regex on first use. Errors here surface as a single info
  // message and the pattern is dropped — a bad user override should never
  // crash the lint.
  try {
    pat._grepRe = pat.grep ? new RegExp(pat.grep) : null;
    pat._notGrepRe = pat.not_grep ? new RegExp(pat.not_grep) : null;
    pat._compiled = true;
    pat._error = null;
  } catch (e) {
    pat._compiled = false;
    pat._error = e.message;
  }
  return pat;
}

function fileMatchesPattern(text, pat) {
  if (!pat._grepRe) return null;
  if (pat._notGrepRe && pat._notGrepRe.test(text)) return null;
  // Scan line-by-line so we can report file:line.
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (pat._grepRe.test(lines[i])) {
      return { line: i + 1, snippet: lines[i].trim().slice(0, 200) };
    }
  }
  // Also try a multiline match for patterns that need to span lines (the
  // regex itself decides; if the per-line test missed but the full text
  // matches, surface line 1 as best-effort).
  if (pat._grepRe.test(text)) {
    return { line: 1, snippet: '<multi-line match>' };
  }
  return null;
}

function lintFile(filePath, patterns) {
  const lang = classifyFile(filePath);
  if (!lang) return [];
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const findings = [];
  for (const pat of patterns) {
    if (!pat._compiled) compilePattern(pat);
    if (!pat._compiled || pat._error) continue;
    if (pat.lang && pat.lang !== lang) continue;
    const hit = fileMatchesPattern(text, pat);
    if (hit) {
      findings.push({
        file: filePath,
        line: hit.line,
        id: pat.id,
        lang: pat.lang || lang,
        runner: pat.runner || null,
        severity: pat.severity || 'warning',
        message: pat.message || '',
        snippet: hit.snippet,
      });
    }
  }
  return findings;
}

// =============================================================================
// Main
// =============================================================================

function help() {
  log.out(
    'Usage: lint-test-pitfalls.js [--test-dir <path>]... [--config <path>] [--format text|json]',
  );
}

function reportText(findings) {
  for (const f of findings) {
    log.out(`${f.file}:${f.line}: ${f.severity}: ${f.id}: ${f.message}`);
  }
  log.out(`\n${findings.length} finding(s).`);
}

function reportJson(findings, source, scannedCount) {
  const byLang = {};
  for (const f of findings) {
    byLang[f.lang] = (byLang[f.lang] || 0) + 1;
  }
  log.out(
    JSON.stringify({
      source,
      scanned: scannedCount,
      findings,
      summary: { total: findings.length, byLang },
    }),
  );
}

function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));
  if (opts.help) {
    help();
    process.exit(0);
  }
  const projectRoot = process.cwd();
  // --test-dir is single-value; for multiple dirs, pass them as positional
  // arguments after `--`. Both feeds are union'd below.
  const explicitDirs = []
    .concat(opts['test-dir'] ? [opts['test-dir']] : [])
    .concat(positional || []);
  const format = opts.format || 'text';
  const configPath = opts.config;

  const { source, patterns } = loadPatterns({ projectRoot, configPath });
  for (const p of patterns) compilePattern(p);
  const compiled = patterns.filter((p) => p._compiled && !p._error);
  const failed = patterns.filter((p) => p._error);
  if (failed.length > 0 && format === 'text') {
    for (const p of failed) {
      log.err(`pattern ${p.id || '<no id>'}: bad regex (${p._error}) — skipping`);
    }
  }

  const files = discoverTestFiles(projectRoot, explicitDirs);
  const findings = [];
  for (const file of files) {
    findings.push(...lintFile(file, compiled));
  }

  if (format === 'json') {
    reportJson(findings, source, files.length);
  } else {
    reportText(findings);
  }
  process.exit(0);
}

module.exports = {
  classifyFile,
  TEST_FILE_RE,
  parsePatternBundle,
  compilePattern,
  fileMatchesPattern,
  lintFile,
  discoverTestFiles,
};

if (require.main === module) {
  main();
}
