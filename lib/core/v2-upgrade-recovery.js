// v2-upgrade-recovery.js — detect leftover snapshot/backup files from
// prior installer runs that may have silently clobbered user configs.
//
// Used at the top of `runInstall` to print a banner pointing the user
// at recoverable data. Returns paths only; the installer never deletes
// these — the user decides when they've been restored or are safe to
// discard.

const path = require('node:path');
const fs = require('fs-extra');

// Patterns we scan for, relative to projectRoot:
//   - *.bak-sprintpilot-migration*       (legacy marker strip backups)
//   - .sprintpilot-v1-snapshot*.json     (v1 module-config recovery dumps)
//
// Both are written today by the v1→v2 migration path (lib/commands/install.js
// pickBackupPath + persistSnapshotForRecovery). The same pattern could end
// up triggered if a future installer hits a write failure mid-merge.

const BACKUP_GLOB = /\.bak-sprintpilot-migration/;
const SNAPSHOT_GLOB = /^\.sprintpilot-v1-snapshot.*\.json$/;

async function scanForLeftoverSnapshots(projectRoot) {
  const out = [];
  // Top-level scan only (non-recursive). The two patterns are always
  // written at the project root or alongside the file they backed up.
  try {
    const entries = await fs.readdir(projectRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (SNAPSHOT_GLOB.test(entry.name) || BACKUP_GLOB.test(entry.name)) {
        out.push(path.join(projectRoot, entry.name));
      }
    }
  } catch {
    // projectRoot unreadable — caller can't act on the banner anyway.
    return out;
  }

  // Also scan a couple of well-known directories where backup files
  // accumulate (AGENTS.md.bak-sprintpilot-migration is at root, but
  // .clinerules.bak-... could live wherever the rules file lives).
  // For now, root-only is enough — extend if real reports surface.
  return out;
}

module.exports = { scanForLeftoverSnapshots };
