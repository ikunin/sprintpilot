'use strict';

const child = require('node:child_process');

function run(file, args, { cwd, timeoutMs = 30_000, input, env } = {}) {
  return new Promise((resolve, reject) => {
    const proc = child.execFile(
      file,
      args,
      {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
        env: env || process.env,
      },
      (err, stdout, stderr) => {
        if (err) {
          const e = new Error(
            `${file} ${args.join(' ')} failed with code ${err.code ?? err.signal ?? 'unknown'}`
          );
          e.exitCode = typeof err.code === 'number' ? err.code : 1;
          e.signal = err.signal || null;
          e.stdout = String(stdout || '');
          e.stderr = String(stderr || '');
          e.originalError = err;
          return reject(e);
        }
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), exitCode: 0 });
      }
    );
    // Rejecting on spawn-time errors (ENOENT etc) ensures the caller sees a
    // rejected Promise rather than hanging, even if `proc.stdin` was never
    // attached. Without this, a missing binary can crash via `proc.stdin.write`.
    proc.on('error', reject);
    if (input !== undefined && proc.stdin) {
      proc.stdin.on('error', () => { /* ignore EPIPE etc */ });
      try { proc.stdin.write(input); } catch { /* ignore */ }
      try { proc.stdin.end(); } catch { /* ignore */ }
    }
  });
}

async function tryRun(file, args, opts) {
  try {
    return await run(file, args, opts);
  } catch (e) {
    return { stdout: e.stdout || '', stderr: e.stderr || '', exitCode: e.exitCode ?? 1, error: e };
  }
}

function runInherit(file, args, { cwd, env, input } = {}) {
  return new Promise((resolve, reject) => {
    const proc = child.spawn(file, args, {
      cwd,
      env: env || process.env,
      stdio: input !== undefined ? ['pipe', 'inherit', 'inherit'] : 'inherit',
      windowsHide: true,
    });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ exitCode: code ?? 0 }));
    if (input !== undefined && proc.stdin) {
      try { proc.stdin.write(input); proc.stdin.end(); } catch { /* ignore */ }
    }
  });
}

module.exports = { run, tryRun, runInherit };
