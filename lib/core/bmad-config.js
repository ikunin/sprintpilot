const path = require('node:path');
const fs = require('fs-extra');
const yaml = require('js-yaml');
const semver = require('semver');

async function readYaml(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    // Missing/unreadable: return null silently — callers treat this as "no
    // config here", which is a legitimate state.
    return null;
  }
  try {
    return yaml.load(raw);
  } catch (e) {
    // Distinguish "file absent" from "file malformed" — a silent fallback in
    // the malformed case caused the installer to use the default
    // output_folder instead of the user's configured value.
    // eslint-disable-next-line no-console
    console.warn(`WARN: failed to parse YAML at ${filePath}: ${e.message}`);
    return null;
  }
}

function stripProjectRootPrefix(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/^\{project-root\}\/?/, '');
}

async function verifyBmadInstalled(projectRoot) {
  const manifest = path.join(projectRoot, '_bmad', '_config', 'manifest.yaml');
  if (!(await fs.pathExists(manifest))) return null;
  const data = await readYaml(manifest);
  return data || {};
}

// BMad Method has used three manifest shapes:
//   - installation-scoped: { installation: { version: "6.2.2" }, modules: [...] }
//     (the actual v6.2.x installer writes this — installation.version is
//     the canonical source; modules[].version is per-module and not the
//     overall BMad version)
//   - nested:              { bmad: { version: "6.2.0" } }
//   - flat:                { version: "6.3.0" }
// Try installation-scoped first (matches what users actually have on
// disk today), then nested, then flat. Older installs and our unit-test
// fixture use the flat form.
function extractBmadVersion(data) {
  if (!data) return null;
  if (data.installation?.version) return data.installation.version;
  if (data.bmad?.version) return data.bmad.version;
  if (data.version) return data.version;
  return null;
}

async function readBmadVersion(projectRoot) {
  const data = await verifyBmadInstalled(projectRoot);
  return extractBmadVersion(data);
}

async function readOutputFolder(projectRoot) {
  const bmadDir = path.join(projectRoot, '_bmad');
  if (!(await fs.pathExists(bmadDir))) return '_bmad-output';

  const modulePriority = ['bmm', 'core', 'bmb', 'cis'];
  const seen = new Set();
  const ordered = [];

  for (const mod of modulePriority) {
    const candidate = path.join(bmadDir, mod, 'config.yaml');
    ordered.push(candidate);
    seen.add(candidate);
  }

  try {
    const entries = await fs.readdir(bmadDir, { withFileTypes: true });
    // Sort by name for deterministic precedence across filesystems; otherwise
    // two users on different OSes could resolve different output_folder
    // values when multiple non-priority module configs are present.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const cfg = path.join(bmadDir, entry.name, 'config.yaml');
      if (!seen.has(cfg)) {
        ordered.push(cfg);
        seen.add(cfg);
      }
    }
  } catch {
    // ignore
  }

  for (const cfgPath of ordered) {
    if (!(await fs.pathExists(cfgPath))) continue;
    const cfg = await readYaml(cfgPath);
    if (cfg && typeof cfg.output_folder === 'string' && cfg.output_folder.trim()) {
      return stripProjectRootPrefix(cfg.output_folder.trim());
    }
  }

  // v6.4+ four-layer TOML config fallback. Reached only when no config.yaml
  // yielded a value, so existing YAML installs stay byte-identical. User
  // overrides win over the base file; the scan is section-agnostic (we only
  // need the scalar). js-yaml can't parse TOML, so match the key line directly.
  for (const tomlName of ['config.user.toml', 'config.toml']) {
    const tomlPath = path.join(bmadDir, tomlName);
    if (!(await fs.pathExists(tomlPath))) continue;
    let raw;
    try {
      raw = await fs.readFile(tomlPath, 'utf8');
    } catch {
      continue;
    }
    const m = raw.match(/^\s*output_folder\s*=\s*(.+?)\s*(?:#.*)?$/m);
    if (m) {
      const val = m[1].replace(/^["']|["']$/g, '').trim();
      if (val) return stripProjectRootPrefix(val);
    }
  }

  return '_bmad-output';
}

async function readAddonManifestVersion(manifestPath) {
  const data = await readYaml(manifestPath);
  return data?.addon?.version || null;
}

// Read the compat bounds from the addon manifest so the guard has a single
// source of truth: the floor from `bmad_compatibility` (">=X.Y.Z") and the
// tested-through ceiling from `bmad_tested_through`. Missing/unparseable
// fields resolve to null (the guard treats null bounds as "no constraint").
async function readCompatBounds(manifestPath) {
  const data = await readYaml(manifestPath);
  const addon = data?.addon || {};
  const floor = addon.bmad_compatibility
    ? semver.coerce(String(addon.bmad_compatibility))?.version || null
    : null;
  const testedThrough = addon.bmad_tested_through
    ? semver.coerce(String(addon.bmad_tested_through))?.version || null
    : null;
  return { floor, testedThrough };
}

// Pure, advisory compatibility classification. Returns { level, message }:
//   level 'ok'           — within [floor, testedThrough] (or bounds unknown)
//   level 'below_floor'  — older than the supported floor
//   level 'above_tested' — newer than the tested-through ceiling
// An unknown/unparseable version returns 'ok' with no message so unknown
// installs never warn spuriously. Never throws; callers warn but never fail.
function checkBmadCompat(version, bounds = {}) {
  const v = version ? semver.coerce(String(version))?.version : null;
  if (!v) return { level: 'ok', message: null };
  const { floor, testedThrough } = bounds;
  if (floor && semver.lt(v, floor)) {
    return {
      level: 'below_floor',
      message: `BMad Method ${version} is below Sprintpilot's supported floor (>=${floor}); some invoked skills may be missing.`,
    };
  }
  if (testedThrough && semver.gt(v, testedThrough)) {
    return {
      level: 'above_tested',
      message: `BMad Method ${version} is newer than the version Sprintpilot was tested against (${testedThrough}); proceeding — please report any issues.`,
    };
  }
  return { level: 'ok', message: null };
}

module.exports = {
  readYaml,
  verifyBmadInstalled,
  readBmadVersion,
  extractBmadVersion,
  readOutputFolder,
  readAddonManifestVersion,
  readCompatBounds,
  checkBmadCompat,
};
