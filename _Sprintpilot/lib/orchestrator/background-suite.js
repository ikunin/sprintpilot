// background-suite.js — kick off the full test suite as a detached
// subprocess after STORY_DONE, and read its result on the next session
// boot. Implements `testing.full_suite_on_story_land: background`.
//
// Lifecycle:
//
//   1. cmdRecord lands on STORY_DONE → spawn worker (scripts/
//      background-suite-worker.js) detached + unrefed; pass it the
//      resolved full-suite command, projectRoot, story_key, log path,
//      sidecar path. Returns immediately so the autopilot can continue.
//
//   2. Worker runs `bash -c "<command>"`, captures stdout/stderr to
//      `<sidecar-dir>/<story_key>.log`, writes a JSON sidecar at
//      `<sidecar-dir>/<story_key>.json` when the command exits.
//
//   3. cmdStart on the next session reads the LATEST sidecar via
//      readLatestSidecar(); if exit_code !== 0 AND the sidecar isn't
//      already-acknowledged, emit a user_prompt halt with reason
//      'background_full_suite_failed' carrying the command, exit_code,
//      story_key, and the tail of the log. acknowledgeSidecar() marks
//      it so subsequent boots don't re-halt.
//
// Pure-ish: subprocess spawn is the one I/O thing. Tests inject a
// fake spawn via `_spawnImpl` injection.
//
// Sidecar layout (under <projectRoot>/_bmad-output/implementation-
// artifacts/.background-suite/):
//
//   <story_key>.json   — { command, story_key, started_at,
//                          completed_at?, exit_code?, signal?,
//                          acknowledged? }
//   <story_key>.log    — full stdout + stderr of the run, tail-only
//                        included in the halt payload.

'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const nodeChildProcess = require('node:child_process');

const SIDECAR_REL_DIR = nodePath.join(
  '_bmad-output',
  'implementation-artifacts',
  '.background-suite',
);

const DEFAULT_WORKER_REL_PATH = nodePath.join(
  '_Sprintpilot',
  'scripts',
  'background-suite-worker.js',
);

function sidecarDir(projectRoot) {
  return nodePath.join(projectRoot, SIDECAR_REL_DIR);
}

function sidecarPath(projectRoot, storyKey) {
  const safe = sanitizeStoryKey(storyKey);
  return nodePath.join(sidecarDir(projectRoot), `${safe}.json`);
}

function logPath(projectRoot, storyKey) {
  const safe = sanitizeStoryKey(storyKey);
  return nodePath.join(sidecarDir(projectRoot), `${safe}.log`);
}

// Sidecar filenames must be filesystem-safe. We accept BMad-style keys
// like `1.2-foo` and reject anything outside `[A-Za-z0-9._-]`.
function sanitizeStoryKey(storyKey) {
  if (typeof storyKey !== 'string' || !storyKey) return '_unknown';
  return storyKey.replace(/[^A-Za-z0-9._-]/g, '_') || '_unknown';
}

function readSidecar(filePath, fs) {
  const f = fs || nodeFs;
  try {
    const text = f.readFileSync(filePath, 'utf8');
    return JSON.parse(text);
  } catch (_e) {
    return null;
  }
}

// readLatestSidecar(projectRoot, fs?) — return the most-recently-completed
// sidecar by completed_at. Skips entries that are still running (no
// completed_at field). Returns { ...sidecar, sidecar_path } or null.
function readLatestSidecar(projectRoot, fs) {
  const f = fs || nodeFs;
  const dir = sidecarDir(projectRoot);
  let entries = [];
  try {
    entries = f.readdirSync(dir);
  } catch (_e) {
    return null;
  }
  let latest = null;
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const filePath = nodePath.join(dir, name);
    const obj = readSidecar(filePath, f);
    if (!obj || !obj.completed_at) continue;
    const ts = Date.parse(obj.completed_at);
    if (!Number.isFinite(ts)) continue;
    if (!latest || ts > latest.ts) {
      latest = { ts, sidecar: { ...obj, sidecar_path: filePath } };
    }
  }
  return latest ? latest.sidecar : null;
}

// resolveFullSuiteCommand(profile, projectRoot) — pick the command we'd
// run for `scope='full'`. Prefers the user override
// (profile.testing_commands_full); falls back to the project's adapter
// via testing/scope.js when omitted. Returns null when neither is
// available — the caller should skip background spawn cleanly.
function resolveFullSuiteCommand(profile, projectRoot, { registry } = {}) {
  if (profile && typeof profile.testing_commands_full === 'string' && profile.testing_commands_full) {
    return profile.testing_commands_full;
  }
  const reg = registry || requireOptional('./testing/index', projectRoot);
  if (!reg || typeof reg.pickAdapter !== 'function') return null;
  const adapter = reg.pickAdapter(projectRoot);
  if (!adapter || typeof adapter.buildCmd !== 'function') return null;
  try {
    return adapter.buildCmd({ scope: 'full', profile, projectRoot }) || null;
  } catch (_e) {
    return null;
  }
}

function requireOptional(modulePath /* , projectRoot */) {
  try {
    // eslint-disable-next-line global-require
    return require(modulePath);
  } catch (_e) {
    return null;
  }
}

