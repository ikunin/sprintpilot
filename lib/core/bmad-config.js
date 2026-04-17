const path = require('node:path');
const fs = require('fs-extra');
const yaml = require('js-yaml');

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

// BMad Method has used two manifest shapes:
//   - flat:   { version: "6.3.0" }
//   - nested: { bmad: { version: "6.2.0" } }
// The shipping v6 installer writes the nested form; some older installs
// and our own unit-test fixture use the flat form. Try nested first,
// then fall back to flat so either layout resolves to a real version.
function extractBmadVersion(data) {
  if (!data) return null;
  if (data.bmad && data.bmad.version) return data.bmad.version;
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

  return '_bmad-output';
}

async function readAddonManifestVersion(manifestPath) {
  const data = await readYaml(manifestPath);
  return (data && data.addon && data.addon.version) || null;
}

module.exports = {
  readYaml,
  verifyBmadInstalled,
  readBmadVersion,
  extractBmadVersion,
  readOutputFolder,
  readAddonManifestVersion,
};
