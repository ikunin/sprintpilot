// Shared reader for BMad's `output_folder` config, used by every Sprintpilot
// runtime writer (merge-shards.js, state-shard.js, mark-done-stories-tasks.js)
// so they never desync on a project that customized its output directory.
//
// BMad v6.2.x writes `_bmad/bmm/config.yaml` with `output_folder: <dir>`.
// BMad v6.4+ migrates config to a four-layer TOML layout (`_bmad/config.toml`,
// `_bmad/config.user.toml`, plus `custom/` overlays) where the same key is
// `output_folder = "<dir>"`. We prefer the YAML form when present — byte-
// identical to older installs — and fall back to TOML only when no YAML config
// yields a value, so nothing changes for existing v6.2.x projects.
const fs = require('node:fs');
const path = require('node:path');

// Strip a leading `{project-root}/` placeholder from a configured path value,
// mirroring the installer-side reader in lib/core/bmad-config.js.
function stripProjectRootPrefix(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/^\{project-root\}\/?/, '');
}

// Return the first capture group of `re` in `file`, quote-stripped and
// project-root-stripped, or null (missing file / no match / unreadable).
function readKeyFromFile(file, re) {
  if (!fs.existsSync(file)) return null;
  try {
    const body = fs.readFileSync(file, 'utf8');
    const m = body.match(re);
    if (!m) return null;
    const val = m[1].replace(/^["']|["']$/g, '').trim();
    return val ? stripProjectRootPrefix(val) : null;
  } catch {
    return null;
  }
}

// Resolve BMad's configured output folder, or null when unconfigured.
function readOutputFolder(projectRoot) {
  // 1. YAML — v6.2.x and any install that still ships config.yaml.
  const fromYaml = readKeyFromFile(
    path.join(projectRoot, '_bmad', 'bmm', 'config.yaml'),
    /^output_folder\s*:\s*(\S+)/m,
  );
  if (fromYaml) return fromYaml;

  // 2. TOML fallback — v6.4+. User overrides win over the base file. The scan
  //    is section-agnostic: we only need the scalar, wherever it is declared.
  for (const rel of [
    ['_bmad', 'config.user.toml'],
    ['_bmad', 'config.toml'],
  ]) {
    const fromToml = readKeyFromFile(
      path.join(projectRoot, ...rel),
      /^\s*output_folder\s*=\s*(.+?)\s*(?:#.*)?$/m,
    );
    if (fromToml) return fromToml;
  }

  return null;
}

function implArtifactsDir(projectRoot) {
  const folder = readOutputFolder(projectRoot) || '_bmad-output';
  return path.join(projectRoot, folder, 'implementation-artifacts');
}

module.exports = { readOutputFolder, implArtifactsDir, stripProjectRootPrefix };
