// adapt.js — pure adaptation function.
//   (state, signal, profile, world) → { newState, nextAction, sideEffects }
//
// Translates a Signal from the LLM into the orchestrator's next state plus
// any side effects (decision-log appends, profile escalations, blocker
// counting, retry-budget bookkeeping).
//
// Pure module. No I/O. Side effects are returned as data; the CLI edge
// performs them.

'use strict';

const { STATES, nextAction, nextStateAfterSuccess, nextStoryStart } = require('./state-machine');
const { classifyImpact } = require('./impact-classifier');
const { escalateOnFailure } = require('./profile-rules');
const userCommandApplier = require('./user-command-applier');

// Threshold for `consecutive_test_failures` — workflow.md:81 says 3.
const CONSECUTIVE_TEST_FAILURE_THRESHOLD = 3;

// Valid signal statuses.
const SIGNAL_STATUSES = [
  'success',
  'failure',
  'blocked',
  'propose_alternative',
  'user_input',
  'verify_override',
];

// Pure: given current orchestrator state + the incoming signal, return:
//   {
//     newState,     // updated runtime state shape
//     newProfile,   // possibly escalated profile (same reference if unchanged)
//     nextAction,   // canonical action for the new state, or a user_prompt / halt
//     sideEffects,  // ordered list of effects: { kind: 'append_decisions' | ... }
//     verdict,      // one of: 'advanced' | 'retry' | 'prompted' | 'halt'
//   }
function interpretSignal(state, signal, profile, verifyResult) {
  if (!signal || !signal.status) {
    throw new Error('interpretSignal: signal.status required');
  }
  if (!SIGNAL_STATUSES.includes(signal.status)) {
    throw new Error(`interpretSignal: unknown signal status ${signal.status}`);
  }

  const sideEffects = [];

  // Decision-log append always runs first (across every signal status).
  if (Array.isArray(signal.decisions) && signal.decisions.length > 0) {
    sideEffects.push({ kind: 'append_decisions', decisions: signal.decisions, phase: state.phase });
  }

  switch (signal.status) {
    case 'success':
      return handleSuccess(state, signal, profile, verifyResult, sideEffects);
    case 'failure':
      return handleFailure(state, signal, profile, sideEffects);
    case 'blocked':
      return handleBlocked(state, signal, profile, sideEffects);
    case 'propose_alternative':
      return handleProposeAlternative(state, signal, profile, sideEffects);
    case 'user_input':
      return handleUserInput(state, signal, profile, sideEffects);
    case 'verify_override':
      return handleVerifyOverride(state, signal, profile, verifyResult, sideEffects);
    default:
      throw new Error(`interpretSignal: unhandled status ${signal.status}`);
  }
}

