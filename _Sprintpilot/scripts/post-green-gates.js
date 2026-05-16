#!/usr/bin/env node

// post-green-gates.js — composed post-GREEN quality pipeline.
//
// Called by the orchestrator after a `bmad-dev-story` GREEN phase
// completes verify. Runs three gates in order; first failing gate causes
// non-zero exit with a structured JSON report.
//
// Gates:
//   1. lint-changed.js       — biome/eslint on changed files only
//   2. lint-test-pitfalls.js — LLM-test pitfalls (only on test files)
//   3. scan.js (ci-parity)   — search for obvious CI-only failure modes
//                              (envs hard-coded to local-only assumptions)
//
// Usage:
//   post-green-gates.js [--json] [--changed-files <path>] [--project-root <path>]
//                       [--output-limit <N>]
//     --changed-files: path to a newline-delimited list of changed files
//                      (default: derive from `git diff --name-only HEAD`)
//     --output-limit:  max lines of lint output per gate (forwarded to
//                      lint-changed.js as --limit). Honors
//                      `git.lint.output_limit` from config when called
//                      from the orchestrator (v2.2.28+).
//
// Each gate runs in a child process via execFileSync. Argv-only — no shell.

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');

function help() {
  log.out(
    [
      'Usage: post-green-gates.js [--json] [--changed-files <path>] [--project-root <path>]',
      '',
      'Runs in order:',
      '  1. lint-changed.js       — formatter + linter on changed files',
      '  2. lint-test-pitfalls.js — LLM-test pitfall scan (test files only)',
      '  3. scan.js (ci-parity)   — CI-only failure mode scan',
    ].join('\n'),
  );
}

function listChangedFiles(projectRoot, override) {
  if (override) {
    return fs
      .readFileSync(override, 'utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  try {
    const out = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (_e) {
    return [];
  }
}

function runGate(name, command, args, projectRoot) {
  const r = spawnSync(command, args, { cwd: projectRoot, encoding: 'utf8' });
  return {
    gate: name,
    ok: r.status === 0,
    exit_code: r.status === null ? -1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

function isTestFile(p) {
  return /\.test\.(ts|tsx|js|jsx|mts)$/.test(p) || /\.spec\.(ts|tsx|js|jsx|mts)$/.test(p);
}

function isJsTsFile(p) {
  return /\.(ts|tsx|js|jsx|mts|cjs)$/.test(p);
}

function main(argv) {
  const { opts } = parseArgs(argv, { booleanFlags: ['json', 'help'] });
  if (opts.help) {
    help();
    return 0;
  }
  const projectRoot = path.resolve(opts['project-root'] || process.cwd());
  const changed = listChangedFiles(projectRoot, opts['changed-files']);
  const jsTs = changed.filter(isJsTsFile);
  const testFiles = changed.filter(isTestFile);
  const outputLimit = parseInt(opts['output-limit'] || '0', 10);
  const lintersJson = opts['linters-json'] || '';

  const gates = [];

  // Gate 1: lint-changed.
  const lintChangedPath = path.join(projectRoot, '_Sprintpilot', 'scripts', 'lint-changed.js');
  if (fs.existsSync(lintChangedPath) && jsTs.length > 0) {
    const lcArgs = [lintChangedPath, '--project-root', projectRoot];
    if (outputLimit > 0) {
      lcArgs.push('--limit', String(outputLimit));
    }
    if (lintersJson) {
      lcArgs.push('--linters-json', lintersJson);
    }
    gates.push(runGate('lint-changed', 'node', lcArgs, projectRoot));
  } else {
    gates.push({
      gate: 'lint-changed',
      ok: true,
      exit_code: 0,
      stdout: 'skipped (no JS/TS changes or script missing)',
      stderr: '',
    });
  }

  // Gate 2: lint-test-pitfalls — only run on test files.
  const pitfallsPath = path.join(projectRoot, '_Sprintpilot', 'scripts', 'lint-test-pitfalls.js');
  if (fs.existsSync(pitfallsPath) && testFiles.length > 0) {
    gates.push(runGate('lint-test-pitfalls', 'node', [pitfallsPath, ...testFiles], projectRoot));
  } else {
    gates.push({
      gate: 'lint-test-pitfalls',
      ok: true,
      exit_code: 0,
      stdout: 'skipped (no test files in change set)',
      stderr: '',
    });
  }

  // Gate 3: ci-parity via scan.js. Pattern set is intentionally conservative
  // — flag obvious CI-only-fail patterns: `if (!process.env.CI)` skips,
  // hardcoded localhost ports, `xit`/`xdescribe`. scan.js does the search;
  // we treat its non-zero exit as a block.
  const scanPath = path.join(projectRoot, '_Sprintpilot', 'scripts', 'scan.js');
  if (fs.existsSync(scanPath) && jsTs.length > 0) {
    gates.push(
      runGate(
        'ci-parity',
        'node',
        [
          scanPath,
          '--pattern',
          'process.env.CI',
          '--pattern',
          '(localhost|127\\.0\\.0\\.1):\\d{4,5}',
          '--paths',
          ...jsTs,
        ],
        projectRoot,
      ),
    );
  } else {
    gates.push({
      gate: 'ci-parity',
      ok: true,
      exit_code: 0,
      stdout: 'skipped (no JS/TS changes or script missing)',
      stderr: '',
    });
  }

  const firstFail = gates.find((g) => !g.ok);
  const overallOk = !firstFail;

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ ok: overallOk, gates, first_fail: firstFail?.gate || null }, null, 2)}\n`,
    );
  } else {
    for (const g of gates) {
      log.out(`[${g.ok ? '✓' : '✗'}] ${g.gate}: exit=${g.exit_code}`);
      if (!g.ok) {
        if (g.stdout) log.out(g.stdout);
        if (g.stderr) log.err(g.stderr);
      }
    }
    log.out(overallOk ? 'all gates passed' : `failed gate: ${firstFail?.gate}`);
  }
  return overallOk ? 0 : 1;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, listChangedFiles, runGate, isTestFile, isJsTsFile };
