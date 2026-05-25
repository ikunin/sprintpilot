// change-size-classifier.js — classify the size + risk of the
// current change so CODE_REVIEW can route to a proportional review
// depth — v2.4.1.
//
// Returns: {
//   size: 'trivial' | 'normal' | 'structural',
//   loc_added: int,
//   loc_removed: int,
//   files_touched: int,
//   structural_signals: string[],
//   reason: string,
// }
//
// I/O note: shells out to git via execFileSync (no shell, no
// injection surface — matches the rest of the orchestrator's git
// helpers in scripts/check-prereqs.js / land.js). The runner is
// injectable for tests so unit cases simulate git output without
// spawning processes.

'use strict';

const { execFileSync } = require('node:child_process');

const TRIVIAL_FILES_MAX = 2;
const TRIVIAL_LOC_MAX = 10;
const STRUCTURAL_LOC_MIN = 500;
const STRUCTURAL_FILES_MIN = 20;

const DEP_MANIFEST_PATHS = new Set([
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'pyproject.toml',
  'requirements.txt',
  'Pipfile',
  'Pipfile.lock',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
  'Gemfile',
  'Gemfile.lock',
  'composer.json',
  'composer.lock',
]);

function isDepManifest(filePath) {
  if (!filePath) return false;
  const base = filePath.split('/').pop();
  return DEP_MANIFEST_PATHS.has(base);
}

function isSchemaOrMigration(filePath) {
  if (!filePath) return false;
  return /(^|\/)migrations?\//.test(filePath) ||
    /(^|\/)schema(\/|s\/)/.test(filePath) ||
    /\.sql$/.test(filePath) ||
    /(^|\/)prisma\/schema\.prisma$/.test(filePath);
}

function isBarrelIndex(filePath) {
  if (!filePath) return false;
  return /(^|\/)index\.(js|jsx|ts|tsx|mjs|cjs)$/.test(filePath);
}

function classifySize({
  filesTouched = 0,
  locAdded = 0,
  locRemoved = 0,
  structuralSignals = [],
  hasRename = false,
}) {
  const locDelta = locAdded + locRemoved;
  const signals = [...structuralSignals];
  if (hasRename) signals.push('rename_detected');
  if (locDelta > STRUCTURAL_LOC_MIN) signals.push(`loc_delta_${locDelta}>${STRUCTURAL_LOC_MIN}`);
  if (filesTouched > STRUCTURAL_FILES_MIN) signals.push(`files_${filesTouched}>${STRUCTURAL_FILES_MIN}`);

  if (signals.length > 0) {
    return {
      size: 'structural',
      reason: signals.join(', '),
      structural_signals: signals,
    };
  }
  if (filesTouched <= TRIVIAL_FILES_MAX && locDelta <= TRIVIAL_LOC_MAX) {
    return {
      size: 'trivial',
      reason: `${filesTouched} file(s), ${locDelta} LOC`,
      structural_signals: [],
    };
  }
  return {
    size: 'normal',
    reason: `${filesTouched} file(s), ${locDelta} LOC`,
    structural_signals: [],
  };
}

// parseNumstat(text) → { filesTouched, locAdded, locRemoved, files }
// git diff --numstat: `<added>\t<removed>\t<path>` per line. Binary /
// rename rows render `-` instead of a number; they contribute to
// files_touched but not LOC.
function parseNumstat(text) {
  if (!text) return { filesTouched: 0, locAdded: 0, locRemoved: 0, files: [] };
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  let locAdded = 0;
  let locRemoved = 0;
  const files = [];
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const a = parts[0] === '-' ? 0 : Number.parseInt(parts[0], 10);
    const r = parts[1] === '-' ? 0 : Number.parseInt(parts[1], 10);
    const p = parts.slice(2).join('\t');
    if (Number.isFinite(a)) locAdded += a;
    if (Number.isFinite(r)) locRemoved += r;
    files.push({ path: p, added: a || 0, removed: r || 0 });
  }
  return { filesTouched: files.length, locAdded, locRemoved, files };
}

// parseNameStatus(text) → { renames, paths }
// git diff --name-status: `<code>\t<path>` (or `R<n>\t<old>\t<new>`).
function parseNameStatus(text) {
  if (!text) return { renames: [], paths: [] };
  const renames = [];
  const paths = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split('\t');
    const code = parts[0] || '';
    if (code.startsWith('R')) {
      if (parts[1]) renames.push(parts[1]);
      if (parts[2]) {
        paths.push(parts[2]);
        renames.push(parts[2]);
      }
    } else if (parts.length >= 2) {
      paths.push(parts[1]);
    }
  }
  return { renames, paths };
}

// depManifestVersionEdit(diffText) — true when the manifest's diff
// includes a quoted version-pinning line (e.g. `+    "foo": "^1.2.3"`).
// Avoids tripping structural on whitespace / formatting churn.
function depManifestVersionEdit(diffText) {
  if (!diffText) return false;
  return /\n\+\s*"[^"]+"\s*:\s*"[\^~>=<\d]/.test(diffText);
}

