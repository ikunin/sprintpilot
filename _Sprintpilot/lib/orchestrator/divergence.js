// divergence.js — resume fingerprint diff.
//
// When the autopilot resumes (next session, after a halt, after the user
// did stuff manually), we don't trust that the world still matches what
// the ledger says. We fingerprint the relevant on-disk state, compare to
// the fingerprint recorded at last halt, and report divergences.
//
// Returns a Divergence object the CLI edge can either:
//   - accept (`{ identical: true }` → emit next planned action)
//   - escalate to user_prompt (`{ identical: false, differences: ... }`)
//
// Fingerprint inputs (per the plan):
//   - sprint-status.yaml: SHA-256 of canonical content (trailing-WS stripped)
//   - per-story branch HEADs: SHA list from `git rev-parse refs/heads/...`
//     (skipped if git not available / no git_enabled in profile)
//   - _bmad-output tree: { relative-path → size }
//   - active worktree paths: list of `.worktrees/<name>` dirs
//
// All inputs are computed via injected dependencies so tests can drive
// without a real repo.

'use strict';

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const path = require('node:path');

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function exists(fs, p) {
  try {
    fs.accessSync(p, fs.constants ? fs.constants.F_OK : 0);
    return true;
  } catch (_e) {
    return false;
  }
}

function readSafe(fs, p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (_e) {
    return null;
  }
}

