#!/usr/bin/env node

// land-this-pr — execute the `merge_strategy: land_as_you_go` flow for a
// single freshly-opened PR so the autopilot workflow needs only ONE line
// of prose for it. Runs (in order):
//
//   1. extract-pr-number.js  → PR number from --pr-url
//   2. pr-watch.js           → poll CI until terminal or timeout
//   3. pr-merge.js (on green) → merge via platform API
//   4. git checkout + pull   → advance the base branch (so the next
//                              story starts from updated main)
//
// All sub-steps are this script's job. The workflow only handles the
// "do we land or not" boolean and reports the result.
//
// Usage:
//   land-this-pr.js --pr-url <url> --platform <p> --base-branch <b>
//                   [--method merge|squash|rebase]
//                   [--ci-timeout 600] [--poll-interval 30]
//                   [--on-ci-failure halt|warn_and_continue]
//                   [--delete-branch] [--base-url <url>]
//                   [--has-origin true|false]
//
// Output (JSON to stdout):
//   {
//     "merge_status": "merged" | "pr_pending" | "ci_red",
//     "ci_state": "success" | "failure" | "pending" | "unknown",
//     "timed_out": <bool>,
//     "halt": <bool>,        // true → caller should STOP the session
//     "message": "<human-readable>"
//   }
//
// Exit codes:
//   0 — flow ran cleanly (caller checks `merge_status` and `halt`)
//   1 — invalid argv
//   2 — couldn't extract PR number → caller leaves status as "pr_pending"

const path = require('node:path');

const { parseArgs } = require('../lib/runtime/args');
const { tryRun } = require('../lib/runtime/spawn');
const log = require('../lib/runtime/log');

const SCRIPT_DIR = __dirname;

function emit(payload) {
  log.out(JSON.stringify(payload));
}

async function callScript(scriptName, args, opts = {}) {
  const r = await tryRun('node', [path.join(SCRIPT_DIR, scriptName), ...args], {
    timeoutMs: opts.timeoutMs || 60_000,
  });
  let parsed = null;
  if (r.stdout) {
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      /* not JSON — leave parsed null */
    }
  }
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, json: parsed };
}

async function resolveConfig(key, defaultValue, enumValues) {
  // Resolve a config key via resolve-profile.js. Falls back to the
  // documented default on any failure so this script remains tolerant
  // of partial config / missing keys.
  const args = ['get', '--default', String(defaultValue)];
  if (enumValues) args.push('--enum', enumValues.join(','));
  args.push(key);
  const r = await tryRun('node', [path.join(SCRIPT_DIR, 'resolve-profile.js'), ...args], {
    timeoutMs: 5_000,
  });
  if (r.exitCode !== 0) return defaultValue;
  return r.stdout.trim() || defaultValue;
}

