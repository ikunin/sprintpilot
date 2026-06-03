#!/usr/bin/env node
// background-suite-worker.js — child process that runs the full test
// suite in the background. Invoked detached by
// _Sprintpilot/lib/orchestrator/background-suite.js#spawnBackground.
//
// Lifecycle:
//   1. Open the log file for streaming stdout/stderr.
//   2. Spawn `bash -c "<command>"` (or `cmd /c` on Windows) with stdio
//      piped to the log.
//   3. When the command exits, atomically write the final sidecar with
//      exit_code, signal, completed_at, duration_ms.
//   4. Exit with the same code so anything monitoring the process group
//      can see the result, even though normally nothing's watching.
//
// CLI:
//   node background-suite-worker.js
//     --sidecar <sidecar.json>
//     --log <sidecar.log>
//     --story-key <key>
//     --command <shell-string>
//
// Safety:
//   - The worker is detached + unrefed by its parent; if the user
//     terminates the autopilot session, the worker keeps running and
//     still writes its sidecar.
//   - The sidecar's `status` flips from 'running' (pre-spawn) to
//     'completed' here. cmdStart treats missing exit_code as
//     "still running" so a half-completed sidecar doesn't trigger a
//     false halt.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const val = argv[i + 1];
      if (val !== undefined && !val.startsWith('--')) {
        out[key] = val;
        i += 1;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

function readSidecar(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_e) {
    return null;
  }
}

function writeSidecarAtomic(filePath, obj) {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

async function main() {
  const opts = parseArgs(process.argv);
  const sidecarPath = opts.sidecar;
  const logPath = opts.log;
  const storyKey = opts['story-key'] || '_unknown';
  const command = opts.command;

  if (!sidecarPath || !logPath || !command) {
    process.stderr.write('background-suite-worker: missing required args\n');
    process.exit(2);
  }

  const startedAt = new Date().toISOString();
  // Preserve the pre-spawn payload (started_at, command) by reading
  // the running sidecar; the parent process wrote it just before spawn.
  const prior = readSidecar(sidecarPath) || {};

  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStream.write(`[${startedAt}] worker_started story=${storyKey} command=${command}\n`);

  const isWindows = process.platform === 'win32';
  const shellArgs = isWindows ? ['/c', command] : ['-c', command];
  const shellBin = isWindows ? 'cmd' : 'bash';

  const beganAt = Date.now();
  const child = spawn(shellBin, shellArgs, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  child.stdout.pipe(logStream, { end: false });
  child.stderr.pipe(logStream, { end: false });

  child.on('close', (code, signal) => {
    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - beganAt;
    const finalPayload = {
      ...prior,
      story_key: storyKey,
      command,
      started_at: prior.started_at || startedAt,
      completed_at: completedAt,
      duration_ms: durationMs,
      exit_code: typeof code === 'number' ? code : null,
      signal: signal || null,
      log_path: logPath,
      status: 'completed',
    };
    try {
      writeSidecarAtomic(sidecarPath, finalPayload);
    } catch (e) {
      logStream.write(`[${completedAt}] sidecar_write_failed: ${e.message}\n`);
    }
    logStream.write(
      `[${completedAt}] worker_exit code=${code} signal=${signal || 'none'} duration_ms=${durationMs}\n`,
    );
    logStream.end(() => process.exit(typeof code === 'number' ? code : 1));
  });

  child.on('error', (err) => {
    const completedAt = new Date().toISOString();
    const finalPayload = {
      ...prior,
      story_key: storyKey,
      command,
      started_at: prior.started_at || startedAt,
      completed_at: completedAt,
      exit_code: -1,
      error: err.message,
      log_path: logPath,
      status: 'spawn_error',
    };
    try {
      writeSidecarAtomic(sidecarPath, finalPayload);
    } catch (_e) {
      // Best-effort.
    }
    logStream.write(`[${completedAt}] worker_spawn_error: ${err.message}\n`);
    logStream.end(() => process.exit(1));
  });
}

main().catch((err) => {
  process.stderr.write(`background-suite-worker fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