// canonicalizeYaml — strip trailing whitespace per line; ensure final newline.
// We don't try to canonicalize key ordering because users may legitimately
// reorder fields; we just want to ignore whitespace-only churn.
function canonicalizeYaml(text) {
  if (!text) return '';
  const lines = text.split(/\r?\n/).map((l) => l.replace(/[ \t]+$/g, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

// Directory names always pruned from fingerprint walks. These are
// regenerable build/cache artifacts that change between sessions for
// reasons unrelated to BMad state (Python bytecode, dependency
// installs, transpiler output, OS metadata). Without pruning, a single
// halt fingerprint can balloon to 100s of MB and a `.pyc` regen on
// resume produces spurious divergence prompts.
//
// Real-world trigger: a user's `_bmad-output/spikes/<name>/.venv/` was
// 794 MB; every halt entry captured every path inside it.
const FINGERPRINT_PRUNE_DIRS = new Set([
  '.venv',
  'venv',
  'env',
  'node_modules',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.gradle',
  'target',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '.git',
  '.svn',
  '.hg',
  '.idea',
  '.vscode',
  // BMad/Sprintpilot internal — worktrees aren't fingerprinted; they're
  // captured separately via context.worktreeScanner.
  '.worktrees',
]);

// File suffixes always pruned. Generated / binary content that changes
// for non-state reasons.
const FINGERPRINT_PRUNE_SUFFIXES = [
  '.pyc',
  '.pyo',
  '.pyd',
  '.so',
  '.o',
  '.class',
  '.DS_Store',
];

// Hard cap on number of entries in the fingerprint tree. Defends against
// pathological cases where prune lists don't catch a large embedded
// dependency tree. When hit, the walk stops and `out[__truncated__]`
// is set so callers know the fingerprint is incomplete (treated as
// divergent on diff to avoid false-negative resume).
const FINGERPRINT_MAX_ENTRIES = 5000;

function walkTree(fs, root, out, relBase) {
  if (out.__truncated__) return;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_e) {
    return;
  }
  for (const ent of entries) {
    if (out.__truncated__) return;
    if (FINGERPRINT_PRUNE_DIRS.has(ent.name)) continue;
    const full = path.join(root, ent.name);
    const rel = path.join(relBase, ent.name);
    if (ent.isDirectory()) {
      walkTree(fs, full, out, rel);
    } else if (ent.isFile()) {
      let prune = false;
      for (const sfx of FINGERPRINT_PRUNE_SUFFIXES) {
        if (ent.name.endsWith(sfx)) {
          prune = true;
          break;
        }
      }
      if (prune) continue;
      try {
        const st = fs.statSync(full);
        out[rel.split(path.sep).join('/')] = st.size;
        // -1 for the future __truncated__ marker; -2 below for the actual count
        // (avoid counting the marker itself).
        const count = Object.keys(out).length - (out.__truncated__ ? 1 : 0);
        if (count >= FINGERPRINT_MAX_ENTRIES) {
          out.__truncated__ = true;
          return;
        }
      } catch (_e) {
        // ignore unreadable
      }
    }
  }
}

// fingerprint(context) → { sprintStatusSha, bmadTree, branchHeads, worktreePaths }
//
// context = { projectRoot, fs?, gitHeadResolver?, worktreeScanner? }
//   gitHeadResolver(branch): string | null  — return SHA or null
//   worktreeScanner(): string[]             — return list of worktree paths
//
// Both git-side functions are injected so tests don't need a real repo.
function fingerprint(context) {
  if (!context || !context.projectRoot) throw new Error('fingerprint: projectRoot required');
  const fs = context.fs || nodeFs;
  const root = context.projectRoot;

  const sprintStatusPath = path.join(
    root,
    '_bmad-output',
    'implementation-artifacts',
    'sprint-status.yaml',
  );
  const sprintStatus = readSafe(fs, sprintStatusPath);
  const sprintStatusSha = sprintStatus ? sha256(canonicalizeYaml(sprintStatus)) : null;

  const bmadTree = {};
  const bmadRoot = path.join(root, '_bmad-output');
  if (exists(fs, bmadRoot)) {
    walkTree(fs, bmadRoot, bmadTree, '');
  }

  const branchHeads = {};
  if (typeof context.gitHeadResolver === 'function' && Array.isArray(context.branches)) {
    for (const b of context.branches) {
      branchHeads[b] = context.gitHeadResolver(b);
    }
  }

  const worktreePaths =
    typeof context.worktreeScanner === 'function' ? context.worktreeScanner() : [];

  return { sprintStatusSha, bmadTree, branchHeads, worktreePaths };
}

// diff(expected, actual) → Divergence
//
// Divergence shape:
//   {
//     identical: boolean,
//     differences: {
//       sprint_status?: { expected: sha, actual: sha },
//       branch_heads?: { branch, expected, actual }[],
//       bmad_tree?: { added: string[], removed: string[], changed: string[] },
//       worktrees?: { added: string[], removed: string[] },
//     }
//   }
function diff(expected, actual) {
  if (!expected) return { identical: false, differences: { reason: 'no_baseline_fingerprint' } };
  if (!actual) return { identical: false, differences: { reason: 'no_actual_fingerprint' } };

  const differences = {};

  if (expected.sprintStatusSha !== actual.sprintStatusSha) {
    differences.sprint_status = {
      expected: expected.sprintStatusSha,
      actual: actual.sprintStatusSha,
    };
  }

  const headDiffs = [];
  const branches = new Set([
    ...Object.keys(expected.branchHeads || {}),
    ...Object.keys(actual.branchHeads || {}),
  ]);
  for (const b of branches) {
    const e = expected.branchHeads ? expected.branchHeads[b] : undefined;
    const a = actual.branchHeads ? actual.branchHeads[b] : undefined;
    if (e !== a) headDiffs.push({ branch: b, expected: e ?? null, actual: a ?? null });
  }
  if (headDiffs.length > 0) differences.branch_heads = headDiffs;

  const expTree = expected.bmadTree || {};
  const actTree = actual.bmadTree || {};
  const added = [];
  const removed = [];
  const changed = [];
  for (const p of Object.keys(actTree)) {
    if (!(p in expTree)) added.push(p);
    else if (expTree[p] !== actTree[p]) changed.push(p);
  }
  for (const p of Object.keys(expTree)) {
    if (!(p in actTree)) removed.push(p);
  }
  if (added.length || removed.length || changed.length) {
    differences.bmad_tree = { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
  }

  const expWt = new Set(expected.worktreePaths || []);
  const actWt = new Set(actual.worktreePaths || []);
  const wtAdded = Array.from(actWt).filter((p) => !expWt.has(p)).sort();
  const wtRemoved = Array.from(expWt).filter((p) => !actWt.has(p)).sort();
  if (wtAdded.length || wtRemoved.length) {
    differences.worktrees = { added: wtAdded, removed: wtRemoved };
  }

  return { identical: Object.keys(differences).length === 0, differences };
}

// detect(context) — convenience: read the last baseline fingerprint from the
// ledger, compute current fingerprint, diff. The baseline is recorded as a
// `state_transition` entry with `fingerprint` field when the orchestrator
// halts. (The CLI edge wires this up; this module just composes.)
function detect(context, baselineFingerprint) {
  const actual = fingerprint(context);
  return diff(baselineFingerprint, actual);
}

module.exports = {
  sha256,
  canonicalizeYaml,
  fingerprint,
  diff,
  detect,
};
