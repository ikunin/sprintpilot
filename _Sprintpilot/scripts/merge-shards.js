#!/usr/bin/env node

// merge-shards.js — coordinator merge of per-story shards into the
// authoritative project-level state + decision-log YAMLs.
//
// Usage:
//   merge-shards.js [--project-root <path>] [--layer <id>] [--archive]
//                   [--dry-run]
//
// Reads every shard in:
//   _bmad-output/implementation-artifacts/.autopilot-state/<story>.yaml
//   _bmad-output/implementation-artifacts/.decision-log/<story>.yaml
//
// Writes merged files:
//   _bmad-output/implementation-artifacts/autopilot-state.yaml
//   _bmad-output/implementation-artifacts/decision-log.yaml
//
// Merge rules:
//   - State: keyed by story. Last writer wins per key using
//     updated_at.monotonic (intra-process, NTP-safe) and falling back to
//     updated_at.wall for cross-process tiebreaks.
//   - Decision log: concatenate entries, sort by ts ascending, dedupe by id.
//
// Corruption recovery:
//   A shard that fails to parse OR lacks updated_at is moved to
//   .archive/corrupt/<story>-<ts>.yaml and a marker is appended to
//   the merged state + decision log. Never deleted.
//
// Idempotent: merging twice produces the same result.

const fs = require('node:fs');
const path = require('node:path');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');
const shardMod = require('./state-shard.js');

const { yamlDump, yamlLoad, KIND_DIR, listShardStories, stripReservedKeys } = shardMod;

function help() {
  log.out(
    [
      'Usage:',
      '  merge-shards.js [--project-root <path>] [--layer <id>] [--archive]',
      '                  [--dry-run]',
      '',
      '  --layer <id>    Archive subdirectory name when --archive is set.',
      '  --archive       Move merged shards to .archive/layer-<id>/ after merge.',
      '  --dry-run       Compute the merge but do not write files.',
    ].join('\n'),
  );
}

// Read BMad's `output_folder` from _bmad/bmm/config.yaml if present, so
// projects that have configured a non-default output dir don't desync
// from sibling scripts (mark-done-stories-tasks.js etc.).
function readOutputFolder(projectRoot) {
  const cfg = path.join(projectRoot, '_bmad', 'bmm', 'config.yaml');
  if (!fs.existsSync(cfg)) return null;
  try {
    const body = fs.readFileSync(cfg, 'utf8');
    const m = body.match(/^output_folder\s*:\s*(\S+)/m);
    if (!m) return null;
    return m[1].replace(/^["']|["']$/g, '').trim();
  } catch {
    return null;
  }
}

function implArtifactsDir(projectRoot) {
  const folder = readOutputFolder(projectRoot) || '_bmad-output';
  return path.join(projectRoot, folder, 'implementation-artifacts');
}

// ──────────────────────────────────────────────────────────────────
// Cross-process merge lock
// ──────────────────────────────────────────────────────────────────
//
// Two concurrent merge invocations would each compute the merge in
// memory then both rename their tmp file over autopilot-state.yaml.
// Tmp filenames are unique so renames don't collide on the source,
// but the LAST rename wins on the destination — the earlier merge
// (potentially with newer shard data) would be clobbered. Combined
// with archive races below, the loser's archived shards would also
// vanish — a silent state rewind.
//
// A sibling lock file serializes merges. If another invocation holds
// the lock, callers wait briefly + retry, or fail with a clear message
// naming the holder's pid and start time so the operator can diagnose.

const MERGE_LOCK_FILE = '.merge-shards.lock';
const STALE_LOCK_AGE_MS = 5 * 60 * 1000; // 5 minutes — merges are fast

function lockPath(projectRoot) {
  return path.join(implArtifactsDir(projectRoot), MERGE_LOCK_FILE);
}

function acquireMergeLock(projectRoot) {
  const file = lockPath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      const payload = JSON.stringify({
        pid: process.pid,
        ts: new Date().toISOString(),
      });
      fs.writeSync(fd, payload);
      fs.closeSync(fd);
      return file;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Try stale-recovery once.
      if (attempt === 0) {
        try {
          const st = fs.statSync(file);
          if (Date.now() - st.mtimeMs > STALE_LOCK_AGE_MS) {
            log.warn(
              `merge-shards: removing stale lock ${file} (older than ${STALE_LOCK_AGE_MS}ms)`,
            );
            fs.unlinkSync(file);
            continue;
          }
        } catch {
          /* lock vanished between EEXIST and stat — retry */
          continue;
        }
      }
      let holder = '';
      try {
        holder = fs.readFileSync(file, 'utf8');
      } catch {
        /* ignore */
      }
      throw new Error(
        `merge-shards: another invocation holds ${file} (${holder}); ` +
          'wait for it to finish or remove the lock manually if known stale',
      );
    }
  }
  throw new Error(`merge-shards: failed to acquire lock at ${file}`);
}