function handleSuccess(state, signal, profile, verifyResult, sideEffects) {
  // Trust boundary: verify.js may reject what the LLM claims as success.
  if (verifyResult && verifyResult.ok === false) {
    const rejectCount = (state.verify_reject_count || 0) + 1;
    sideEffects.push({
      kind: 'log_verify_rejection',
      phase: state.phase,
      issues: verifyResult.issues || [],
      consecutive: rejectCount,
    });
    if (rejectCount >= profile.verify_reject_budget) {
      return {
        newState: { ...state, verify_reject_count: 0 },
        newProfile: profile,
        nextAction: {
          type: 'user_prompt',
          phase: state.phase,
          reason: 'verify_reject_budget_exceeded',
          prompt: `verify.js rejected ${rejectCount} consecutive success signals on ${state.phase}. Last issues: ${JSON.stringify(verifyResult.issues || [])}`,
        },
        sideEffects,
        verdict: 'prompted',
      };
    }
    return {
      newState: { ...state, verify_reject_count: rejectCount },
      newProfile: profile,
      // Retry the same phase. adapt's caller will re-run nextAction(state, profile).
      nextAction: nextAction(state, profile),
      sideEffects,
      verdict: 'retry',
    };
  }

  // Verify passed (or wasn't provided). For nano: check escalation triggers.
  let workingProfile = profile;
  if (state.phase === STATES.NANO_QUICK_DEV) {
    const escalated = escalateOnFailure(profile, signal.output);
    if (escalated !== profile) {
      workingProfile = escalated;
      sideEffects.push({
        kind: 'profile_escalated',
        from: 'nano',
        to: escalated.name,
        reason: escalated.escalation_reason,
      });
    }
  }

  // Code-review with `block` findings is a structural success (review ran)
  // but routes to user_prompt — the LLM can't decide blocking unilaterally.
  if (state.phase === STATES.CODE_REVIEW) {
    const findings = (signal.output && signal.output.findings) || [];
    const blockingFindings = findings.filter((f) => f && f.action === 'block');
    if (blockingFindings.length > 0) {
      return {
        newState: { ...state, verify_reject_count: 0 },
        newProfile: workingProfile,
        nextAction: {
          type: 'user_prompt',
          phase: state.phase,
          reason: 'code_review_blocking_findings',
          prompt: `Code review identified ${blockingFindings.length} blocking finding(s). Manual decision required: ${JSON.stringify(blockingFindings.map((f) => ({ id: f.id, rationale: f.rationale })))}`,
          findings: blockingFindings,
        },
        sideEffects,
        verdict: 'prompted',
      };
    }
  }

  const newPhase = nextStateAfterSuccess(state, workingProfile, signal);
  if (newPhase === null) {
    // Defensive: shouldn't normally happen since blocking-findings case is handled.
    return {
      newState: { ...state, verify_reject_count: 0 },
      newProfile: workingProfile,
      nextAction: {
        type: 'user_prompt',
        phase: state.phase,
        reason: 'no_deterministic_successor',
        prompt: 'State machine has no deterministic successor for this transition.',
      },
      sideEffects,
      verdict: 'prompted',
    };
  }

  // Build the new state: carry forward story-scoped fields; reset retry counters.
  const newState = advanceState(state, workingProfile, newPhase, signal);
  return {
    newState,
    newProfile: workingProfile,
    nextAction: nextAction(newState, workingProfile),
    sideEffects,
    verdict: newPhase === STATES.SPRINT_FINALIZE_PENDING ? 'halt' : 'advanced',
  };
}

function handleFailure(state, signal, profile, sideEffects) {
  const recoverable = signal.recoverable !== false;
  const retryCount = (state.retry_count_this_phase || 0) + 1;
  const exhausted = retryCount > profile.retry_budget_per_action;

  // failure.diagnosis is first-class: persisted into state so the next retry's
  // template gets it via `{{prior_diagnosis}}`.
  const carriedDiagnosis = signal.diagnosis || null;

  if (!recoverable || exhausted) {
    return {
      newState: {
        ...state,
        retry_count_this_phase: 0,
        prior_diagnosis: carriedDiagnosis,
      },
      newProfile: profile,
      nextAction: {
        type: 'user_prompt',
        phase: state.phase,
        reason: exhausted ? 'retry_budget_exhausted' : 'failure_not_recoverable',
        prompt: signal.reason || 'Action failed; human intervention required.',
        diagnosis: carriedDiagnosis,
      },
      sideEffects,
      verdict: 'prompted',
    };
  }

  // Recoverable + budget remaining: re-emit the same phase's action with the
  // prior diagnosis threaded into the template slots.
  const newState = {
    ...state,
    retry_count_this_phase: retryCount,
    prior_diagnosis: carriedDiagnosis,
  };
  return {
    newState,
    newProfile: profile,
    nextAction: nextAction(newState, profile),
    sideEffects,
    verdict: 'retry',
  };
}

