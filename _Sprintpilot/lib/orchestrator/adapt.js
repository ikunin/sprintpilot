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
      return {
        newState: state,
        newProfile: profile,
        nextAction: {
          type: 'run_script',
          phase: state.phase,
          reason: 'install_missing_dependency',
          command: ['npm', 'install'],
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

  return {
    newState: state,
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
  // Adapt does not validate commands (that's user-commands.js' job at the CLI
  // edge) but it does decide the structural response: a user_input signal
  // always triggers a re-emission of nextAction under the new state. The
  // CLI edge applies the commands first, then calls adapt with the new state.
  sideEffects.push({
    kind: 'apply_user_commands',
    commands: signal.commands || [],
    phase: state.phase,
  });
  return {
    newState: state,
    newProfile: profile,
    nextAction: nextAction(state, profile),
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