function releaseMergeLock(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* idempotent */
  }
}

function readShardFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return yamlLoad(raw);
}

function isValidShard(shard) {
  if (!shard || typeof shard !== 'object' || Array.isArray(shard)) return false;
  if (!shard.updated_at) return false;
  // updated_at may be an object {wall, monotonic} — require at least wall.
  if (typeof shard.updated_at !== 'object') return false;
  if (!shard.updated_at.wall) return false;
  return true;
}

function compareStamps(a, b) {
  // Prefer monotonic when both sides have one AND we believe they came
  // from the same process (same-string arithmetic). Monotonic numbers
  // across different processes are meaningless, so if one side is
  // missing we fall back to wall-clock.
  if (a && b && a.monotonic && b.monotonic) {
    try {
      const ai = BigInt(a.monotonic);
      const bi = BigInt(b.monotonic);
      if (ai > bi) return 1;
      if (ai < bi) return -1;
    } catch {
      // fall through to wall
    }
  }
  const aw = a?.wall ? Date.parse(a.wall) : 0;
  const bw = b?.wall ? Date.parse(b.wall) : 0;
  if (aw > bw) return 1;
  if (aw < bw) return -1;
  return 0;
}

// Snapshot file stat at read time so we can verify it's unchanged
// before archiving. Without the guard, a worker writing a fresh shard
// between merge-read and archive-rename would have its shard moved
// into .archive/ without being folded into the merged YAML —
// silent data loss under parallel dispatch.
function snapshotShard(file) {
  try {
    const st = fs.statSync(file);
    return { mtime: st.mtimeMs, size: st.size, ino: st.ino };
  } catch {
    return null;
  }
}

function shardUnchanged(file, snapshot) {
  if (!snapshot) return false;
  try {
    const st = fs.statSync(file);
    return st.mtimeMs === snapshot.mtime && st.size === snapshot.size && st.ino === snapshot.ino;
  } catch {
    return false;
  }
}

function mergeStateShards(projectRoot) {
  // Returns { byStory: { [storyKey]: shard }, snapshots: { [storyKey]: stat },
  //   corrupt: [...], invalid: [...] }
  const dir = path.join(implArtifactsDir(projectRoot), KIND_DIR.state);
  if (!fs.existsSync(dir)) return { byStory: {}, snapshots: {}, corrupt: [], invalid: [] };
  const stories = listShardStories(projectRoot, 'state');
  const byStory = {};
  const snapshots = {};
  const corrupt = [];
  const invalid = [];
  for (const story of stories) {
    const file = path.join(dir, `${story}.yaml`);
    // Snapshot BEFORE reading so a writer that touches the file during
    // read still produces a stat mismatch later.
    const snap = snapshotShard(file);
    let shard;
    try {
      shard = readShardFile(file);
    } catch (e) {
      corrupt.push({ story, file, error: e.message });
      continue;
    }
    if (!isValidShard(shard)) {
      invalid.push({ story, file, reason: 'missing updated_at or bad shape' });
      continue;
    }
    byStory[story] = shard;
    snapshots[story] = snap;
  }
  return { byStory, snapshots, corrupt, invalid };
}

// Parse a timestamp string defensively: malformed `ts` returns 0
// rather than NaN (which Array.sort treats unpredictably; NaN
// comparisons always return 0 and entries cluster in undefined order).
function tsToMs(ts) {
  if (!ts) return 0;
  const v = Date.parse(ts);
  return Number.isFinite(v) ? v : 0;
}