function collectStructuralSignals(files, manifestDiffs) {
  const signals = [];
  const seen = new Set();
  for (const f of files) {
    if (isSchemaOrMigration(f.path) && !seen.has(`schema:${f.path}`)) {
      signals.push(`schema_or_migration:${f.path}`);
      seen.add(`schema:${f.path}`);
    }
    if (isBarrelIndex(f.path) && !seen.has(`barrel:${f.path}`)) {
      signals.push(`barrel_index_changed:${f.path}`);
      seen.add(`barrel:${f.path}`);
    }
    if (isDepManifest(f.path) && manifestDiffs[f.path] && depManifestVersionEdit(manifestDiffs[f.path])) {
      signals.push(`dep_version_edit:${f.path}`);
    }
  }
  return signals;
}

// runGit(args, projectRoot, runImpl?) — single git invocation. Uses
// execFileSync (no shell) so args are safe-by-construction. Returns
// trimmed stdout on success, '' on error (caller treats absent data
// as "no diff", which the classifier surfaces as size='trivial' with
// reason='no_diff' — the safe assumption for an empty/unknown state).
function runGit(args, projectRoot, runImpl) {
  const exec = runImpl || ((bin, argv, opts) => execFileSync(bin, argv, opts));
  try {
    const out = exec('git', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      maxBuffer: 50 * 1024 * 1024,
    });
    return typeof out === 'string' ? out : '';
  } catch (_e) {
    return '';
  }
}

function classifyChange({ projectRoot, baseBranch, run }) {
  if (!projectRoot) {
    return defaultEmpty('no_project_root');
  }
  const base = baseBranch || 'main';
  const baseRef = `origin/${base}`;
  // Includes both committed (since branch) and working-tree changes —
  // CODE_REVIEW runs pre-merge and pre-STORY_DONE, so working-tree
  // delta needs to count.
  const numstat = runGit(['diff', '--numstat', baseRef], projectRoot, run);
  const nameStatus = runGit(['diff', '--name-status', '-M', baseRef], projectRoot, run);
  const stats = parseNumstat(numstat);
  const ns = parseNameStatus(nameStatus);

  if (stats.filesTouched === 0) {
    return defaultEmpty('no_diff');
  }

  // Bounded to 5 manifest diffs to keep classifier runtime stable
  // even on monorepo-wide bumps. Beyond 5 manifests we still detect
  // structural via files_touched / loc thresholds.
  const manifestDiffs = {};
  const manifestFiles = stats.files.filter((f) => isDepManifest(f.path)).slice(0, 5);
  for (const m of manifestFiles) {
    manifestDiffs[m.path] = runGit(['diff', baseRef, '--', m.path], projectRoot, run);
  }

  const structuralSignals = collectStructuralSignals(stats.files, manifestDiffs);
  const verdict = classifySize({
    filesTouched: stats.filesTouched,
    locAdded: stats.locAdded,
    locRemoved: stats.locRemoved,
    structuralSignals,
    hasRename: ns.renames.length > 0,
  });

  return {
    size: verdict.size,
    loc_added: stats.locAdded,
    loc_removed: stats.locRemoved,
    files_touched: stats.filesTouched,
    structural_signals: verdict.structural_signals,
    reason: verdict.reason,
    base_branch: base,
  };
}

function defaultEmpty(reason) {
  return {
    size: 'trivial',
    loc_added: 0,
    loc_removed: 0,
    files_touched: 0,
    structural_signals: [],
    reason,
    base_branch: null,
  };
}

// reviewLayersForSize(size) — map size → recommended review layers.
// Used by the state machine to populate the bmad-code-review slot.
function reviewLayersForSize(size) {
  switch (size) {
    case 'trivial':
      return {
        review_depth: 'trivial',
        recommended_reviewer_count: 1,
        recommended_layers: ['blind_hunter'],
        notes: 'Single reviewer — small change. Skip Edge Case Hunter unless the diff touches branching logic.',
      };
    case 'structural':
      return {
        review_depth: 'structural',
        recommended_reviewer_count: 3,
        recommended_layers: ['blind_hunter', 'edge_case_hunter', 'acceptance_auditor'],
        notes: 'Full review + extended Edge Case Hunter (broader branching/boundary scan) due to structural signals.',
        extended_edge_case_hunter: true,
      };
    case 'normal':
    default:
      return {
        review_depth: 'normal',
        recommended_reviewer_count: 3,
        recommended_layers: ['blind_hunter', 'edge_case_hunter', 'acceptance_auditor'],
        notes: 'Standard 3-layer review.',
      };
  }
}

module.exports = {
  classifyChange,
  classifySize,
  reviewLayersForSize,
  parseNumstat,
  parseNameStatus,
  collectStructuralSignals,
  isDepManifest,
  isSchemaOrMigration,
  isBarrelIndex,
  depManifestVersionEdit,
  TRIVIAL_FILES_MAX,
  TRIVIAL_LOC_MAX,
  STRUCTURAL_LOC_MIN,
  STRUCTURAL_FILES_MIN,
};