function handleBlocked(state, signal, profile, sideEffects) {
  const kind = signal.blocker_kind || 'unknown';

  // Counting blocker: workflow.md:81 says 3 consecutive failures pauses.
  if (kind === 'consecutive_test_failures') {
    const ledgerCount =
      typeof signal.consecutive_count === 'number'
        ? signal.consecutive_count
        : (state.consecutive_test_failures || 0) + 1;
    // Trust but verify — orchestrator tracks independently to detect under-reporting.
    const tracked = Math.max(ledgerCount, (state.consecutive_test_failures || 0) + 1);
    if (tracked >= CONSECUTIVE_TEST_FAILURE_THRESHOLD) {
      return {
        newState: { ...state, consecutive_test_failures: 0 },
        newProfile: profile,
        nextAction: {
          type: 'user_prompt',
          phase: state.phase,
          reason: 'consecutive_test_failures_threshold',
          prompt: `${tracked} consecutive test failures on ${state.phase}. Manual review required.`,
          details: signal.details,
        },
        sideEffects,
        verdict: 'prompted',
      };
    }
    return {
      newState: { ...state, consecutive_test_failures: tracked },
      newProfile: profile,
      nextAction: nextAction(state, profile),
      sideEffects,
      verdict: 'retry',
    };
  }

  // Other TRUE BLOCKER kinds → always user_prompt regardless of `user_input_needed`.
  const TRUE_BLOCKER_KINDS = new Set([
    'creative_user_input_required',
    'new_external_dependency',
    'security_architectural_decision',
    'contradictory_acceptance_criteria',
  ]);
  if (TRUE_BLOCKER_KINDS.has(kind) || signal.user_input_needed === true) {
    return {
      newState: state,
      newProfile: profile,
      nextAction: {
        type: 'user_prompt',
        phase: state.phase,
        reason: kind,
        prompt: signal.details || `Blocked: ${kind}`,
      },
      sideEffects,
      verdict: 'prompted',
    };
  }

  // Recoverable blockers: deterministic recovery per kind (initial set).
  switch (kind) {
    case 'missing_dependency':
      // Emit an abstract install action. The CLI edge (autopilot.js
      // decorateRunScript) detects the project's language(s) from
      // manifest files (package.json, pyproject.toml, Cargo.toml, etc.)
      // and inlines the concrete `command` per language.
      return {
        newState: state,
        newProfile: profile,
        nextAction: {
          type: 'run_script',
          phase: state.phase,
          reason: 'install_missing_dependency',
          op: 'install_dependencies',
          details: signal.details || null,
        },
        sideEffects,
        verdict: 'retry',
      };
    case 'external_service':
      // Defer: retry once, then prompt. We use retry_count_this_phase as the budget.
      return handleFailure(state, { reason: signal.details, recoverable: true }, profile, sideEffects);
    case 'failed_invariant':
    case 'unknown':
    default:
      return {
        newState: state,
        newProfile: profile,
        nextAction: {
          type: 'user_prompt',
          phase: state.phase,
          reason: `blocked_${kind}`,
          prompt: signal.details || `Blocked: ${kind}`,
        },
        sideEffects,
        verdict: 'prompted',
      };
  }
}

function handleProposeAlternative(state, signal, profile, sideEffects) {
  const planned = nextAction(state, profile);
  const alternative = signal.alternative;
  const impact = classifyImpact(planned, alternative, signal.urgency_hint);

  sideEffects.push({
    kind: 'log_alternative_proposed',
    phase: state.phase,
    impact,
    reason: signal.reason,
  });

  if (impact === 'low') {
    // Auto-accept. The CLI edge swaps the planned action for the alternative.
    return {
      newState: state,
      newProfile: profile,
      nextAction: { ...alternative, _accepted_alternative: true, _impact: impact },
      sideEffects,
      verdict: 'advanced',
    };
  }

  // Store the proposed alternative on state so a later `accept_alternative`
  // user command can dispatch it. Without this, the alternative would
  // evaporate the moment the prompt is emitted.
  const newState = {
    ...state,
    pending_alternative: {
      action: alternative,
      impact,
      reason: signal.reason || null,
      prompted_at: new Date().toISOString(),
    },
  };
  return {
    newState,
    newProfile: profile,
    nextAction: {
      type: 'user_prompt',
      phase: state.phase,
      reason: 'alternative_requires_approval',
      prompt: signal.reason || 'LLM proposed an alternative action.',
      planned,
      alternative,
      impact,
    },
    sideEffects,
    verdict: 'prompted',
  };
}

