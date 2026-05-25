// jest adapter — affected/full test commands for Jest projects.
//
// Jest exposes `--findRelatedTests <source-files...>` which traces the
// module graph from each source file to the tests that import it. We
// hand it the changed files plus the new test files for the story so
// both indirect and direct coverage runs.
//
// detect(projectRoot)  → boolean
// buildCmd({ scope, changedFiles, testFiles, profile }) → string | null

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const NAME = 'jest';

function detect(projectRoot) {
  if (!projectRoot) return false;
  for (const f of ['jest.config.ts', 'jest.config.js', 'jest.config.cjs', 'jest.config.mjs']) {
    if (fileExists(path.join(projectRoot, f))) return true;
  }
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fileExists(pkgPath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.jest && typeof pkg.jest === 'object') return true;
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    return !!deps.jest;
  } catch (_e) {
    return false;
  }
}

function buildCmd({ scope, changedFiles, testFiles, profile, excludeTestIds }) {
  const userCmd = userOverride(profile, scope);
  if (userCmd) return userCmd;
  const excludeArg = buildExcludeFlags(excludeTestIds);
  const append = (cmd) => (excludeArg ? `${cmd} ${excludeArg}` : cmd);
  if (scope === 'full') return append('npx jest');
  // affected
  const changed = Array.isArray(changedFiles)
    ? changedFiles.filter((f) => typeof f === 'string' && f.length > 0)
    : [];
  const tests = Array.isArray(testFiles)
    ? testFiles.filter((f) => typeof f === 'string' && f.length > 0)
    : [];
  // Jest's --findRelatedTests is strict: it ignores any positional
  // arg that doesn't itself trace back to a test. So we pass the
  // union of changed source files AND new test files — Jest figures
  // out the rest from its own graph.
  const all = Array.from(new Set([...changed, ...tests]));
  if (all.length === 0) {
    // Nothing identifiable — fall back to full so we don't silently skip.
    // The scope resolver also catches this case, but adapter-side defense
    // is cheap.
    return append('npx jest');
  }
  const argv = all.map(quoteArg).join(' ');
  return append(`npx jest --findRelatedTests ${argv}`);
}

// v2.4.0 — quarantine exclude flags. Jest accepts a single
// `--testPathIgnorePatterns` argument; we OR-join path-shaped IDs into
// a single alternation regex so all flagged tests are skipped. Non-path
// IDs are dropped (the decisions log preserves the original for human
// review).
function buildExcludeFlags(testIds) {
  if (!Array.isArray(testIds) || testIds.length === 0) return '';
  const paths = testIds.filter((id) => isLikelyPath(id));
  if (paths.length === 0) return '';
  const escaped = paths.map(escapeRegex).join('|');
  return `--testPathIgnorePatterns ${quoteArg(escaped)}`;
}

function isLikelyPath(id) {
  return typeof id === 'string' && (id.includes('/') || /\.(test|spec)\.[tj]sx?$/.test(id));
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

module.exports = { NAME, detect, buildCmd, buildExcludeFlags };