async function main() {
  const { opts } = parseArgs(process.argv.slice(2), { booleanFlags: ['delete-branch'] });

  const prUrl = opts['pr-url'];
  const platform = opts.platform;
  const baseBranch = opts['base-branch'] || 'main';
  const baseUrl = opts['base-url'];
  const hasOrigin = String(opts['has-origin'] || 'true').toLowerCase() !== 'false';

  // All merge-strategy options auto-resolve from config so the autopilot
  // workflow only has to pass the things it knows (PR URL, platform,
  // base branch). Caller can still override via explicit flag.
  const method =
    opts.method ||
    (await resolveConfig('autopilot.merge_strategy_options.merge_method', 'merge', [
      'merge',
      'squash',
      'rebase',
    ]));
  const ciTimeout =
    opts['ci-timeout'] ||
    (await resolveConfig('autopilot.merge_strategy_options.wait_for_ci_timeout_seconds', 600));
  const pollInterval =
    opts['poll-interval'] ||
    (await resolveConfig('autopilot.merge_strategy_options.poll_interval_seconds', 30));
  const onCiFailure =
    opts['on-ci-failure'] ||
    (await resolveConfig('autopilot.merge_strategy_options.on_ci_failure', 'halt', [
      'halt',
      'warn_and_continue',
    ]));
  const deleteBranch =
    'delete-branch' in opts
      ? !!opts['delete-branch']
      : String(
          await resolveConfig('autopilot.merge_strategy_options.delete_branch_after_merge', 'true'),
        ).toLowerCase() === 'true';

  if (!prUrl || !platform) {
    log.error('--pr-url and --platform are required');
    process.exit(1);
  }

  // 1. Extract PR number.
  const extractArgs = ['--url', prUrl, '--platform', platform];
  const ext = await callScript('extract-pr-number.js', extractArgs);
  if (ext.exitCode !== 0) {
    emit({
      merge_status: 'pr_pending',
      ci_state: 'unknown',
      timed_out: false,
      halt: false,
      message: `extract-pr-number failed: ${ext.stderr.trim() || 'no output'}`,
    });
    process.exit(2);
  }
  const prNumber = ext.stdout.trim();

  // 2. Watch CI.
  const watchArgs = [
    '--platform',
    platform,
    '--pr',
    prNumber,
    '--timeout',
    String(ciTimeout),
    '--interval',
    String(pollInterval),
  ];
  if (baseUrl) watchArgs.push('--base-url', baseUrl);
  const watch = await callScript('pr-watch.js', watchArgs, {
    timeoutMs: (Number(ciTimeout) + 60) * 1000,
  });
  const ciState = watch.json?.state || 'unknown';
  const timedOut = !!watch.json?.timed_out;

  // 3. Branch on CI state.
  if (ciState === 'success') {
    const mergeArgs = ['--platform', platform, '--pr', prNumber, '--method', method];
    if (deleteBranch) mergeArgs.push('--delete-branch');
    if (baseUrl) mergeArgs.push('--base-url', baseUrl);
    const merged = await callScript('pr-merge.js', mergeArgs);
    if (merged.json?.merged) {
      // Advance the base branch so the next story starts from updated main.
      if (hasOrigin) {
        await tryRun('git', ['checkout', baseBranch], { timeoutMs: 30_000 });
        await tryRun('git', ['pull', 'origin', baseBranch], { timeoutMs: 60_000 });
      } else {
        await tryRun('git', ['checkout', baseBranch], { timeoutMs: 30_000 });
      }
      emit({
        merge_status: 'merged',
        ci_state: 'success',
        timed_out: false,
        halt: false,
        message: `PR #${prNumber} merged (${method})`,
      });
      return;
    }
    emit({
      merge_status: 'pr_pending',
      ci_state: 'success',
      timed_out: false,
      halt: false,
      message: `platform refused merge: ${merged.json?.error || merged.stderr.trim() || 'no detail'}`,
    });
    return;
  }

  if (ciState === 'failure' || timedOut) {
    if (onCiFailure === 'halt') {
      emit({
        merge_status: 'ci_red',
        ci_state: ciState,
        timed_out: timedOut,
        halt: true,
        message: `CI for ${prUrl} ended state=${ciState} timed_out=${timedOut}. Halt session and re-run /sprint-autopilot-on after fix.`,
      });
      return;
    }
    // warn_and_continue
    emit({
      merge_status: 'pr_pending',
      ci_state: ciState,
      timed_out: timedOut,
      halt: false,
      message: `CI ${ciState} (timed_out=${timedOut}); leaving PR stacked at ${prUrl}.`,
    });
    return;
  }

  // state ∈ {'unknown', 'pending'} without timeout — degrade to manual stacking.
  emit({
    merge_status: 'pr_pending',
    ci_state: ciState,
    timed_out: false,
    halt: false,
    message: `CI ${ciState} — falling through to manual stacking.`,
  });
}

module.exports = { callScript };

if (require.main === module) {
  main().catch((e) => {
    log.error(e.message || String(e));
    process.exit(1);
  });
}
