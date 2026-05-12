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
const reportRenderer = require('../lib/orchestrator/report');

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
    // Branch reuse: persisted across resumes once detected on first boot.
    user_branch: persisted.user_branch || null,
    // Land-as-you-go: pending land state survives rebase-conflict halts.
    land_pending: persisted.land_pending || null,
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
    user_branch: runtime.user_branch,
    land_pending: runtime.land_pending,
  };
  return persistState(updates, profile, projectRoot, runtime.story_key || 'sprint');
}

// Detect the current git branch via plain `git rev-parse`. Returns null
// on any error (not a git repo, command missing, etc.). Pure-ish — uses
// execFileSync so callers control timeout/error policy.
function detectCurrentBranch(projectRoot) {
  try {
    const { execFileSync } = require('node:child_process');
    return execFileSync('git', ['-C', projectRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      timeout: 10_000,
    }).trim();
  } catch (_e) {
    return null;
  }
}

// Emit a per-skill timing event into the legacy .timings/<story>.jsonl
// shards. This is what `observedParallelism()` reads in the e2e tests —
// having the orchestrator emit it removes the LLM-driven coupling and
// makes parallelism observable without LLM cooperation.
//
// Fire-and-forget: never halts the autopilot on failure (matches the
// legacy log-timing convention). Honors `autopilot.phase_timings: false`.
//
// log-timing.js validates `--story` against `/^[a-z0-9][a-z0-9-]*$/` so
// BMad-style keys like 'S1' or 'S1.2' must be sanitized first.
function sanitizeStoryForTiming(key) {
  if (typeof key !== 'string') return 'sprint';
  const lowered = key.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  return /^[a-z0-9][a-z0-9-]*$/.test(lowered) ? lowered : 'sprint';
}

function logSkillTiming(projectRoot, event, story, skillName, profile) {
  if (profile && profile.phase_timings === false) return;
  if (!skillName || !story) return;
  const scriptPath = path.join(projectRoot, '_Sprintpilot', 'scripts', 'log-timing.js');
  if (!fs.existsSync(scriptPath)) return;
  const safeStory = sanitizeStoryForTiming(story);
  try {
    const { execFileSync } = require('node:child_process');
    execFileSync(
      'node',
      [
        scriptPath,
        event,
        '--story',
        safeStory,
        '--phase',
        `skill.${skillName}`,
        '--project-root',
        projectRoot,
      ],
      { stdio: 'ignore', timeout: 5_000 },
    );
  } catch (_e) {
    // Advisory only — timing logger is fire-and-forget per the legacy contract.
  }
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

  // Branch reuse: on first boot under reuse_user_branch=true, detect the
  // current git branch and lock it in. The state machine + git-plan then
  // commit every story onto this branch.
  if (profile.reuse_user_branch && !runtime.user_branch) {
    const current = detectCurrentBranch(projectRoot);
    const base = profile.base_branch || 'main';
    if (!current) {
      const halt = {
        type: 'halt',
        reason: 'reuse_user_branch_no_git',
        prompt:
          'reuse_user_branch is on but git is not available / no current branch detected. Initialize a git repo and check out the branch you want autopilot to use.',
      };
      ledger.append({ kind: 'action_emitted', phase: runtime.phase, action: halt }, { projectRoot });
      process.stdout.write(`${JSON.stringify({ action: halt, phase: runtime.phase }, null, 2)}\n`);
      return 0;
    }
    if (current === base) {
      const halt = {
        type: 'user_prompt',
        reason: 'reuse_user_branch_on_base',
        prompt: `reuse_user_branch is on but you're on the base branch (${base}). Create + checkout the branch you want autopilot to commit on, then re-run.`,
      };
      ledger.append({ kind: 'action_emitted', phase: runtime.phase, action: halt }, { projectRoot });
      process.stdout.write(`${JSON.stringify({ action: halt, phase: runtime.phase }, null, 2)}\n`);
      return 0;
    }
    runtime.user_branch = current;
    ledger.append(
      { kind: 'state_transition', detail: { user_branch_detected: current } },
      { projectRoot },
    );
  }

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
  // Skill timing: emit a `skill.<name>` start event when we hand off an
  // invoke_skill action. The matching end event is emitted on `record`
  // when the signal advances the phase. This makes parallelism +
  // duration observable without depending on LLM cooperation.
  if (action.type === 'invoke_skill' && action.skill) {
    logSkillTiming(projectRoot, 'start', runtime.story_key || 'sprint', action.skill, profile);
  }
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

  // Skill timing: emit `skill.<name>` end event when an invoke_skill phase
  // advances to a new phase (success path) OR when it pauses with a
  // non-retry verdict (failure/prompted). Match the legacy log-timing
  // bracket semantics so observedParallelism() sees a complete interval.
  const wasInvokeSkill =
    runtime.phase &&
    ['create_story', 'check_readiness', 'dev_red', 'dev_green', 'code_review',
     'patch_apply', 'patch_retest', 'retrospective', 'nano_quick_dev'].includes(runtime.phase);
  if (wasInvokeSkill && result.verdict !== 'retry') {
    const skillFromAction = (() => {
      const a = stateMachine.nextAction(runtime, profile);
      return a && a.type === 'invoke_skill' ? a.skill : null;
    })();
    if (skillFromAction) {
      logSkillTiming(
        projectRoot,
        'end',
        runtime.story_key || 'sprint',
        skillFromAction,
        result.newProfile,
      );
    }
  }

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
  const { typed: profile } = resolveProfile(projectRoot, opts.profile);
  const persisted = loadState(projectRoot);
  const entries = ledger.read({ projectRoot });
  process.stdout.write(`${reportRenderer.render(persisted, entries, profile)}\n`);
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
