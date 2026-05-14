const { execFile } = require('node:child_process');
const semver = require('semver');

const PACKAGE_NAME = '@ikunin/sprintpilot';

function spawnCapture(cmd, args, { timeoutMs = 7000 } = {}) {
  return new Promise((resolve) => {
    // On Windows, npm ships as `npm.cmd` (a batch shim). Node's `execFile`
    // doesn't resolve `.cmd` / `.bat` extensions through PATHEXT — pass
    // `shell: true` so cmd.exe handles the lookup. Args are hardcoded
    // here so there's no injection risk. (Linux/macOS execFile is fine
    // as-is.)
    const opts = {
      timeout: timeoutMs,
      windowsHide: true,
      shell: process.platform === 'win32',
    };
    const child = execFile(cmd, args, opts, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout || '').trim());
    });
    child.on('error', () => resolve(null));
  });
}

async function fetchLatestVersion() {
  const out = await spawnCapture('npm', ['view', `${PACKAGE_NAME}@latest`, 'version']);
  if (!out) return null;
  const first = out.split(/\r?\n/)[0].trim();
  return semver.valid(first) ? first : null;
}

function compareVersions(currentRaw, latestRaw) {
  if (!currentRaw || !latestRaw) return 'unknown';
  const current = semver.coerce(currentRaw)?.version || currentRaw;
  const latest = semver.coerce(latestRaw)?.version || latestRaw;
  if (!semver.valid(current) || !semver.valid(latest)) return 'unknown';
  if (semver.gt(latest, current)) return 'behind';
  if (semver.lt(latest, current)) return 'ahead';
  return 'current';
}

module.exports = {
  PACKAGE_NAME,
  fetchLatestVersion,
  compareVersions,
};
