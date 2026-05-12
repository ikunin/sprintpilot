#!/usr/bin/env node

// autopilot.js — orchestrator CLI.
//
// Subcommands:
//   start              Boot a session; emit the first action or resume divergence prompt.
//   next               Emit the next planned action (JSON to stdout).
//   record --signal    Consume a signal (JSON via stdin or --signal-file).
//   state              Print the current orchestrator state (YAML).
//   report             Print a summary of the current session.
//   validate-config    Resolve the active profile + report it.
//   status             One-line status for shell prompts and watch scripts.
//
// Single JSON object on stdout (per subcommand). Logs/warnings on stderr.
// Pure: read state → apply pure functions → write state. State lives in
// _bmad-output/implementation-artifacts/autopilot-state.yaml.
//
// All side effects route through:
//   - state-store.js     (state writes; honors coalesce_state_writes)
//   - action-ledger.js   (append-only audit log)
//   - decision-log.js    (decisions[] audit channel)

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');

const stateMachine = require('../lib/orchestrator/state-machine');
const adapt = require('../lib/orchestrator/adapt');
const profileRules = require('../lib/orchestrator/profile-rules');
const verifyMod = require('../lib/orchestrator/verify');
const stateStore = require('../lib/orchestrator/state-store');
const ledger = require('../lib/orchestrator/action-ledger');
const decisionLog = require('../lib/orchestrator/decision-log');
const userCommands = require('../lib/orchestrator/user-commands');
const divergence = require('../lib/orchestrator/divergence');

const { STATES } = stateMachine;

const SUBCOMMANDS = ['start', 'next', 'record', 'state', 'report', 'validate-config', 'status'];

function help() {
  log.out(
    [
      'Usage:',
      '  autopilot start              Boot/resume the session',
      '  autopilot next               Emit the next planned action (JSON)',
      '  autopilot record --signal <json> | --signal-file <path>',
      '  autopilot state              Print current state (YAML)',
      '  autopilot report             Session report (markdown)',
      '  autopilot validate-config    Resolve + print active profile',
      '  autopilot status             One-line status',
      '',
      'Global flags:',
      '  --project-root <path>        Default: CWD',
      '  --profile <nano|small|medium|large|legacy>',
      '                               Override resolved profile',
      '  --help                       Show this help',
    ].join('\n'),
  );
}

// ------------------------------------------------------------ profile + state

function resolveProjectRoot(opts) {
  return path.resolve(opts['project-root'] || process.cwd());
}

// Loads the resolved profile tree by shelling out to resolve-profile.js? No —
// we read the profile YAML files directly via the same logic. To avoid
// duplicating that here, we just `require` it inline. resolve-profile.js
// exports its resolver functions.
function resolveProfile(projectRoot, explicit) {
  const resolver = require('../scripts/resolve-profile.js');
  const r = resolver.resolveProfile(projectRoot, explicit || null);
  const typed = profileRules.flatToProfile(r.resolved, r.profile);
  return { resolved: r.resolved, typed, source: r.source };
}

function loadState(projectRoot) {
  return stateStore.read({ projectRoot });
}

function persistState(updates, profile, projectRoot, story) {
  return stateStore.write(updates, profile, { projectRoot, story });
}

// Compose the runtime `state` shape the state machine expects from the
// persisted autopilot-state.yaml. Missing fields default to fresh-session
// values; the CLI does not assume more than what's on disk.
function composeRuntimeState(persisted) {
  const phase = persisted.current_bmad_step || STATES.CREATE_STORY;
  return {
    phase,
    story_key: persisted.current_story || null,
    story_file_path: persisted.story_file_path || null,
    current_epic: persisted.current_epic || null,
    ac_summary: persisted.ac_summary || null,
    prior_diagnosis: persisted.prior_diagnosis || null,
    relevant_decisions: persisted.relevant_decisions || [],
    prior_signals_summary: persisted.prior_signals_summary || null,
    patch_findings: persisted.patch_findings || null,
    tests_to_rerun: persisted.tests_to_rerun || null,
    remaining_stories_in_epic: persisted.remaining_stories_in_epic || 0,
    sprint_is_complete: !!persisted.sprint_is_complete,
    retry_count_this_phase: persisted.retry_count_this_phase || 0,
    verify_reject_count: persisted.verify_reject_count || 0,
    consecutive_test_failures: persisted.consecutive_test_failures || 0,
    escalation_note: persisted.escalation_note || null,
  };
}

// Persist a runtime state (returned by adapt) back to the autopilot-state.yaml.
function persistRuntimeState(runtime, profile, projectRoot) {
  const updates = {
    current_bmad_step: runtime.phase,
    current_story: runtime.story_key,
    story_file_path: runtime.story_file_path,
    current_epic: runtime.current_epic,
    ac_summary: runtime.ac_summary,
    prior_diagnosis: runtime.prior_diagnosis,
    relevant_decisions: runtime.relevant_decisions,
    prior_signals_summary: runtime.prior_signals_summary,
    patch_findings: runtime.patch_findings,
    tests_to_rerun: runtime.tests_to_rerun,
    remaining_stories_in_epic: runtime.remaining_stories_in_epic,
    sprint_is_complete: runtime.sprint_is_complete,
    retry_count_this_phase: runtime.retry_count_this_phase,
    verify_reject_count: runtime.verify_reject_count,
    consecutive_test_failures: runtime.consecutive_test_failures,
  };
  return persistState(updates, profile, projectRoot, runtime.story_key || 'sprint');
}