function handleUserInput(state, signal, profile, sideEffects) {
  // Apply the user's commands directly so the resulting state changes
  // (halt_requested, cleared pending_alternative, dispatch_action effect)
  // take effect on this same turn. Prior versions only emitted an
  // apply_user_commands side-effect and the CLI never re-dispatched —
  // pause never halted, accept_alternative had nowhere to land.
  const commands = signal.commands || [];
  const applied = userCommandApplier.apply(state, profile, commands);

  // Mirror the legacy apply_user_commands side-effect so the ledger trail
  // stays human-readable (kind: user_commands_applied).
  sideEffects.push({
    kind: 'apply_user_commands',
    commands,
    phase: state.phase,
  });
  for (const e of applied.sideEffects) sideEffects.push(e);

  const newState = applied.newState;
  const newProfile = applied.newProfile;

  // Halt requested? Emit a halt action and let cmdRecord write the
  // resume fingerprint.
  if (newState.halt_requested) {
    return {
      newState,
      newProfile,
      nextAction: {
        type: 'halt',
        phase: newState.phase,
        reason: newState.halt_requested.reason || 'user_pause',
      },
      sideEffects,
      verdict: 'halt',
    };
  }

  // One-shot dispatch (e.g. accept_alternative resolved a pending alt)?
  // Return the dispatched action in place of the state-machine's default.
  //
  // Sync story metadata onto newState. The dispatched action carries
  // story_key / current_epic / story_file_path / ac_summary in its
  // `template_slots` (and sometimes as top-level fields on git_ops).
  // Without propagating these, accept_alternative dispatches work on
  // a specific story but autopilot-state.yaml still shows
  // `current_story: null` — subsequent emissions / persists / verify
  // checks all reference the wrong story.
  //
  // Phase advance: when the alternative carries `phase` and it's a
  // valid STATES value, also advance state.phase. The user explicitly
  // proposes the alternative including a target phase; they accept the
  // consequences (e.g. verify may reject the new phase if its
  // preconditions aren't met). This enables cycle skips like "jump to
  // STORY_DONE because the work is already on the branch from a prior
  // session."
  const dispatch = applied.sideEffects.find((e) => e && e.kind === 'dispatch_action');
  if (dispatch && dispatch.action) {
    const a = dispatch.action;
    const slots = a.template_slots || {};
    const KNOWN_PHASES = new Set(Object.values(STATES));
    const phaseAdvance =
      typeof a.phase === 'string' && KNOWN_PHASES.has(a.phase) && a.phase !== newState.phase
        ? a.phase
        : null;
    const enrichedState = {
      ...newState,
      phase: phaseAdvance || newState.phase,
      story_key: newState.story_key || slots.story_key || a.story_key || null,
      current_epic:
        newState.current_epic || slots.current_epic || a.epic_key || null,
      story_file_path:
        newState.story_file_path || slots.story_file_path || null,
      ac_summary: newState.ac_summary || slots.ac_summary || null,
      // Reset retry counters on phase advance so the new phase isn't
      // immediately throttled by a stale retry budget from the phase
      // we just skipped.
      retry_count_this_phase: phaseAdvance ? 0 : newState.retry_count_this_phase,
      verify_reject_count: phaseAdvance ? 0 : newState.verify_reject_count,
    };
    return {
      newState: enrichedState,
      newProfile,
      nextAction: { ...a, _dispatched_via: dispatch.reason || 'user_input' },
      sideEffects,
      verdict: 'advanced',
    };
  }

  return {
    newState,
    newProfile,
    nextAction: nextAction(newState, newProfile),
    sideEffects,
    verdict: 'advanced',
  };
}

