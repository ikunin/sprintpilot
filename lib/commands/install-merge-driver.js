// Wires (and unwires) the BMad-state-file merge driver in the user's repo.
//
// Two side effects per install:
//   1. Idempotent block in `.gitattributes` mapping the four state files
//      to `merge=bmad-doc`.
//   2. Repo-local git config registering the driver with `node ...` invocation.
//
// Both operations are best-effort and skip cleanly when:
//   - There's no `.git` directory (the project is not a git repo yet).
//   - `git` isn't on PATH.
//   - `_Sprintpilot/scripts/auto-merge-bmad-docs.js` doesn't exist after copy
//     (shouldn't happen in normal installs; if it does, refuse to register
//     so the driver doesn't point at a missing script).
//
// Uninstall is the inverse and equally tolerant of partial state.

const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('fs-extra');

const execFileAsync = promisify(execFile);

const BEGIN = '# BEGIN:sprintpilot-merge-driver';
const END = '# END:sprintpilot-merge-driver';

const STATE_FILES = [
  '_bmad-output/implementation-artifacts/sprint-status.yaml',
  '_bmad-output/implementation-artifacts/git-status.yaml',
  '_bmad-output/implementation-artifacts/decision-log.yaml',
  '_bmad-output/implementation-artifacts/autopilot-state.yaml',
];

const DRIVER_NAME = 'bmad-doc';
// %P is the pathname of the file being merged; the driver dispatches on
// it because %A is a temp-file like `.merge_file_XYZ` that doesn't tell
// us which BMad file kind we're merging.
const DRIVER_INVOCATION = 'node _Sprintpilot/scripts/auto-merge-bmad-docs.js %A %O %B %P';
const DRIVER_DESCRIPTION = 'Sprintpilot auto-merge for BMad state files';

function escRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildBlock() {
  const body = STATE_FILES.map((f) => `${f} merge=${DRIVER_NAME}`).join('\n');
  return `${BEGIN}\n${body}\n${END}`;
}

function stripBlock(text) {
  if (!text) return text;
  const re = new RegExp(`\\n*${escRegex(BEGIN)}[\\s\\S]*?${escRegex(END)}\\n?`, 'g');
  return text.replace(re, (m) => (m.startsWith('\n\n') ? '\n' : ''));
}

function hasBlock(text) {
  if (!text) return false;
  return text.includes(BEGIN) && text.includes(END);
}

function upsertBlock(text) {
  const block = buildBlock();
  const stripped = stripBlock(text || '').replace(/\s+$/, '');
  if (!stripped) return `${block}\n`;
  return `${stripped}\n\n${block}\n`;
}

async function isGitRepo(projectRoot) {
  return fs.pathExists(path.join(projectRoot, '.git'));
}

async function gitConfigSet(projectRoot, key, value) {
  await execFileAsync('git', ['-C', projectRoot, 'config', '--local', key, value]);
}

async function gitConfigRemoveSection(projectRoot, section) {
  try {
    await execFileAsync('git', [
      '-C',
      projectRoot,
      'config',
      '--local',
      '--remove-section',
      section,
    ]);
  } catch (e) {
    if (e.code === 128) return; // no such section
    throw e;
  }
}

async function installMergeDriver(projectRoot, { dryRun = false, log = console } = {}) {
  const driverScript = path.join(projectRoot, '_Sprintpilot', 'scripts', 'auto-merge-bmad-docs.js');
  if (!(await fs.pathExists(driverScript))) {
    log.warn?.(
      'Sprintpilot merge driver: script missing at _Sprintpilot/scripts/auto-merge-bmad-docs.js — skipping registration.',
    );
    return { skipped: 'script-missing' };
  }

  const gitattributesPath = path.join(projectRoot, '.gitattributes');
  const before = (await fs.pathExists(gitattributesPath))
    ? await fs.readFile(gitattributesPath, 'utf8')
    : '';
  const after = upsertBlock(before);

  if (dryRun) {
    if (before !== after) {
      log.log?.(
        `[DRY RUN] Would update .gitattributes with merge driver block (${STATE_FILES.length} entries)`,
      );
    } else {
      log.log?.('[DRY RUN] .gitattributes already has merge driver block');
    }
  } else if (before !== after) {
    await fs.writeFile(gitattributesPath, after, 'utf8');
    log.log?.(
      hasBlock(before)
        ? '.gitattributes: refreshed merge driver block'
        : '.gitattributes: added merge driver block',
    );
  }

  if (!(await isGitRepo(projectRoot))) {
    log.log?.(
      'Sprintpilot merge driver: no .git directory — driver registration deferred (re-run install after `git init`).',
    );
    return { gitattributes: 'updated', gitConfig: 'skipped' };
  }

  if (dryRun) {
    log.log?.(
      `[DRY RUN] Would register git config: merge.${DRIVER_NAME}.driver = ${DRIVER_INVOCATION}`,
    );
    return { gitattributes: 'dry-run', gitConfig: 'dry-run' };
  }

  await gitConfigSet(projectRoot, `merge.${DRIVER_NAME}.name`, DRIVER_DESCRIPTION);
  await gitConfigSet(projectRoot, `merge.${DRIVER_NAME}.driver`, DRIVER_INVOCATION);
  // `recursive = binary` tells git not to recurse the merge for binary
  // files, which is irrelevant here but it's the documented default for
  // custom drivers — be explicit so git doesn't print a warning.
  await gitConfigSet(projectRoot, `merge.${DRIVER_NAME}.recursive`, 'binary');
  log.log?.(`Sprintpilot merge driver registered: merge.${DRIVER_NAME}`);
  return { gitattributes: 'updated', gitConfig: 'updated' };
}

async function uninstallMergeDriver(projectRoot, { dryRun = false, log = console } = {}) {
  const gitattributesPath = path.join(projectRoot, '.gitattributes');
  const before = (await fs.pathExists(gitattributesPath))
    ? await fs.readFile(gitattributesPath, 'utf8')
    : '';
  if (hasBlock(before)) {
    const after = stripBlock(before).replace(/^\s+|\s+$/g, '');
    if (dryRun) {
      log.log?.('[DRY RUN] Would strip merge driver block from .gitattributes');
    } else if (after === '') {
      // File becomes empty — remove it rather than leaving an empty stub.
      await fs.remove(gitattributesPath);
      log.log?.('.gitattributes: removed (was Sprintpilot-only)');
    } else {
      await fs.writeFile(gitattributesPath, `${after}\n`, 'utf8');
      log.log?.('.gitattributes: stripped merge driver block');
    }
  }

  if (!(await isGitRepo(projectRoot))) {
    return { gitattributes: 'cleaned', gitConfig: 'skipped' };
  }

  if (dryRun) {
    log.log?.(`[DRY RUN] Would unregister git config section merge.${DRIVER_NAME}`);
    return { gitattributes: 'dry-run', gitConfig: 'dry-run' };
  }

  await gitConfigRemoveSection(projectRoot, `merge.${DRIVER_NAME}`);
  log.log?.(`Sprintpilot merge driver unregistered: merge.${DRIVER_NAME}`);
  return { gitattributes: 'cleaned', gitConfig: 'cleaned' };
}

module.exports = {
  BEGIN,
  END,
  STATE_FILES,
  DRIVER_NAME,
  DRIVER_INVOCATION,
  DRIVER_DESCRIPTION,
  buildBlock,
  stripBlock,
  hasBlock,
  upsertBlock,
  installMergeDriver,
  uninstallMergeDriver,
};
