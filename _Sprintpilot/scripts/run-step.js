#!/usr/bin/env node
/**
 * run-step.js — canonical executor for a single planned step.
 *
 * Reads a step JSON from stdin (or --step-file <path>) and runs it
 * honoring the documented metadata contract from workflow.orchestrator.md:
 *
 *   - args: string[]                — argv (no shell interpolation)
 *   - description?: string          — for logs only
 *   - env?: { [k]: string }         — merged into process.env for the
 *                                     step's lifetime
 *   - retry?: { attempts, backoff_ms: [...], on: 'network'|'never' }
 *                                   — re-run on failure. `attempts`
 *                                     counts ATTEMPTS including the
 *                                     first; backoff_ms is consulted
 *                                     between retries (using
 *                                     backoff_ms[i] for attempt i+1, or
 *                                     the last value if out of range).
 *                                     `on: 'never'` disables retry
 *                                     regardless of attempts.
 *   - tolerate_exit_codes?: number[]
 *                                   — non-zero exit codes treated as
 *                                     success (idempotency for ops like
 *                                     gh pr merge / create-pr.js SKIPPED)
 *   - optional?: boolean            — non-zero exit logged as warning,
 *                                     runner still exits 0 so the caller
 *                                     continues to the next step
 *   - timeout_ms?: number           — per-attempt timeout
 *
 * Exit semantics:
 *   0 — step succeeded (real success OR tolerate match OR optional fail)
 *   N — actual exit code of the final attempt, when neither
 *       tolerate_exit_codes nor optional applies
 *
 * Why this exists: the workflow contract used to assume the LLM reads
 * step metadata fields and honors them. That coupling let drift creep
 * in (e.g. tolerate_exit_codes silently ignored, optional treated as
 * fatal). A small Node executor is the source of truth so the LLM
 * doesn't need to remember the rules — it just runs
 * `node _Sprintpilot/scripts/run-step.js --step-file <tmpfile>` per
 * step and inspects exit code.
 *
 * Signal handling: SIGINT/SIGTERM received by run-step are forwarded
 * to the in-flight child (when one is alive) so Ctrl-C terminates
 * the chain cleanly rather than orphaning long-running `gh`/`git`
 * subprocesses.
 *
 * Usage:
 *   echo '{"args":["git","status"]}' | node run-step.js
 *   node run-step.js --step-file /tmp/step.json
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { parseArgs } = require('../lib/runtime/args');

function readStepJson(opts) {
  if (opts['step-file']) return fs.readFileSync(opts['step-file'], 'utf8');
  return fs.readFileSync(0, 'utf8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run a single attempt of the step's argv. Returns { exitCode, error }.
// stdin: 'ignore' so the subprocess doesn't inherit run-step's stdin
// (which is at EOF after readStepJson consumed it) — a command that
// reads stdin (e.g. `git commit --file=-`) would otherwise see an
// immediate EOF and silently produce nothing.
function runOnce(cmd, rest, env, timeoutMs, currentChildRef) {
  return new Promise((resolve) => {
    const child = spawn(cmd, rest, {
      stdio: ['ignore', 'inherit', 'inherit'],
      env,
      timeout: timeoutMs,
    });
    currentChildRef.child = child;
    child.on('error', (err) => {
      currentChildRef.child = null;
      resolve({ exitCode: 2, error: err });
    });
    child.on('close', (code, signal) => {
      currentChildRef.child = null;
      if (signal) {
        // Killed by signal — treat as non-zero. spawn maps signal name
        // to no exit code, so synthesize one (128 + signal-number ish).
        resolve({ exitCode: 130, error: null, signal });
      } else {
        resolve({ exitCode: typeof code === 'number' ? code : 2, error: null });
      }
    });
  });
}

function backoffFor(attemptIndex, backoffMs) {
  if (!Array.isArray(backoffMs) || backoffMs.length === 0) return 0;
  const idx = Math.min(attemptIndex, backoffMs.length - 1);
  return Math.max(0, Number(backoffMs[idx]) || 0);
}

async function runStep(step) {
  const [cmd, ...rest] = step.args;
  // Merge env: process.env first so unspecified keys stay; step.env
  // wins for overlapping keys. Explicit non-null + non-array check
  // because `typeof null === 'object'` and `typeof []  === 'object'`
  // would both pass a naive `typeof === 'object'` guard, leading to
  // `{...null}` (empty merge) or `{...[]}` (drops env entirely).
  const env =
    step.env !== null &&
    step.env !== undefined &&
    typeof step.env === 'object' &&
    !Array.isArray(step.env)
      ? { ...process.env, ...step.env }
      : process.env;

  if (step.description) {
    process.stderr.write(`[run-step] ${step.description}\n`);
  }

  const retry = step.retry || {};
  const retryEnabled = retry && retry.on && retry.on !== 'never';
  const maxAttempts =
    retryEnabled && Number.isInteger(retry.attempts) && retry.attempts > 0 ? retry.attempts : 1;
  const backoffMs = retryEnabled ? retry.backoff_ms : null;
  const timeoutMs = typeof step.timeout_ms === 'number' ? step.timeout_ms : undefined;
  const tolerated = Array.isArray(step.tolerate_exit_codes) ? step.tolerate_exit_codes : [];

  const childRef = { child: null };
  const forwardSignal = (sig) => () => {
    if (childRef.child && !childRef.child.killed) {
      try {
        childRef.child.kill(sig);
      } catch (_e) {
        /* best-effort */
      }
    }
    process.exit(130);
  };
  process.on('SIGINT', forwardSignal('SIGINT'));
  process.on('SIGTERM', forwardSignal('SIGTERM'));

  let lastExit = 0;
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const wait = backoffFor(attempt - 1, backoffMs);
      if (wait > 0) {
        process.stderr.write(
          `[run-step] retry attempt ${attempt + 1}/${maxAttempts} after ${wait}ms\n`,
        );
        await sleep(wait);
      } else {
        process.stderr.write(`[run-step] retry attempt ${attempt + 1}/${maxAttempts}\n`);
      }
    }
    const r = await runOnce(cmd, rest, env, timeoutMs, childRef);
    lastExit = r.exitCode;
    lastError = r.error;
    if (lastError && step.optional) {
      process.stderr.write(
        `[run-step] WARN optional step failed to launch: ${lastError.message}\n`,
      );
      return 0;
    }
    if (lastError) {
      process.stderr.write(`run-step: spawn error: ${lastError.message}\n`);
      return 2;
    }
    if (lastExit === 0 || tolerated.includes(lastExit)) {
      return 0;
    }
    // Non-zero and not tolerated. Retry policy `on: 'network'` is a
    // declared intent — we re-run for any failure since we can't tell
    // a network error from a logic error by exit code alone. The
    // orchestrator's adapt.js classifies failure kinds afterwards.
  }
  if (step.optional) {
    process.stderr.write(`[run-step] WARN optional step exited ${lastExit}; continuing\n`);
    return 0;
  }
  return lastExit;
}

async function main() {
  const { opts } = parseArgs(process.argv.slice(2));
  let raw;
  try {
    raw = readStepJson(opts);
  } catch (e) {
    process.stderr.write(`run-step: cannot read step JSON: ${e.message}\n`);
    process.exit(2);
  }

  let step;
  try {
    step = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`run-step: invalid JSON: ${e.message}\n`);
    process.exit(2);
  }

  if (!step || !Array.isArray(step.args) || step.args.length === 0) {
    process.stderr.write('run-step: step.args (non-empty array) required\n');
    process.exit(2);
  }

  const code = await runStep(step);
  process.exit(code);
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`run-step: ${e.stack || e.message || String(e)}\n`);
    process.exit(2);
  });
}

module.exports = { main, runStep };
// Keep spawnSync import alive in case external callers use it (no-op
// reference for tooling that prunes unused imports).
void spawnSync;