function mergeDecisionShards(projectRoot) {
  const dir = path.join(implArtifactsDir(projectRoot), KIND_DIR['decision-log']);
  if (!fs.existsSync(dir)) return { entries: [], snapshots: {}, corrupt: [], invalid: [] };
  const stories = listShardStories(projectRoot, 'decision-log').sort();
  const entries = [];
  const snapshots = {};
  const corrupt = [];
  const invalid = [];
  for (const story of stories) {
    const file = path.join(dir, `${story}.yaml`);
    const snap = snapshotShard(file);
    let shard;
    try {
      shard = readShardFile(file);
    } catch (e) {
      corrupt.push({ story, file, error: e.message });
      continue;
    }
    if (!isValidShard(shard)) {
      invalid.push({ story, file, reason: 'missing updated_at or bad shape' });
      continue;
    }
    const items = Array.isArray(shard.entries) ? shard.entries : [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      entries.push({ ...item, _story: story });
    }
    snapshots[story] = snap;
  }
  // Deterministic dedup: sort by (id asc, ts DESC) first, then keep
  // the first entry for each id — that's the latest-by-ts. The
  // explicit sort avoids depending on filesystem readdir order, which
  // is unspecified and varies by OS, so identical inputs always
  // produce identical outputs.
  entries.sort((a, b) => {
    const ai = a.id !== undefined && a.id !== null ? String(a.id) : '';
    const bi = b.id !== undefined && b.id !== null ? String(b.id) : '';
    if (ai !== bi) return ai < bi ? -1 : 1;
    // Within same id: latest ts wins (desc).
    const aw = tsToMs(a.ts);
    const bw = tsToMs(b.ts);
    return bw - aw;
  });
  const seen = new Set();
  const deduped = [];
  for (const e of entries) {
    if (e.id !== undefined && e.id !== null) {
      if (seen.has(String(e.id))) continue;
      seen.add(String(e.id));
    }
    deduped.push(e);
  }
  // Final sort for output: ts ascending, with deterministic tiebreaks.
  deduped.sort((a, b) => {
    const aw = tsToMs(a.ts);
    const bw = tsToMs(b.ts);
    if (aw !== bw) return aw - bw;
    const ai = a.id !== undefined ? String(a.id) : '';
    const bi = b.id !== undefined ? String(b.id) : '';
    if (ai !== bi) return ai < bi ? -1 : 1;
    return (a._story || '').localeCompare(b._story || '');
  });
  return {
    entries: deduped.map((e) => {
      const { _story, ...rest } = e;
      return rest;
    }),
    snapshots,
    corrupt,
    invalid,
  };
}

function archiveCorrupt(projectRoot, kind, story, file, reason) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(
    implArtifactsDir(projectRoot),
    '.archive',
    'corrupt',
    `${KIND_DIR[kind]}-${story}-${ts}.yaml`,
  );
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(file, dest);
  } catch {
    // If rename crosses FS (rare — same dir tree here), fall back to copy+unlink.
    fs.copyFileSync(file, dest);
    fs.unlinkSync(file);
  }
  return { archived: dest, reason };
}

function archiveShardsToLayer(projectRoot, layerId, snapshotsByKind) {
  // Default layerId includes pid + hrtime to avoid collision when two
  // archive operations land in the same millisecond on fast CI. Pre-
  // 2.0.8 the bare ISO timestamp could collide and the second archive
  // would race-clobber the first.
  const ts =
    layerId ||
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${process.hrtime.bigint().toString(36)}`;
  const base = path.join(implArtifactsDir(projectRoot), '.archive', `layer-${ts}`);
  fs.mkdirSync(base, { recursive: true });
  // Snapshot-verify each shard before moving — if a writer touched the
  // file after merge-read but before archive, the stat won't match and
  // we must NOT move it (otherwise the fresh shard's contents are lost
  // without ever being folded into the merged YAML). Skip + log so the
  // shard stays on disk for the next merge to pick up.
  const skipped = [];
  for (const kind of ['state', 'decision-log']) {
    const src = path.join(implArtifactsDir(projectRoot), KIND_DIR[kind]);
    if (!fs.existsSync(src)) continue;
    const destDir = path.join(base, KIND_DIR[kind]);
    fs.mkdirSync(destDir, { recursive: true });
    const snapshots = snapshotsByKind?.[kind] || {};
    for (const story of Object.keys(snapshots)) {
      const file = path.join(src, `${story}.yaml`);
      if (!fs.existsSync(file)) continue;
      if (!shardUnchanged(file, snapshots[story])) {
        log.warn(
          `merge-shards: shard ${file} changed during merge; not archiving (will be folded into next merge)`,
        );
        skipped.push({ kind, story, file, reason: 'changed during merge' });
        continue;
      }
      const dest = path.join(destDir, `${story}.yaml`);
      try {
        fs.renameSync(file, dest);
      } catch {
        fs.copyFileSync(file, dest);
        fs.unlinkSync(file);
      }
    }
  }
  return { dir: base, skipped };
}

function writeAuthoritative(projectRoot, filename, body, { dryRun } = {}) {
  const file = path.join(implArtifactsDir(projectRoot), filename);
  if (dryRun) return { file, wrote: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${process.hrtime.bigint().toString(36)}`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
  return { file, wrote: true };
}

