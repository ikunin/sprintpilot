'use strict';

const path = require('node:path');
const fs = require('fs-extra');

const { readAddonManifestVersion } = require('../core/bmad-config');
const { fetchLatestVersion, compareVersions } = require('../core/update-check');

async function runCheckUpdate() {
  const projectRoot = process.env.BMAD_PROJECT_ROOT || process.cwd();
  const packageRoot = path.resolve(__dirname, '..', '..');

  const projectManifest = path.join(projectRoot, '_Sprintpilot', 'manifest.yaml');
  const packageManifest = path.join(packageRoot, '_Sprintpilot', 'manifest.yaml');

  let current = null;
  if (await fs.pathExists(projectManifest)) {
    current = await readAddonManifestVersion(projectManifest);
  } else {
    current = await readAddonManifestVersion(packageManifest);
    if (current) console.log('(No project installation found — showing package version)');
  }

  if (!current) {
    console.log('Installed: unknown');
    return;
  }

  console.log(`Installed: ${current}`);

  const latest = await fetchLatestVersion();
  if (!latest) {
    console.log('Latest:    unknown (npm not found or unreachable)');
    console.log('');
    console.log('Could not reach npm registry.');
    return;
  }

  console.log(`Latest:    ${latest}`);
  console.log('');

  const rel = compareVersions(current, latest);
  if (rel === 'behind') {
    console.log('Update available! Run: npx @ikunin/sprintpilot@latest');
  } else if (rel === 'ahead') {
    console.log('Ahead of latest (pre-release or local build).');
  } else if (rel === 'current') {
    console.log('Up to date.');
  } else {
    console.log('Version comparison unavailable.');
  }
}

module.exports = { runCheckUpdate };