// ------------------------------------------------------------ side effects

function applySideEffects(sideEffects, runtime, profile, projectRoot) {
  for (const eff of sideEffects || []) {
    switch (eff.kind) {
      case 'append_decisions': {
        const validated = decisionLog.validateMany(eff.decisions);
        if (!validated.ok) {
          log.warn(`decisions validation failed: ${JSON.stringify(validated.errors)}`);
        }
        const valid = validated.ok ? validated.decisions : validated.valid;
        if (valid && valid.length > 0) {
          const logPath = path.join(
            projectRoot,
            '_bmad-output',
            'implementation-artifacts',
            'decision-log.yaml',
          );
          const result = decisionLog.append(logPath, valid, {
            story: runtime.story_key || 'sprint',
          });
          ledger.append(
            {
              kind: 'decisions_appended',
              story: runtime.story_key,
              phase: eff.phase,
              ids: result.ids,
            },
            { projectRoot },
          );
        }
        break;
      }
      case 'apply_user_commands': {
        const validated = userCommands.validate(eff.commands);
        ledger.append(
          {
            kind: 'user_commands_applied',
            phase: eff.phase,
            valid: validated.ok,
            commands: eff.commands,
          },
          { projectRoot },
        );
        // We log the commands; the CLI caller is responsible for actually
        // applying them to the runtime state on the next `next` invocation.
        // (e.g. skip_story would update sprint-status; this CLI doesn't
        // touch sprint-status directly — that's BMad's domain.)
        break;
      }
      case 'profile_escalated':
      case 'log_alternative_proposed':
      case 'log_verify_rejection':
      case 'log_verify_override': {
        const kind =
          eff.kind === 'profile_escalated'
            ? 'profile_escalated'
            : eff.kind === 'log_alternative_proposed'
              ? 'alternative_proposed'
              : eff.kind === 'log_verify_rejection'
                ? 'verify_rejected'
                : 'verify_override';
        ledger.append({ ...eff, kind }, { projectRoot });
        break;
      }
      default:
        // Unknown side-effect kinds are recorded but otherwise ignored.
        ledger.append({ kind: 'state_transition', detail: eff }, { projectRoot });
    }
  }
}

// ------------------------------------------------------------ subcommands

