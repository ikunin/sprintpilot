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

const { STATES, nextAction, nextStateAfterSuccess, nextStoryStart, isTestPhase } = require('./state-machine');
const { classifyImpact } = require('./impact-classifier');
const { escalateOnFailure } = require('./profile-rules');
const userCommandApplier = require('./user-command-applier');

// Threshold for `consecutive_test_failures` — workflow.md:81 says 3.
const CONSECUTIVE_TEST_FAILURE_THRESHOLD = 3;

// Threshold for the verify-loop diagnostic: when the SAME verify issues
// repeat this many times in a row, the budget-exhausted halt prompt
// enriches itself with a loop-detection hint (vs. a generic "rejected N
// times" message). 3 matches verify_reject_budget for medium/large/legacy
// profiles, so by the time the budget halts, the diagnostic is guaranteed
// to fire if and only if the rejections were genuinely identical.
const VERIFY_LOOP_THRESHOLD = 3;

// Stable, order-independent signature of a verify issues array.
// We compare via sorted JSON so two arrays with the same strings in
// different order hash to the same signature (the verifier may reorder
// internally across runs). Returns null for empty or non-array input.
function verifyIssuesSignature(issues) {
  if (!Array.isArray(issues) || issues.length === 0) return null;
  // Coerce to strings, trim whitespace, then sort. The trim guards
  // against the verifier accidentally producing trailing whitespace
  // on one run but not another — without it, "branch required" and
  // "branch required " would hash differently and silently break the
  // loop detection. Trim is safe: leading/trailing whitespace in a
  // verify-issue string is never load-bearing.
  const strs = issues
    .map((i) => (typeof i === 'string' ? i : JSON.stringify(i)))
    .map((s) => s.trim())
    .slice()
    .sort();
  return JSON.stringify(strs);
}

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

  // v2.4.0 — flaky-test quarantine signal. The LLM/adapter detects a
  // test that failed then passed on the auto-replay without a code
  // change between runs and surfaces it here as `output.flaky_tests`
  // (string[]). The orchestrator records each occurrence; after
  // N=3 flips of the same test ID across stories, it auto-quarantines
  // and appends an audit entry to decisions[]. See
  // lib/orchestrator/flaky-quarantine.js for the persistence shape.
  if (
    signal.output &&
    Array.isArray(signal.output.flaky_tests) &&
    signal.output.flaky_tests.length > 0
  ) {
    const tests = signal.output.flaky_tests.filter(
      (t) => typeof t === 'string' && t.length > 0,
    );
    if (tests.length > 0) {
      sideEffects.push({
        kind: 'record_flaky_tests',
        phase: state.phase,
        tests,
        story_key: state.story_key || null,
      });
    }
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

    // Loop detection: compare the current issues signature against the
    // last one. Identical sets in a row → the LLM is retrying with the
    // same broken signal. This drives the enriched halt prompt below.
    const currentSig = verifyIssuesSignature(verifyResult.issues || []);
    const lastSig = state.last_verify_issues_signature || null;
    const identicalCount =
      currentSig !== null && currentSig === lastSig
        ? (state.consecutive_identical_rejections || 0) + 1
        : 1;

    sideEffects.push({
      kind: 'log_verify_rejection',
      phase: state.phase,
      issues: verifyResult.issues || [],
      consecutive: rejectCount,
      consecutive_identical: identicalCount,
    });

    const stateWithLoopTrackers = {
      ...state,
      last_verify_issues_signature: currentSig,
      consecutive_identical_rejections: identicalCount,
    };

    if (rejectCount >= profile.verify_reject_budget) {
      // Enriched diagnostic when the same issues recurred. Picks 2 as
      // the threshold for the hint (vs. 3 for a "strong loop") because
      // at budget exhaustion the minimum interesting case is 2 identical
      // rejections in a row; we want the hint to fire whenever the LLM
      // demonstrably wasn't iterating its signal between attempts.
      const issueCount = verifyResult.issues?.length || 0;
      const issuePlural = issueCount === 1 ? 'issue' : 'issues';
      const timePlural = identicalCount === 1 ? 'time' : 'times';
      const loopHint =
        identicalCount >= 2
          ? `\n\n⚠ Verify rejected the SAME ${issueCount} ${issuePlural} ${identicalCount} ${timePlural} in a row — this is a loop, not random noise. ` +
            `The LLM is re-sending an identical broken signal each retry. ` +
            `Action: read each issue text below and fix the underlying cause (e.g., if "git_steps_completed must be true — skipping git push is the most common cause", verify your git_op action actually ran \`git push\` to exit 0); don't just retry the same signal.`
          : '';
      return {
        newState: {
          ...stateWithLoopTrackers,
          verify_reject_count: 0,
          last_verify_issues_signature: null,
          consecutive_identical_rejections: 0,
        },
        newProfile: profile,
        nextAction: {
          type: 'user_prompt',
          phase: state.phase,
          reason: 'verify_reject_budget_exceeded',
          prompt:
            `verify.js rejected ${rejectCount} consecutive success signals on ${state.phase}. ` +
            `Last issues: ${JSON.stringify(verifyResult.issues || [])}${loopHint}`,
          consecutive_identical: identicalCount,
        },
        sideEffects,
        verdict: 'prompted',
      };
    }
    return {
      newState: { ...stateWithLoopTrackers, verify_reject_count: rejectCount },
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

  // v2.4.1 — diagnostic insertion. If the LLM ran a diagnostic
  // (verbose-flag) attempt in response to our previous emission's
  // `diagnostic_mode: true` slot, the signal carries
  // `output.diagnostic_trace`. Stash the trace and escalate to
  // user_prompt with it surfaced as `prior_diagnosis` (richer than the
  // signal's own diagnosis string). The diagnostic does NOT consume a
  // retry slot — it's an observation pass — so we keep retryCount as
  // the pre-diagnostic value when exiting via this path.
  if (state.diagnostic_pending && signal.output && signal.output.diagnostic_trace) {
    const trace = signal.output.diagnostic_trace;
    sideEffects.push({
      kind: 'log_diagnostic_captured',
      phase: state.phase,
      trace_excerpt: typeof trace === 'string' ? trace.slice(0, 200) : null,
    });
    return {
      newState: {
        ...state,
        retry_count_this_phase: 0,
        diagnostic_pending: false,
        diagnostic_completed: true,
        diagnostic_trace: trace,
        prior_diagnosis: trace,
      },
      newProfile: profile,
      nextAction: {
        type: 'user_prompt',
        phase: state.phase,
        reason: 'retry_budget_exhausted_with_diagnostic',
        prompt:
          signal.reason ||
          'Tests still failing after the diagnostic verbose re-run; manual review required. ' +
            'The captured trace is attached as `diagnosis` for the next session.',
        diagnosis: trace,
        diagnostic_trace_attached: true,
      },
      sideEffects,
      verdict: 'prompted',
    };
  }

  if (!recoverable || exhausted) {
    // v2.4.1 — between failure 2 and 3, insert a diagnostic verbose-run
    // pass for test phases. The orchestrator emits the same phase
    // again with `diagnostic_mode: true` so the adapter switches to
    // verbose flags; the LLM runs the verbose command, reports the
    // trace via `output.diagnostic_trace`, and that trace becomes the
    // `prior_diagnosis` for the user_prompt. One-shot per phase entry —
    // `diagnostic_completed` blocks repeat insertions.
    //
    // Only fires on `exhausted` (retry budget hit); non-recoverable
    // failures bypass diagnostic — by definition another attempt
    // would be pointless. The LLM's signal says "don't retry this."
    if (
      exhausted &&
      recoverable &&
      isTestPhase(state.phase) &&
      !state.diagnostic_pending &&
      !state.diagnostic_completed
    ) {
      const newState = {
        ...state,
        // Don't increment the retry counter — diagnostic is an inserted
        // observation pass, not a fix attempt.
        retry_count_this_phase: state.retry_count_this_phase || 0,
        diagnostic_pending: true,
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
  // v2.4.0 — phase_started_at stamps the wall-clock entry into newPhase
  // so state-machine.checkPhaseTimeout can detect hangs. Tests inject
  // `signal._now` (ISO string) for deterministic timing assertions; live
  // sessions use the wall clock. Only refreshed when the phase actually
  // changes — staying in the same phase across a retry keeps the
  // original timestamp so the budget tracks total time, not per-attempt.
  const nowIso =
    (signal && signal._now) || (state && state._now) || new Date().toISOString();
  const next = {
    ...state,
    phase: newPhase,
    retry_count_this_phase: 0,
    verify_reject_count: 0,
    phase_started_at: newPhase !== state.phase ? nowIso : state.phase_started_at || nowIso,
    // v2.3.0 — phase transition clears verify-loop trackers so the next
    // phase starts fresh. Without this a stale signature from the prior
    // phase could artificially inflate identicalCount on the next reject.
    last_verify_issues_signature: null,
    consecutive_identical_rejections: 0,
    // v2.4.1 — diagnostic state is per-phase-entry. Each new phase
    // gets one diagnostic chance; success or escalation clears it.
    diagnostic_pending: false,
    diagnostic_completed: false,
    diagnostic_trace: null,
  };
  // Advancing forward clears the prior diagnosis (the LLM resolved it).
  next.prior_diagnosis = null;

  // Starting a new story resets story-scoped fields. The orchestrator's CLI
  // edge will fill in story_key / story_file_path / current_epic from
  // sprint-status when entering CREATE_STORY or NANO_QUICK_DEV.
  if (newPhase === STATES.CREATE_STORY || newPhase === STATES.NANO_QUICK_DEV) {
    next.consecutive_test_failures = 0;
    next.patch_findings = null;
    next.tests_to_rerun = null;
    // test_scope_hint is story-scoped — clear it at every new-story boundary
    // so a "widen to full" hint from story N doesn't bleed into story N+1.
    next.test_scope_hint = null;
    next.test_files = null;
  }

  // test_scope_hint propagation. dev-story / nano-quick-dev signals may
  // carry `test_scope_hint: { scope: 'full' } | { include_dirs: [...] }`
  // when the LLM realizes the change is structural (refactor of a shared
  // util, dep bump, schema migration). The hint widens the test scope
  // for the NEXT phase in the same story; decorateTestScope reads it
  // from state at action-emission time. We accept the hint on every
  // signal — last writer wins per story. Validated lightly: anything
  // that isn't an object with the expected shape is ignored.
  if (signal && signal.output && signal.output.test_scope_hint) {
    const h = signal.output.test_scope_hint;
    if (h && typeof h === 'object' && !Array.isArray(h)) {
      const cleaned = {};
      if (h.scope === 'full' || h.scope === 'affected') cleaned.scope = h.scope;
      if (Array.isArray(h.include_dirs)) {
        cleaned.include_dirs = h.include_dirs.filter(
          (d) => typeof d === 'string' && d.length > 0,
        );
      }
      if (Object.keys(cleaned).length > 0) next.test_scope_hint = cleaned;
    }
  }

  // test_files propagation. dev-story / quick-dev signals declare the
  // story-authored test files; the scope resolver pins them so they
  // always run (even if affected-detection wouldn't have picked them
  // up). Carry the latest set across phases within a story.
  if (signal && signal.output && Array.isArray(signal.output.test_files)) {
    next.test_files = signal.output.test_files.filter(
      (f) => typeof f === 'string' && f.length > 0,
    );
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
    // test_scope_hint is story-scoped; clear at the story boundary.
    next.test_scope_hint = null;
    next.test_files = null;
  }

  // session_story_limit: increment the per-session completion counter when a
  // story COMPLETES, i.e. when we enter EPIC_BOUNDARY_CHECK. Two flows reach
  // it and BOTH count as one completed story:
  //   stacked:        STORY_DONE → EPIC_BOUNDARY_CHECK
  //   land_as_you_go: STORY_DONE → STORY_LAND → EPIC_BOUNDARY_CHECK
  // This was previously folded into the STORY_DONE→EPIC_BOUNDARY block above,
  // so under land_as_you_go (STORY_LAND interposed) it never fired — the
  // counter stayed 0 and state-machine.js#nextAction never emitted the
  // session_story_limit halt. Gating on "entering EPIC_BOUNDARY_CHECK from a
  // story-completion phase" covers both flows exactly once. The counter
  // resets on cmdStart (new session boundary).
  if (
    newPhase === STATES.EPIC_BOUNDARY_CHECK &&
    (state.phase === STATES.STORY_DONE || state.phase === STATES.STORY_LAND)
  ) {
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
  VERIFY_LOOP_THRESHOLD,
  SIGNAL_STATUSES,
  verifyIssuesSignature,
};
