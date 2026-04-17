const path = require('node:path');
const fs = require('fs-extra');

const { readYaml } = require('./bmad-config');

const V1_ADDON_DIR_NAME = '_bmad-addons';
const V1_MANIFEST_NAME = 'bmad-ma-git';
const V1_SKILL_NAMES = [
  'bmad-autopilot-on',
  'bmad-autopilot-off',
  'bmad-addon-update',
  'bmad-ma-code-review',
  'bmad-ma-codebase-map',
  'bmad-ma-assess',
  'bmad-ma-reverse-architect',
  'bmad-ma-migrate',
  'bmad-ma-research',
  'bmad-ma-party-mode',
];

// Returns { v1Dir, v1Manifest, detectedVia, manifestAddonName } if the
// project at projectRoot looks like a bmad-autopilot-addon v1 install, or
// null otherwise. A "v1 signature" is either: manifest.yaml with
// addon.name === 'bmad-ma-git' OR (manifest missing/unreadable/naming a
// different addon but) a skills/ directory containing at least one
// v1-named skill dir. A malformed manifest does NOT short-circuit to
// "not v1" — we fall through to the skill-dir heuristic instead, because
// partial prior installs frequently leave a corrupt manifest behind.
//
// detectedVia distinguishes the trust level:
//   'manifest'        — authoritative (manifest names bmad-ma-git)
//   'skills-no-manifest'     — manifest missing, skill-dir heuristic triggered
//   'skills-unreadable-manifest' — manifest present but unparseable
//   'skills-other-addon'     — manifest cleanly names a DIFFERENT addon,
//                              skill dirs still look v1-ish. Ambiguous —
//                              caller should require explicit confirmation.
async function detectV1Installation(projectRoot) {
  const v1Dir = path.join(projectRoot, V1_ADDON_DIR_NAME);
  if (!(await fs.pathExists(v1Dir))) return null;
  const v1Manifest = path.join(v1Dir, 'manifest.yaml');

  let isV1 = false;
  let manifestAddonName = null;
  let manifestState = 'missing'; // missing | unreadable | parsed
  if (await fs.pathExists(v1Manifest)) {
    try {
      const data = await readYaml(v1Manifest);
      if (data === null) {
        manifestState = 'unreadable';
      } else {
        manifestState = 'parsed';
        manifestAddonName = (data && data.addon && data.addon.name) || null;
        if (manifestAddonName === V1_MANIFEST_NAME) isV1 = true;
      }
    } catch {
      manifestState = 'unreadable';
    }
  }

  let detectedVia = isV1 ? 'manifest' : null;

  if (!isV1) {
    const v1SkillsDir = path.join(v1Dir, 'skills');
    if (await fs.pathExists(v1SkillsDir)) {
      const entries = await fs.readdir(v1SkillsDir, { withFileTypes: true });
      const names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      if (names.some((n) => V1_SKILL_NAMES.includes(n))) {
        isV1 = true;
        if (manifestState === 'parsed') detectedVia = 'skills-other-addon';
        else if (manifestState === 'unreadable') detectedVia = 'skills-unreadable-manifest';
        else detectedVia = 'skills-no-manifest';
      }
    }
  }

  return isV1 ? { v1Dir, v1Manifest, detectedVia, manifestAddonName } : null;
}

module.exports = {
  V1_ADDON_DIR_NAME,
  V1_MANIFEST_NAME,
  V1_SKILL_NAMES,
  detectV1Installation,
};