function cmdStart(opts) {
  const projectRoot = resolveProjectRoot(opts);
  const { typed: profile } = resolveProfile(projectRoot, opts.profile);
  const persisted = loadState(projectRoot);

  // Resume detection: if a prior session left a fingerprint, diff.
  const lastHalt = ledger.last({ projectRoot }, 'halt');
  if (lastHalt && lastHalt.fingerprint) {
    const d = divergence.detect({ projectRoot }, lastHalt.fingerprint);
    if (!d.identical) {
      const result = {
        kind: 'resume_divergence',
        differences: d.differences,
        last_phase: persisted.current_bmad_step || null,
      };
      ledger.append({ kind: 'resume', divergence: result }, { projectRoot });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
  }

  // Fresh start or clean resume.
  const runtime =
    Object.keys(persisted).length > 0
      ? composeRuntimeState(persisted)
      : composeRuntimeState({ current_bmad_step: STATES.CREATE_STORY });
  const action = stateMachine.nextAction(runtime, profile);
  ledger.append({ kind: 'action_emitted', phase: runtime.phase, action }, { projectRoot });
  persistRuntimeState(runtime, profile, projectRoot);
  if (profile.coalesce_state_writes) stateStore.flush(profile, { projectRoot, story: runtime.story_key });
  process.stdout.write(`${JSON.stringify({ action, phase: runtime.phase }, null, 2)}\n`);
  return 0;
}

function cmdNext(opts) {
  const projectRoot = resolveProjectRoot(opts);
  const { typed: profile } = resolveProfile(projectRoot, opts.profile);
  const persisted = loadState(projectRoot);
  const runtime = composeRuntimeState(persisted);
  const action = stateMachine.nextAction(runtime, profile);
  ledger.append({ kind: 'action_emitted', phase: runtime.phase, action }, { projectRoot });
  process.stdout.write(`${JSON.stringify({ action, phase: runtime.phase }, null, 2)}\n`);
  return 0;
}

function cmdRecord(opts) {
  const projectRoot = resolveProjectRoot(opts);
  const { typed: profile } = resolveProfile(projectRoot, opts.profile);
  const persisted = loadState(projectRoot);
  const runtime = composeRuntimeState(persisted);

  let signalJson;
  if (opts['signal-file']) {
    signalJson = fs.readFileSync(opts['signal-file'], 'utf8');
  } else if (opts.signal) {
    signalJson = String(opts.signal);
  } else {
    signalJson = fs.readFileSync(0, 'utf8');
  }
  let signal;
  try {
    signal = JSON.parse(signalJson);
  } catch (e) {
    log.error(`invalid signal JSON: ${e.message}`);
    return 2;
  }
  ledger.append(
    { kind: 'signal_recorded', phase: runtime.phase, status: signal.status },
    { projectRoot },
  );

  // Verify only on `success` and `verify_override`.
  let verifyResult;
  if (signal.status === 'success') {
    verifyResult = verifyMod.verify(runtime, signal.output, { projectRoot });
    ledger.append(
      { kind: 'verify_result', phase: runtime.phase, ok: verifyResult.ok, issues: verifyResult.issues || [] },
      { projectRoot },
    );
  } else if (signal.status === 'verify_override') {
    verifyResult = verifyMod.verifyWithOverride(
      runtime,
      signal.output || {},
      { projectRoot },
      signal.evidence || {},
    );
    ledger.append(
      { kind: 'verify_result', phase: runtime.phase, ok: verifyResult.ok, issues: verifyResult.issues || [] },
      { projectRoot },
    );
  }

  const result = adapt.interpretSignal(runtime, signal, profile, verifyResult);
  applySideEffects(result.sideEffects, result.newState, result.newProfile, projectRoot);

  // Persist new runtime state.
  persistRuntimeState(result.newState, result.newProfile, projectRoot);

  // Story-boundary or halt → flush coalesce buffer if enabled.
  const isStoryBoundary =
    result.newState.phase === STATES.STORY_DONE ||
    result.newState.phase === STATES.EPIC_BOUNDARY_CHECK ||
    result.newState.phase === STATES.SPRINT_FINALIZE_PENDING ||
    result.verdict === 'halt';
  if (result.newProfile.coalesce_state_writes && isStoryBoundary) {
    stateStore.flush(result.newProfile, { projectRoot, story: result.newState.story_key });
  }

  // On halt: record fingerprint for resume divergence detection.
  if (result.verdict === 'halt' || (result.nextAction && result.nextAction.type === 'halt')) {
    const fp = divergence.fingerprint({ projectRoot });
    ledger.append(
      { kind: 'halt', phase: result.newState.phase, reason: result.nextAction.reason, fingerprint: fp },
      { projectRoot },
    );
  } else {
    ledger.append(
      { kind: 'state_transition', from: runtime.phase, to: result.newState.phase, verdict: result.verdict },
      { projectRoot },
    );
  }

  const payload = {
    action: result.nextAction,
    verdict: result.verdict,
    phase: result.newState.phase,
    profile: result.newProfile.name,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return 0;
}

function cmdState(opts) {
  const projectRoot = resolveProjectRoot(opts);
  const persisted = loadState(projectRoot);
  process.stdout.write(`${JSON.stringify(persisted, null, 2)}\n`);
  return 0;
}

function cmdReport(opts) {
  const projectRoot = resolveProjectRoot(opts);
  const persisted = loadState(projectRoot);
  const entries = ledger.read({ projectRoot });
  const counts = {};
  for (const e of entries) counts[e.kind] = (counts[e.kind] || 0) + 1;
  const out = [
    '# Autopilot Session Report',
    '',
    `current_story: ${persisted.current_story || '(none)'}`,
    `current_bmad_step: ${persisted.current_bmad_step || '(none)'}`,
    `sprint_is_complete: ${!!persisted.sprint_is_complete}`,
    '',
    '## Ledger summary',
    ...Object.keys(counts)
      .sort()
      .map((k) => `- ${k}: ${counts[k]}`),
  ].join('\n');
  process.stdout.write(`${out}\n`);
  return 0;
}

function cmdValidateConfig(opts) {
  const projectRoot = resolveProjectRoot(opts);
  const { typed, source } = resolveProfile(projectRoot, opts.profile);
  process.stdout.write(`${JSON.stringify({ profile: typed, source }, null, 2)}\n`);
  return 0;
}

function cmdStatus(opts) {
  const projectRoot = resolveProjectRoot(opts);
  const persisted = loadState(projectRoot);
  const story = persisted.current_story || '-';
  const step = persisted.current_bmad_step || '-';
  process.stdout.write(`story=${story} step=${step}\n`);
  return 0;
}

// ------------------------------------------------------------ main

function main(argv) {
  const { opts, positional } = parseArgs(argv, { booleanFlags: ['help'] });
  if (opts.help) {
    help();
    return 0;
  }
  // First positional = subcommand.
  const sub = positional[0];
  if (!sub) {
    help();
    return 1;
  }
  if (!SUBCOMMANDS.includes(sub)) {
    log.error(`unknown subcommand: ${sub}`);
    help();
    return 2;
  }
  try {
    switch (sub) {
      case 'start':
        return cmdStart(opts);
      case 'next':
        return cmdNext(opts);
      case 'record':
        return cmdRecord(opts);
      case 'state':
        return cmdState(opts);
      case 'report':
        return cmdReport(opts);
      case 'validate-config':
        return cmdValidateConfig(opts);
      case 'status':
        return cmdStatus(opts);
      default:
        return 2;
    }
  } catch (e) {
    log.error(`autopilot ${sub}: ${e.message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, SUBCOMMANDS };
