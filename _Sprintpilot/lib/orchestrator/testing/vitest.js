// vitest adapter — affected/full test commands for Vitest projects.
//
// Vitest's `--changed <ref>` flag walks its module graph from the diff
// against <ref> to compute affected tests. Pairing that with positional
// test-file args lets us pin new tests authored during the story while
// still picking up indirect deps. This is the workflow we recommend
// to the LLM via the dev-story template slot.
//
// detect(projectRoot)  → boolean
// buildCmd({ scope, changedFiles, testFiles, profile, baseRef }) → string | null

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const NAME = 'vitest';

function detect(projectRoot) {
  if (!projectRoot) return false;
  // Config-file presence is the strongest signal.
  for (const f of ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mjs', 'vitest.config.cjs']) {
    if (fileExists(path.join(projectRoot, f))) return true;
  }
  // Fall through to package.json dep scan.
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fileExists(pkgPath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (deps.vitest) return true;
    // Some monorepos use `@vitest/...` packages but not `vitest` at the root.
    // Treat any @vitest/* as a vitest project.
    return Object.keys(deps).some((k) => k.startsWith('@vitest/'));
  } catch (_e) {
    return false;
  }
}

function buildCmd({ scope, testFiles, profile, baseRef, excludeTestIds }) {
  const userCmd = userOverride(profile, scope);
  if (userCmd) return userCmd;
  const excludeArg = buildExcludeFlags(excludeTestIds);
  const base = baseRef || (profile && profile.base_branch) || 'main';
  const files = Array.isArray(testFiles)
    ? testFiles.filter((f) => typeof f === 'string' && f.length > 0)
    : [];
  // `vitest run --changed <ref>` walks the dep graph; appending explicit
  // test file paths pins the new RED/GREEN tests so they always run.
  const filesArg = files.length > 0 ? ` ${files.map(quoteArg).join(' ')}` : '';
  const cmd = scope === 'full'
    ? 'npx vitest run'
    : `npx vitest run --changed origin/${base}${filesArg}`;
  return excludeArg ? `${cmd} ${excludeArg}` : cmd;
}

// v2.4.0 — quarantine exclude flags. Vitest accepts repeated `--exclude
// <pattern>` flags for path-shaped IDs; non-path IDs (test names) are
// dropped here and surfaced via the decisions log instead. The user
// reviewer is the source-of-truth for those cases.
function buildExcludeFlags(testIds) {
  if (!Array.isArray(testIds) || testIds.length === 0) return '';
  const paths = testIds.filter((id) => isLikelyPath(id));
  if (paths.length === 0) return '';
  return paths.map((p) => `--exclude ${quoteArg(p)}`).join(' ');
}

function isLikelyPath(id) {
  return typeof id === 'string' && (id.includes('/') || /\.(test|spec)\.[tj]sx?$/.test(id));
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
  // Conservative: if the path has no shell metachars, leave bare; otherwise
  // wrap in single quotes (we never run through a shell — the LLM does —
  // but this keeps the command human-pasteable too).
  return /[ \t"'`$\\!?*&|;<>(){}]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a;
}

module.exports = { NAME, detect, buildCmd, buildExcludeFlags };
