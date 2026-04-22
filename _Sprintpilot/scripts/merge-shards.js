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

function implArtifactsDir(projectRoot) {
  return path.join(projectRoot, '_bmad-output', 'implementation-artifacts');
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
  const aw = a && a.wall ? Date.parse(a.wall) : 0;
  const bw = b && b.wall ? Date.parse(b.wall) : 0;
  if (aw > bw) return 1;
  if (aw < bw) return -1;
  return 0;
}

function mergeStateShards(projectRoot) {
  // Returns { byStory: { [storyKey]: shard }, corrupt: [...], invalid: [...] }
  const dir = path.join(implArtifactsDir(projectRoot), KIND_DIR.state);
  if (!fs.existsSync(dir)) return { byStory: {}, corrupt: [], invalid: [] };
  const stories = listShardStories(projectRoot, 'state');
  const byStory = {};
  const corrupt = [];
  const invalid = [];
  for (const story of stories) {
    const file = path.join(dir, `${story}.yaml`);
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
  }
  return { byStory, corrupt, invalid };
}

function mergeDecisionShards(projectRoot) {
  const dir = path.join(implArtifactsDir(projectRoot), KIND_DIR['decision-log']);
  if (!fs.existsSync(dir)) return { entries: [], corrupt: [], invalid: [] };
  const stories = listShardStories(projectRoot, 'decision-log');
  const entries = [];
  const corrupt = [];
  const invalid = [];
  for (const story of stories) {
    const file = path.join(dir, `${story}.yaml`);
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
  }
  // Dedupe by id (if present), otherwise keep all. Sort by ts ascending.
  const seen = new Set();
  const deduped = [];
  for (const e of entries) {
    if (e.id !== undefined && e.id !== null && seen.has(String(e.id))) continue;
    if (e.id !== undefined && e.id !== null) seen.add(String(e.id));
    deduped.push(e);
  }
  deduped.sort((a, b) => {
    const aw = a.ts ? Date.parse(a.ts) : 0;
    const bw = b.ts ? Date.parse(b.ts) : 0;
    if (aw !== bw) return aw - bw;
    // Tiebreak alphabetically by id then story for determinism.
    const ai = a.id !== undefined ? String(a.id) : '';
    const bi = b.id !== undefined ? String(b.id) : '';
    if (ai !== bi) return ai < bi ? -1 : 1;
    return (a._story || '').localeCompare(b._story || '');
  });
  return { entries: deduped.map((e) => {
    const { _story, ...rest } = e;
    return rest;
  }), corrupt, invalid };
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

function archiveShardsToLayer(projectRoot, layerId, storyKeys) {
  const ts = layerId || new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(implArtifactsDir(projectRoot), '.archive', `layer-${ts}`);
  fs.mkdirSync(base, { recursive: true });
  for (const kind of ['state', 'decision-log']) {
    const src = path.join(implArtifactsDir(projectRoot), KIND_DIR[kind]);
    if (!fs.existsSync(src)) continue;
    const destDir = path.join(base, KIND_DIR[kind]);
    fs.mkdirSync(destDir, { recursive: true });
    for (const story of storyKeys) {
      const file = path.join(src, `${story}.yaml`);
      if (!fs.existsSync(file)) continue;
      const dest = path.join(destDir, `${story}.yaml`);
      try {
        fs.renameSync(file, dest);
      } catch {
        fs.copyFileSync(file, dest);
        fs.unlinkSync(file);
      }
    }
  }
  return base;
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
      ...stateMerge.invalid.map((c) => ({ story: c.story, kind: 'invalid-shape', detail: c.reason })),
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
      ...decisionMerge.corrupt.map((c) => ({ story: c.story, kind: 'parse-error', detail: c.error })),
      ...decisionMerge.invalid.map((c) => ({ story: c.story, kind: 'invalid-shape', detail: c.reason })),
    ];
  }
  return `${yamlDump(doc)}\n`;
}

function merge(projectRoot, { layerId, archive, dryRun } = {}) {
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
      const arch = archiveCorrupt(projectRoot, 'decision-log', c.story, c.file, c.error || c.reason);
      archivedCorrupt.push({ kind: 'decision-log', story: c.story, ...arch });
    }
  }

  const stateBody = composeStateYaml(state);
  const decisionBody = composeDecisionYaml(decisions);

  const stateWrite = writeAuthoritative(projectRoot, 'autopilot-state.yaml', stateBody, { dryRun });
  const decisionWrite = writeAuthoritative(projectRoot, 'decision-log.yaml', decisionBody, { dryRun });

  let archiveDir = null;
  if (archive && !dryRun) {
    const storyKeys = Object.keys(state.byStory);
    archiveDir = archiveShardsToLayer(projectRoot, layerId, storyKeys);
  }

  return {
    state: { stories: Object.keys(state.byStory).length, problems: state.corrupt.length + state.invalid.length },
    decisions: { entries: decisions.entries.length, problems: decisions.corrupt.length + decisions.invalid.length },
    files: { state: stateWrite.file, decisions: decisionWrite.file },
    archived_corrupt: archivedCorrupt,
    archive_dir: archiveDir,
    dry_run: !!dryRun,
  };
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