function handleVerifyOverride(state, signal, profile, verifyResult, sideEffects) {
  // The LLM contends verify.js' expectations are stale. The CLI edge will
  // re-run verify with the augmented expectations from signal.evidence; the
  // adapt layer just records the override attempt and decides what to do
  // based on the augmented verifyResult passed in.
  sideEffects.push({
    kind: 'log_verify_override',
    phase: state.phase,
    evidence: signal.evidence || null,
    accepted: verifyResult && verifyResult.ok === true,
  });

  if (verifyResult && verifyResult.ok === true) {
    // Override accepted — treat as success. Synthesize a minimal success signal.
    return handleSuccess(state, { status: 'success', output: signal.evidence }, profile, verifyResult, sideEffects);
  }

  // Override rejected — fall back to failure(recoverable=true).
  return handleFailure(
    state,
    {
      status: 'failure',
      reason: 'verify_override_rejected',
      diagnosis: 'augmented verify.js still failed',
      recoverable: true,
    },
    profile,
    sideEffects,
  );
}

// advanceState — produce the new runtime state when moving to `newPhase`.
// Resets phase-scoped counters; clears prior_diagnosis when advancing forward;
// clears patch_findings when leaving step 6; resets per-story counters when
// starting a new story.
function advanceState(state, profile, newPhase, signal) {
  const next = { ...state, phase: newPhase, retry_count_this_phase: 0, verify_reject_count: 0 };
  // Advancing forward clears the prior diagnosis (the LLM resolved it).
  next.prior_diagnosis = null;

  // Starting a new story resets story-scoped fields. The orchestrator's CLI
  // edge will fill in story_key / story_file_path / current_epic from
  // sprint-status when entering CREATE_STORY or NANO_QUICK_DEV.
  if (newPhase === STATES.CREATE_STORY || newPhase === STATES.NANO_QUICK_DEV) {
    next.consecutive_test_failures = 0;
    next.patch_findings = null;
    next.tests_to_rerun = null;
  }

  // Leaving step 6 (PATCH_RETEST → STORY_DONE / CODE_REVIEW) clears patch state.
  if (state.phase === STATES.PATCH_RETEST) {
    next.patch_findings = null;
    next.tests_to_rerun = null;
  }

  // Entering step 6a — carry the findings from the success.output forward.
  if (newPhase === STATES.PATCH_APPLY && signal && signal.output) {
    const findings = (signal.output.findings || []).filter((f) => f && f.action === 'patch');
    next.patch_findings = findings;
  }
  if (newPhase === STATES.PATCH_RETEST && signal && signal.output && signal.output.tests_to_rerun) {
    next.tests_to_rerun = signal.output.tests_to_rerun;
  }

  // Nano + quick-dev is one-shot per BMad's step-oneshot.md: a single
  // intent → single spec → single commit. No iteration over stories or
  // epics. Mark the sprint complete after the first successful NANO_QUICK_DEV
  // so EPIC_BOUNDARY_CHECK routes to SPRINT_FINALIZE_PENDING (halt) instead
  // of looping back to NANO_QUICK_DEV. The LLM can override by passing
  // `output.sprint_is_complete: false` if they have additional stories to
  // run (e.g. a sprint-status.yaml with multiple pending stories was
  // pre-seeded).
  if (
    state.phase === STATES.NANO_QUICK_DEV &&
    profile.implementation_flow === 'quick' &&
    !next.sprint_is_complete
  ) {
    const explicitOverride = signal && signal.output && signal.output.sprint_is_complete === false;
    if (!explicitOverride) {
      next.sprint_is_complete = true;
    }
  }

  // Propagate story identity from the signal so the next git_op (STORY_DONE)
  // can compute the correct branch name. Without this, state.story_key
  // stays null after bmad-quick-dev / bmad-create-story / bmad-dev-story
  // and git-plan.js falls back to `story/unknown` — breaking epic
  // granularity entirely (branchName needs current_epic to emit
  // `<prefix>epic-<id>`). The signal output is the authoritative source
  // for the story the LLM just worked on, so it wins over any prior
  // value in state.
  if (signal && signal.output) {
    if (signal.output.story_key) {
      next.story_key = signal.output.story_key;
    }
    if (signal.output.story_file_path) {
      next.story_file_path = signal.output.story_file_path;
    }
    // Derive epic_key from story_key if the signal didn't supply it
    // explicitly. Convention: story_key first segment is the epic
    // identifier (e.g. `1-1-game-engine` → `1`, `epic-1-game-engine` →
    // `epic-1`). If the format doesn't match, we leave current_epic
    // null and branchName falls back to story-granularity (graceful
    // degradation).
    if (signal.output.epic_key) {
      next.current_epic = signal.output.epic_key;
    } else if (next.story_key) {
      const derived = deriveEpicKey(next.story_key);
      if (derived) next.current_epic = derived;
    }
  }

  // Story-completion boundary: STORY_DONE → EPIC_BOUNDARY_CHECK means
  // the current story is committed and pushed. Pop the explicit story
  // queue (if any) — its head was THIS story — and clear story_key /
  // story_file_path / ac_summary so composeRuntimeState picks
  // queue[1] (now queue[0]) on the next emission. Without this pop,
  // composeRuntimeState would re-pick the just-completed story (via the
  // signal-output propagation above) and loop. This block runs AFTER
  // propagation so the clearing wins.
  //
  // current_epic is intentionally NOT cleared here. EPIC_BOUNDARY_CHECK
  // and (downstream) RETROSPECTIVE both need it: state-machine reads
  // current_epic to compute remaining_stories_in_epic, and
  // verifyRetrospective uses it to locate `_bmad-output/retrospectives/
  // <epic>.md`. composeRuntimeState re-derives current_epic from the
  // new story_key when the queue head changes epics on next-story-start
  // (CREATE_STORY / PREPARE_STORY_BRANCH / NANO_QUICK_DEV).
  if (state.phase === STATES.STORY_DONE && newPhase === STATES.EPIC_BOUNDARY_CHECK) {
    if (Array.isArray(state.story_queue) && state.story_queue.length > 0) {
      next.story_queue = state.story_queue.slice(1);
    }
    next.story_key = null;
    next.story_file_path = null;
    next.ac_summary = null;
    // session_story_limit: increment per-session completion counter so
    // state-machine.js#nextAction can emit the halt at the next
    // emission. The counter resets on cmdStart (new session boundary).
    next.session_stories_completed = (state.session_stories_completed || 0) + 1;
  }

  return next;
}

// Convention: story keys begin with the epic identifier followed by `-`.
// Examples: `1-1-game-engine` → `1`, `2-3-add-auth` → `2`. A leading
// `epic-N-...` form returns `epic-N` so the orchestrator can address
// either flavor. Returns null when the key doesn't parse cleanly.
function deriveEpicKey(storyKey) {
  if (typeof storyKey !== 'string' || !storyKey) return null;
  // `epic-1-...` → `epic-1`
  const epicPrefixed = storyKey.match(/^(epic-[A-Za-z0-9_]+)-/);
  if (epicPrefixed) return epicPrefixed[1];
  // `<epic>-<story>-<slug>` → `<epic>` (first hyphen-separated segment)
  const firstSeg = storyKey.match(/^([A-Za-z0-9_]+)-/);
  if (firstSeg) return firstSeg[1];
  return null;
}

module.exports = {
  interpretSignal,
  advanceState,
  CONSECUTIVE_TEST_FAILURE_THRESHOLD,
  SIGNAL_STATUSES,
};