function composeStateYaml(stateMerge) {
  // Flatten to one top-level `stories:` key carrying each story's shard
  // payload (minus the reserved keys story/schema_version/updated_at).
  // Also preserve updated_at per story so future merges pick the newer
  // entry if shards conflict.
  const stories = {};
  for (const key of Object.keys(stateMerge.byStory).sort()) {
    const shard = stateMerge.byStory[key];
    stories[key] = {
      updated_at: shard.updated_at,
      ...stripReservedKeys(shard),
    };
  }
  const doc = {
    schema_version: 1,
    merged_at: new Date().toISOString(),
    stories,
  };
  if (stateMerge.corrupt.length + stateMerge.invalid.length > 0) {
    doc.shard_problems = [
      ...stateMerge.corrupt.map((c) => ({ story: c.story, kind: 'parse-error', detail: c.error })),
      ...stateMerge.invalid.map((c) => ({
        story: c.story,
        kind: 'invalid-shape',
        detail: c.reason,
      })),
    ];
  }
  return `${yamlDump(doc)}\n`;
}

function composeDecisionYaml(decisionMerge) {
  const doc = {
    schema_version: 1,
    merged_at: new Date().toISOString(),
    entries: decisionMerge.entries,
  };
  if (decisionMerge.corrupt.length + decisionMerge.invalid.length > 0) {
    doc.shard_problems = [
      ...decisionMerge.corrupt.map((c) => ({
        story: c.story,
        kind: 'parse-error',
        detail: c.error,
      })),
      ...decisionMerge.invalid.map((c) => ({
        story: c.story,
        kind: 'invalid-shape',
        detail: c.reason,
      })),
    ];
  }
  return `${yamlDump(doc)}\n`;
}

function merge(projectRoot, { layerId, archive, dryRun } = {}) {
  // Acquire cross-process lock. Even dry-run takes the lock so a real
  // merge in progress doesn't have its shard reads disturbed by a
  // concurrent dry-run that might (e.g.) tail the same files.
  const lockFile = acquireMergeLock(projectRoot);
  try {
    const state = mergeStateShards(projectRoot);
    const decisions = mergeDecisionShards(projectRoot);

    // Archive corrupt shards before writing merged files so subsequent
    // merges don't re-surface the same errors.
    const archivedCorrupt = [];
    if (!dryRun) {
      for (const c of state.corrupt.concat(state.invalid)) {
        const arch = archiveCorrupt(projectRoot, 'state', c.story, c.file, c.error || c.reason);
        archivedCorrupt.push({ kind: 'state', story: c.story, ...arch });
      }
      for (const c of decisions.corrupt.concat(decisions.invalid)) {
        const arch = archiveCorrupt(
          projectRoot,
          'decision-log',
          c.story,
          c.file,
          c.error || c.reason,
        );
        archivedCorrupt.push({ kind: 'decision-log', story: c.story, ...arch });
      }
    }

    const stateBody = composeStateYaml(state);
    const decisionBody = composeDecisionYaml(decisions);

    const stateWrite = writeAuthoritative(projectRoot, 'autopilot-state.yaml', stateBody, {
      dryRun,
    });
    const decisionWrite = writeAuthoritative(projectRoot, 'decision-log.yaml', decisionBody, {
      dryRun,
    });

    let archiveDir = null;
    let archiveSkipped = [];
    if (archive && !dryRun) {
      const archResult = archiveShardsToLayer(projectRoot, layerId, {
        state: state.snapshots,
        'decision-log': decisions.snapshots,
      });
      archiveDir = archResult.dir;
      archiveSkipped = archResult.skipped;
    }

    return {
      state: {
        stories: Object.keys(state.byStory).length,
        problems: state.corrupt.length + state.invalid.length,
      },
      decisions: {
        entries: decisions.entries.length,
        problems: decisions.corrupt.length + decisions.invalid.length,
      },
      files: { state: stateWrite.file, decisions: decisionWrite.file },
      archived_corrupt: archivedCorrupt,
      archive_dir: archiveDir,
      archive_skipped: archiveSkipped,
      dry_run: !!dryRun,
    };
  } finally {
    releaseMergeLock(lockFile);
  }
}

function main() {
  const { opts } = parseArgs(process.argv.slice(2), { booleanFlags: ['archive', 'dry-run'] });
  if (opts.help) {
    help();
    process.exit(0);
  }
  const projectRoot = opts['project-root'] || process.cwd();
  const layerId = opts.layer || null;
  const archive = opts.archive === true;
  const dryRun = opts['dry-run'] === true;

  try {
    const result = merge(projectRoot, { layerId, archive, dryRun });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (e) {
    log.error(`merge failed: ${e.message}`);
    process.exit(1);
  }
}

module.exports = {
  mergeStateShards,
  mergeDecisionShards,
  compareStamps,
  isValidShard,
  merge,
  composeStateYaml,
  composeDecisionYaml,
  archiveShardsToLayer,
  archiveCorrupt,
};

if (require.main === module) {
  main();
}
