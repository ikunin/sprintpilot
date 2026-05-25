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

function buildCmd({ scope, changedFiles, testFiles, profile }) {
  const userCmd = userOverride(profile, scope);
  if (userCmd) return userCmd;
  if (scope === 'full') return 'npx jest';
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
    return 'npx jest';
  }
  const argv = all.map(quoteArg).join(' ');
  return `npx jest --findRelatedTests ${argv}`;
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

module.exports = { NAME, detect, buildCmd };
