#!/usr/bin/env node

// Git merge driver for BMad state YAML files.
//
// Git invokes a custom merge driver as:
//   node auto-merge-bmad-docs.js %A %O %B %P
//
//   %A — current side ("ours"); also the path the resolved content must
//        be written to. NOTE: in real merges, %A is a temporary filename
//        (e.g. ".merge_file_XYZ"), NOT the working-tree path.
//   %O — merge base (common ancestor).
//   %B — other side ("theirs").
//   %P — pathname of the file being merged in the worktree. The script
//        dispatches the per-file merger off %P, not %A, because %A is the
//        opaque temp file. When %P is absent (older git or manual
//        invocation) we fall back to %A's basename.
//
// Exit status:
//   0 — resolved cleanly; %A now contains the merged content.
//   1 — could not safely merge; %A left untouched (caller falls back to
//       leaving conflict markers via git's default 3-way merge).
//
// Registered in `.git/config` by the Sprintpilot installer:
//   [merge "bmad-doc"]
//     name = Sprintpilot auto-merge for BMad state files
//     driver = node _Sprintpilot/scripts/auto-merge-bmad-docs.js %A %O %B %P
//
// And in `.gitattributes` per file:
//   _bmad-output/implementation-artifacts/sprint-status.yaml merge=bmad-doc
//   _bmad-output/implementation-artifacts/git-status.yaml    merge=bmad-doc
//   _bmad-output/implementation-artifacts/decision-log.yaml  merge=bmad-doc
//   _bmad-output/implementation-artifacts/autopilot-state.yaml merge=bmad-doc

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { mergerForFilename } = require('../lib/runtime/yaml-merge');
const log = require('../lib/runtime/log');

function readFileSafe(p) {
  if (!p) return null;
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}

function atomicWrite(targetPath, content) {
  const dir = path.dirname(targetPath);
  if (dir && dir !== '.' && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const suffix = crypto.randomBytes(4).toString('hex');
  const tmp = `${targetPath}.${process.pid}.${Date.now()}.${suffix}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, targetPath);
  } catch (e) {
    if (e.code === 'EXDEV') {
      try {
        fs.writeFileSync(targetPath, content, 'utf8');
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* best effort */
        }
      }
      return;
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw e;
  }
}

function main() {
  const [aPath, oPath, bPath, pPath] = process.argv.slice(2);
  if (!aPath || !bPath) {
    log.error('Usage: auto-merge-bmad-docs.js <%A> <%O> <%B> [%P]  (git merge driver contract)');
    process.exit(1);
  }

  // %P is the pathname of the file being merged in the worktree. %A is
  // a temporary file git uses for the resolved bytes — its basename
  // doesn't tell us which BMad file kind we're merging. Prefer %P; fall
  // back to %A so a caller invoking the script directly with a real
  // path (e.g. `sprintpilot resolve-docs` shells, tests) still works.
  const lookupPath = pPath || aPath;
  const merger = mergerForFilename(lookupPath);
  if (!merger) {
    // Distinguish two cases: (a) the file genuinely isn't one we manage,
    // (b) git didn't pass %P and %A is a temp file we can't classify.
    // The second case usually means an older git that doesn't substitute
    // %P; surface a hint so the user can upgrade rather than guess.
    const isTempFile = /^\.merge_file_/i.test(path.basename(aPath));
    if (isTempFile && !pPath) {
      log.error(
        `auto-merge-bmad-docs: cannot identify file kind. %A is a git temp file (${path.basename(aPath)}) and %P was not passed. ` +
          'Likely a git version that does not substitute %P (added in git 2.5). ' +
          'Re-register the driver with %A %O %B %P or upgrade git.',
      );
    } else {
      log.error(`auto-merge-bmad-docs: no merger registered for ${path.basename(lookupPath)}`);
    }
    process.exit(1);
  }

  let a;
  let o;
  let b;
  try {
    a = readFileSafe(aPath) || '';
    o = readFileSafe(oPath); // may be null when no common ancestor
    b = readFileSafe(bPath) || '';
  } catch (e) {
    log.error(`auto-merge-bmad-docs: read failed: ${e.message}`);
    process.exit(1);
  }

  let merged;
  try {
    merged = merger(a, o, b);
  } catch (e) {
    log.error(`auto-merge-bmad-docs: merge raised ${e.message}`);
    process.exit(1);
  }

  if (merged === null || merged === undefined) {
    log.error(`auto-merge-bmad-docs: refusing to merge ${path.basename(aPath)} — unfamiliar shape`);
    process.exit(1);
  }

  atomicWrite(aPath, merged);
  process.exit(0);
}

main();
