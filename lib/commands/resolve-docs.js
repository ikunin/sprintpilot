// `sprintpilot resolve-docs` — resolves conflict markers in BMad state files
// using the same domain logic as the merge driver. Useful when the driver
// wasn't registered (older install, fresh `git init`) but the user has
// already-conflicted files in their working tree.
//
// Reads each file, splits the conflict markers into A/B halves, runs the
// per-file merger, writes back. Files without conflict markers are skipped.

const path = require('node:path');
const fs = require('fs-extra');
const pc = require('picocolors');

const { mergerForFilename } = require('../../_Sprintpilot/lib/runtime/yaml-merge');
const { STATE_FILES } = require('./install-merge-driver');

const CONFLICT_BEGIN = /^<{7}\s/m;

function splitConflict(text) {
  // Returns { a, b } extracting the two halves from a conflict-marked file.
  // We support a single conflict region for simplicity; complex multi-region
  // conflicts are rare in append-only state files.
  //
  //   <<<<<<< HEAD
  //   ours...
  //   =======
  //   theirs...
  //   >>>>>>> branch
  const re = /^<{7}[^\n]*\n([\s\S]*?)^={7}[ \t]*\n([\s\S]*?)^>{7}[^\n]*\n?/m;
  const m = text.match(re);
  if (!m) return null;
  // Build A and B by splicing each half into the surrounding non-conflict
  // context — preserves leading comments / sections that aren't in conflict.
  const before = text.slice(0, m.index);
  const after = text.slice(m.index + m[0].length);
  return {
    a: `${before}${m[1]}${after}`,
    b: `${before}${m[2]}${after}`,
  };
}

async function runResolveDocs(options = {}) {
  const projectRoot = process.env.BMAD_PROJECT_ROOT || process.cwd();
  const explicit = options.paths && options.paths.length > 0 ? options.paths : null;
  const targets = explicit
    ? explicit.map((p) => path.resolve(projectRoot, p))
    : STATE_FILES.map((p) => path.join(projectRoot, p));

  let resolved = 0;
  let skipped = 0;
  let refused = 0;

  for (const file of targets) {
    if (!(await fs.pathExists(file))) {
      skipped++;
      continue;
    }
    const text = await fs.readFile(file, 'utf8');
    if (!CONFLICT_BEGIN.test(text)) {
      skipped++;
      continue;
    }
    const merger = mergerForFilename(file);
    if (!merger) {
      console.warn(
        pc.yellow(
          `  ${path.relative(projectRoot, file)}: no merger registered — leaving conflict markers`,
        ),
      );
      refused++;
      continue;
    }
    const split = splitConflict(text);
    if (!split) {
      console.warn(
        pc.yellow(
          `  ${path.relative(projectRoot, file)}: could not parse conflict markers — leaving as-is`,
        ),
      );
      refused++;
      continue;
    }
    let merged;
    try {
      merged = merger(split.a, null, split.b);
    } catch (err) {
      console.warn(
        pc.yellow(
          `  ${path.relative(projectRoot, file)}: merger threw (${err.message}) — leaving as-is`,
        ),
      );
      refused++;
      continue;
    }
    if (merged === null || merged === undefined) {
      console.warn(
        pc.yellow(
          `  ${path.relative(projectRoot, file)}: unfamiliar shape — leaving conflict markers`,
        ),
      );
      refused++;
      continue;
    }
    if (options.dryRun) {
      console.log(`  [DRY RUN] ${path.relative(projectRoot, file)}: would resolve`);
    } else {
      await fs.writeFile(file, merged, 'utf8');
      console.log(`  ${path.relative(projectRoot, file)}: resolved`);
    }
    resolved++;
  }

  console.log('');
  console.log(`Resolved: ${resolved}, refused: ${refused}, skipped: ${skipped}.`);
  if (refused > 0) {
    console.log(
      pc.yellow('Files left with conflict markers must be edited manually before `git add`.'),
    );
  }
}

module.exports = { runResolveDocs, splitConflict };