// Write the pre-spawn sidecar with status='running' so cmdStart can
// distinguish a still-running suite from a missing one. The worker
// overwrites this with the final status on exit. Atomic via tmp+rename.
function writeRunningSidecar({ projectRoot, storyKey, command, startedAt, fs }) {
  const f = fs || nodeFs;
  const dir = sidecarDir(projectRoot);
  f.mkdirSync(dir, { recursive: true });
  const filePath = sidecarPath(projectRoot, storyKey);
  const payload = {
    schema: 'sprintpilot.background-suite.v1',
    story_key: storyKey,
    command,
    started_at: startedAt,
    status: 'running',
  };
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  f.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  f.renameSync(tmp, filePath);
  return filePath;
}

// spawnBackground({ command, projectRoot, storyKey }) — detach + unref a
// worker subprocess and return immediately. The worker writes the
// completion sidecar (exit_code, signal, completed_at) when the
// command finishes; cmdStart on the next session reads it.
//
// Worker contract:
//   node <projectRoot>/_Sprintpilot/scripts/background-suite-worker.js
//     --sidecar <sidecar.json>
//     --log <sidecar.log>
//     --story-key <key>
//     --command <shell-string>
//
// Returns { pid, sidecar_path, log_path, started_at } when the spawn
// succeeded, or null when no command was available / spawn failed.
function spawnBackground({
  command,
  projectRoot,
  storyKey,
  fs = nodeFs,
  childProcess = nodeChildProcess,
  workerPath,
  _now,
}) {
  if (!command || !projectRoot || !storyKey) return null;
  const startedAt = _now || new Date().toISOString();
  let sidecar;
  try {
    sidecar = writeRunningSidecar({
      projectRoot,
      storyKey,
      command,
      startedAt,
      fs,
    });
  } catch (e) {
    return { error: `sidecar_write_failed: ${e.message}` };
  }

  const log = logPath(projectRoot, storyKey);
  const resolvedWorker = workerPath || nodePath.join(projectRoot, DEFAULT_WORKER_REL_PATH);

  const args = [
    resolvedWorker,
    '--sidecar', sidecar,
    '--log', log,
    '--story-key', storyKey,
    '--command', command,
  ];

  try {
    const child = childProcess.spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      cwd: projectRoot,
    });
    child.unref();
    return {
      pid: child.pid,
      sidecar_path: sidecar,
      log_path: log,
      started_at: startedAt,
    };
  } catch (e) {
    return { error: `spawn_failed: ${e.message}`, sidecar_path: sidecar };
  }
}

// acknowledgeSidecar(sidecarPath, fs?) — mark a completed sidecar as
// acknowledged so cmdStart doesn't re-halt on the same failure. Atomic
// via tmp+rename. Best-effort: errors are swallowed and the next boot
// will simply re-halt (annoying but not destructive).
function acknowledgeSidecar(filePath, fs) {
  const f = fs || nodeFs;
  try {
    const text = f.readFileSync(filePath, 'utf8');
    const obj = JSON.parse(text);
    obj.acknowledged = true;
    obj.acknowledged_at = new Date().toISOString();
    const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    f.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    f.renameSync(tmp, filePath);
    return true;
  } catch (_e) {
    return false;
  }
}

// tailLog(logPath, maxBytes) — return the last `maxBytes` of the log
// for inclusion in the halt prompt. Default 4kB keeps the prompt
// scannable. Returns '' on missing/unreadable.
function tailLog(filePath, maxBytes, fs) {
  const f = fs || nodeFs;
  const cap = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : 4096;
  try {
    const stat = f.statSync(filePath);
    if (stat.size <= cap) return f.readFileSync(filePath, 'utf8');
    const fd = f.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(cap);
      f.readSync(fd, buf, 0, cap, stat.size - cap);
      return buf.toString('utf8');
    } finally {
      f.closeSync(fd);
    }
  } catch (_e) {
    return '';
  }
}

// checkPriorRun(projectRoot, profile, fs?) — return a halt descriptor
// when the most recent sidecar shows failure and hasn't been ack'd.
// Returns null when:
//   - profile.testing_full_suite_on_story_land !== 'background'
//   - no sidecar exists
//   - latest sidecar has exit_code === 0 OR is still running
//   - latest sidecar is already acknowledged
function checkPriorRun(projectRoot, profile, fs) {
  if (!profile || profile.testing_full_suite_on_story_land !== 'background') return null;
  const latest = readLatestSidecar(projectRoot, fs);
  if (!latest) return null;
  if (latest.acknowledged) return null;
  if (typeof latest.exit_code !== 'number') return null;
  if (latest.exit_code === 0) return null;
  const logText = latest.log_path ? tailLog(latest.log_path, 4096, fs) : '';
  return {
    sidecar: latest,
    log_tail: logText,
  };
}

module.exports = {
  SIDECAR_REL_DIR,
  sidecarDir,
  sidecarPath,
  logPath,
  readLatestSidecar,
  resolveFullSuiteCommand,
  spawnBackground,
  acknowledgeSidecar,
  tailLog,
  checkPriorRun,
  // Exposed for tests.
  writeRunningSidecar,
  sanitizeStoryKey,
};
