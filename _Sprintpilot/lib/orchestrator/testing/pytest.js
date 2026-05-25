// pytest adapter — affected/full test commands for pytest projects.
//
// pytest has no native "changed-files → affected tests" flag in the
// stdlib, but the pytest-testmon plugin (when installed and a
// .testmondata cache exists) does dependency tracking via coverage.
// We use it when available; otherwise fall back to running tests in
// the same dirs as the changed source files (path-convention map).
//
// detect(projectRoot)  → boolean
// buildCmd({ scope, changedFiles, testFiles, profile }) → string | null

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const NAME = 'pytest';

function detect(projectRoot) {
  if (!projectRoot) return false;
  if (fileExists(path.join(projectRoot, 'pytest.ini'))) return true;
  if (fileExists(path.join(projectRoot, 'conftest.py'))) return true;
  // pyproject.toml with a [tool.pytest.ini_options] section, or any
  // pyproject.toml + a tests/ dir, is treated as a pytest project.
  const pyproject = path.join(projectRoot, 'pyproject.toml');
  if (fileExists(pyproject)) {
    try {
      const text = fs.readFileSync(pyproject, 'utf8');
      if (text.includes('[tool.pytest')) return true;
      if (text.includes('pytest')) return true;
    } catch (_e) {
      // fall through
    }
  }
  // setup.cfg with [tool:pytest]
  const setupCfg = path.join(projectRoot, 'setup.cfg');
  if (fileExists(setupCfg)) {
    try {
      if (fs.readFileSync(setupCfg, 'utf8').includes('[tool:pytest]')) return true;
    } catch (_e) {
      // fall through
    }
  }
  return false;
}

function buildCmd({ scope, changedFiles, testFiles, profile, projectRoot, excludeTestIds }) {
  const userCmd = userOverride(profile, scope);
  if (userCmd) return userCmd;
  const excludeArg = buildExcludeFlags(excludeTestIds);
  const append = (cmd) => (excludeArg ? `${cmd} ${excludeArg}` : cmd);
  if (scope === 'full') return append('pytest');
  // affected — try testmon first (it's stateful and most accurate)
  if (projectRoot && fileExists(path.join(projectRoot, '.testmondata'))) {
    return append('pytest --testmon');
  }
  // Otherwise: map changed source dirs → tests/ subdirs, plus pin the
  // story's new test files explicitly.
  const tests = Array.isArray(testFiles)
    ? testFiles.filter((f) => typeof f === 'string' && f.length > 0)
    : [];
  const changed = Array.isArray(changedFiles)
    ? changedFiles.filter((f) => typeof f === 'string' && f.length > 0)
    : [];
  const dirs = inferTestDirs(changed);
  const all = Array.from(new Set([...dirs, ...tests]));
  if (all.length === 0) {
    // Nothing identifiable — fall back to full.
    return append('pytest');
  }
  return append(`pytest ${all.map(quoteArg).join(' ')}`);
}

// v2.4.0 — quarantine exclude flags. pytest supports `--ignore=<path>`
// for entire files/dirs and `--deselect <nodeid>` for specific test
// node IDs (`path/to/test.py::class::method`). We split test IDs by
// presence of `::` and emit the appropriate flag for each.
function buildExcludeFlags(testIds) {
  if (!Array.isArray(testIds) || testIds.length === 0) return '';
  const args = [];
  for (const id of testIds) {
    if (typeof id !== 'string' || !id) continue;
    if (id.includes('::')) {
      args.push(`--deselect ${quoteArg(id)}`);
    } else if (isLikelyPath(id)) {
      args.push(`--ignore=${quoteArg(id)}`);
    }
  }
  return args.join(' ');
}

function isLikelyPath(id) {
  return typeof id === 'string' && (id.includes('/') || /\.py$/.test(id));
}

// Map a changed source file under `src/foo/bar.py` to candidate test
// dirs: `tests/foo/`, `test/foo/`. Returns unique entries.
function inferTestDirs(changedFiles) {
  const out = new Set();
  for (const f of changedFiles) {
    // Already a test file? Pin it directly.
    if (/(^|\/)tests?\//.test(f) && /test_.+\.py$|_test\.py$/.test(f)) {
      out.add(f);
      continue;
    }
    // src/<sub>/file.py → tests/<sub>/, test/<sub>/
    const m = f.match(/^(?:src\/)?([^/]+)\//);
    if (m) {
      out.add(`tests/${m[1]}/`);
      out.add(`test/${m[1]}/`);
    }
  }
  return Array.from(out);
}

function userOverride(profile, scope) {
  if (!profile) return null;
  if (scope === 'full') return profile.testing_commands_full || null;
  return profile.testing_commands_affected || null;
}

function fileExists(p) {
  try { return fs.existsSync(p); } catch (_e) { return false; }
}

function quoteArg(a) {
  return /[ \t"'`$\\!?*&|;<>(){}]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a;
}

module.exports = { NAME, detect, buildCmd, inferTestDirs, buildExcludeFlags };
