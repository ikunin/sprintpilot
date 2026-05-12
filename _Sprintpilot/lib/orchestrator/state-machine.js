// state-machine.js — BMad 7-step state machine (pure, table-driven).
//
// States (story-scoped, in order):
//   1. create_story
//   2. check_readiness
//   3. dev_red
//   4. dev_green
//   5. code_review
//   6a. patch_apply       (entered only if review has any 'patch' finding)
//   6b. patch_retest      (entered after 6a)
//   7. story_done
//   8. epic_boundary_check
//   9. retrospective      (per-epic; only when retrospective_mode != 'skip')
//   10. sprint_finalize_pending
//
// Nano profile collapses 1–6 into a single `nano_quick_dev` state that
// emits `invoke_skill: bmad-quick-dev`.
//
// Pure. nextAction(state, profile, world) → Action object.
//
// `state` is the orchestrator's runtime state shape:
//   {
//     phase,                  // one of STATES below
//     story_key,              // current story
//     story_file_path,        // resolved path for story file
//     current_epic,           // epic key for current story
//     ac_summary,             // compact AC summary
//     prior_diagnosis,        // last failure diagnosis (or null)
//     relevant_decisions,     // decision-log entries scoped to this story
//     prior_signals_summary,
//     patch_findings,         // structured findings[] from review (when in step 6)
//     tests_to_rerun,
//     remaining_stories_in_epic, // count
//     remaining_epics,           // count
//     sprint_is_complete,
//     escalation_note,        // when nano escalated, populated for template
//   }
//
// `profile` is the typed Profile from profile-rules.js.

'use strict';

const STATES = Object.freeze({
  CREATE_STORY: 'create_story',
  CHECK_READINESS: 'check_readiness',
  DEV_RED: 'dev_red',
  DEV_GREEN: 'dev_green',
  CODE_REVIEW: 'code_review',
  PATCH_APPLY: 'patch_apply',
  PATCH_RETEST: 'patch_retest',
  STORY_DONE: 'story_done',
  EPIC_BOUNDARY_CHECK: 'epic_boundary_check',
  RETROSPECTIVE: 'retrospective',
  SPRINT_FINALIZE_PENDING: 'sprint_finalize_pending',
  // Nano-only collapsed state.
  NANO_QUICK_DEV: 'nano_quick_dev',
});

const TERMINAL_STATES = new Set([STATES.SPRINT_FINALIZE_PENDING]);

// Successor table for the FULL flow. Used to enumerate "structurally valid
// successors" when a next_skill_hint disambiguation is needed. Conditional
// edges (e.g. patch_apply only when findings.action==='patch') are
// enforced in `nextStateAfterSuccess`.
const FULL_FLOW_SUCCESSORS = {
  [STATES.CREATE_STORY]: [STATES.CHECK_READINESS],
  [STATES.CHECK_READINESS]: [STATES.DEV_RED],
  [STATES.DEV_RED]: [STATES.DEV_GREEN],
  [STATES.DEV_GREEN]: [STATES.CODE_REVIEW],
  [STATES.CODE_REVIEW]: [STATES.PATCH_APPLY, STATES.STORY_DONE], // conditional
  [STATES.PATCH_APPLY]: [STATES.PATCH_RETEST],
  [STATES.PATCH_RETEST]: [STATES.CODE_REVIEW, STATES.STORY_DONE], // conditional (re-review if still blocking)
  [STATES.STORY_DONE]: [STATES.EPIC_BOUNDARY_CHECK],
  [STATES.EPIC_BOUNDARY_CHECK]: [STATES.RETROSPECTIVE, STATES.CREATE_STORY, STATES.SPRINT_FINALIZE_PENDING],
  [STATES.RETROSPECTIVE]: [STATES.CREATE_STORY, STATES.SPRINT_FINALIZE_PENDING],
};

const NANO_FLOW_SUCCESSORS = {
  [STATES.NANO_QUICK_DEV]: [STATES.STORY_DONE],
  [STATES.STORY_DONE]: [STATES.EPIC_BOUNDARY_CHECK],
  [STATES.EPIC_BOUNDARY_CHECK]: [STATES.RETROSPECTIVE, STATES.NANO_QUICK_DEV, STATES.SPRINT_FINALIZE_PENDING],
  [STATES.RETROSPECTIVE]: [STATES.NANO_QUICK_DEV, STATES.SPRINT_FINALIZE_PENDING],
};

// Build instruction template content slots from state + profile. This is the
// LLM-intelligence preservation channel: every skill invocation gets a rich
// context bundle, not a free-form prose blob.
function buildTemplateSlots(state, profile, extra = {}) {
  return {
    story_key: state.story_key || null,
    story_file_path: state.story_file_path || null,
    ac_summary: state.ac_summary || null,
    prior_diagnosis: state.prior_diagnosis || null,
    relevant_decisions: state.relevant_decisions || [],
    prior_signals_summary: state.prior_signals_summary || null,
    patch_findings: state.patch_findings || null,
    tests_to_rerun: state.tests_to_rerun || null,
    profile_name: profile.name,
    profile_specific_notes: state.escalation_note || profileNotes(profile),
    ...extra,
  };
}

function profileNotes(profile) {
  if (profile.name === 'nano') {
    return 'nano: bmad-quick-dev one-shot; escalate to full flow on test fail or high severity.';
  }
  return null;
}

// nextAction(state, profile) → Action
//   Returns the canonical action for the current `state.phase`.
function nextAction(state, profile) {
  if (!state || !state.phase) {
    throw new Error('nextAction: state.phase required');
  }
  if (state.sprint_is_complete && state.phase !== STATES.SPRINT_FINALIZE_PENDING) {
    return {
      type: 'halt',
      reason: 'sprint_complete',
      handoff: 'sprint_finalize_pending',
    };
  }

  switch (state.phase) {
    case STATES.CREATE_STORY:
      return {
        type: 'invoke_skill',
        skill: 'bmad-create-story',
        phase: state.phase,
        template: 'bmad-create-story.tmpl.md',
        template_slots: buildTemplateSlots(state, profile),
      };
    case STATES.CHECK_READINESS:
      return {
        type: 'invoke_skill',
        skill: 'bmad-check-implementation-readiness',
        phase: state.phase,
        template: 'bmad-check-implementation-readiness.tmpl.md',
        template_slots: buildTemplateSlots(state, profile),
      };
    case STATES.DEV_RED:
      return {
        type: 'invoke_skill',
        skill: 'bmad-dev-story',
        phase: state.phase,
        template: 'bmad-dev-story.red.tmpl.md',
        template_slots: buildTemplateSlots(state, profile, { tdd_phase: 'red' }),
      };
    case STATES.DEV_GREEN:
      return {
        type: 'invoke_skill',
        skill: 'bmad-dev-story',
        phase: state.phase,
        template: 'bmad-dev-story.green.tmpl.md',
        template_slots: buildTemplateSlots(state, profile, { tdd_phase: 'green' }),
      };
    case STATES.CODE_REVIEW:
      return {
        type: 'invoke_skill',
        skill: 'bmad-code-review',
        phase: state.phase,
        template: 'bmad-code-review.tmpl.md',
        template_slots: buildTemplateSlots(state, profile),
      };
    case STATES.PATCH_APPLY:
      return {
        type: 'invoke_skill',
        skill: 'bmad-dev-story',
        phase: state.phase,
        template: 'bmad-dev-story.patch.tmpl.md',
        template_slots: buildTemplateSlots(state, profile, { tdd_phase: 'patch' }),
      };
    case STATES.PATCH_RETEST:
      return {
        type: 'invoke_skill',
        skill: 'bmad-dev-story',
        phase: state.phase,
        template: 'bmad-dev-story.rereview.tmpl.md',
        template_slots: buildTemplateSlots(state, profile, { tdd_phase: 'rereview' }),
      };
    case STATES.STORY_DONE:
      return {
        type: 'git_op',
        phase: state.phase,
        op: 'commit_and_push_story',
        story_key: state.story_key,
        profile: profile.name,
      };
    case STATES.EPIC_BOUNDARY_CHECK:
      return {
        type: 'noop',
        phase: state.phase,
        reason: 'epic_boundary_check',
      };
    case STATES.RETROSPECTIVE: {
      if (profile.retrospective_mode === 'stop') {
        return {
          type: 'user_prompt',
          phase: state.phase,
          reason: 'retrospective_mode_stop',
          prompt:
            'Retrospective requested in `stop` mode. Run `/bmad-retrospective` interactively, then resume autopilot.',
        };
      }
      return {
        type: 'invoke_skill',
        skill: 'bmad-retrospective',
        phase: state.phase,
        template: 'bmad-retrospective.tmpl.md',
        template_slots: buildTemplateSlots(state, profile, {
          epic_key: state.current_epic || null,
        }),
      };
    }
    case STATES.SPRINT_FINALIZE_PENDING:
      return {
        type: 'halt',
        phase: state.phase,
        reason: 'sprint_complete',
        handoff: 'sprint_finalize_pending',
      };
    case STATES.NANO_QUICK_DEV:
      return {
        type: 'invoke_skill',
        skill: 'bmad-quick-dev',
        phase: state.phase,
        template: 'bmad-quick-dev.tmpl.md',
        template_slots: buildTemplateSlots(state, profile),
      };
    default:
      throw new Error(`nextAction: unknown phase ${state.phase}`);
  }
}

// nextStateAfterSuccess(currentState, profile, signal) → newPhase
// Encodes the conditional edges (code_review→patch_apply only when any
// finding.action==='patch'; patch_retest→code_review when blocking remains;
// epic_boundary_check → retrospective when end of epic; etc.)
//
// Returns the next phase string, or null when the LLM should pause (the
// orchestrator will look at the previous action's success.output for hints).
function nextStateAfterSuccess(currentState, profile, signal) {
  if (!currentState || !currentState.phase) throw new Error('nextStateAfterSuccess: phase required');
  const phase = currentState.phase;
  const output = (signal && signal.output) || {};

  // First: hint tiebreaker. If the LLM provided a structurally-valid hint, prefer it.
  const successors = (profile.implementation_flow === 'quick' ? NANO_FLOW_SUCCESSORS : FULL_FLOW_SUCCESSORS)[phase] || [];
  const hint = signal && signal.next_skill_hint;
  // We only consult the hint when the deterministic decision below has more
  // than one valid successor. Compute the deterministic answer first.

  const det = deterministicNext(currentState, profile, output);
  if (det && successors.length > 1 && hint && hintMatchesPhase(hint, det.allValid)) {
    const chosen = mapHintToPhase(hint, det.allValid);
    if (chosen) return chosen;
  }
  return det ? det.chosen : null;
}

function deterministicNext(state, profile, output) {
  const phase = state.phase;
  switch (phase) {
    case STATES.CREATE_STORY:
      return { chosen: STATES.CHECK_READINESS, allValid: [STATES.CHECK_READINESS] };
    case STATES.CHECK_READINESS:
      return { chosen: STATES.DEV_RED, allValid: [STATES.DEV_RED] };
    case STATES.DEV_RED:
      return { chosen: STATES.DEV_GREEN, allValid: [STATES.DEV_GREEN] };
    case STATES.DEV_GREEN:
      return { chosen: STATES.CODE_REVIEW, allValid: [STATES.CODE_REVIEW] };
    case STATES.CODE_REVIEW: {
      const findings = Array.isArray(output.findings) ? output.findings : [];
      const hasPatch = findings.some((f) => f && f.action === 'patch');
      const hasBlock = findings.some((f) => f && f.action === 'block');
      // `block` findings produce a user_prompt via the adapt layer — not a
      // forward state transition. Here we just choose the structural successor.
      if (hasBlock) return null;
      const chosen = hasPatch ? STATES.PATCH_APPLY : STATES.STORY_DONE;
      return { chosen, allValid: [STATES.PATCH_APPLY, STATES.STORY_DONE] };
    }
    case STATES.PATCH_APPLY:
      return { chosen: STATES.PATCH_RETEST, allValid: [STATES.PATCH_RETEST] };
    case STATES.PATCH_RETEST: {
      const findings = Array.isArray(output.remaining_findings) ? output.remaining_findings : [];
      const stillBlocking = findings.some((f) => f && f.action === 'block');
      const chosen = stillBlocking ? STATES.CODE_REVIEW : STATES.STORY_DONE;
      return { chosen, allValid: [STATES.CODE_REVIEW, STATES.STORY_DONE] };
    }
    case STATES.STORY_DONE:
      return { chosen: STATES.EPIC_BOUNDARY_CHECK, allValid: [STATES.EPIC_BOUNDARY_CHECK] };
    case STATES.EPIC_BOUNDARY_CHECK: {
      const remainingInEpic = state.remaining_stories_in_epic || 0;
      const sprintDone = !!state.sprint_is_complete;
      // End of epic?
      if (remainingInEpic <= 0) {
        if (profile.retrospective_mode === 'skip') {
          return {
            chosen: sprintDone ? STATES.SPRINT_FINALIZE_PENDING : nextStoryStart(profile),
            allValid: [STATES.SPRINT_FINALIZE_PENDING, nextStoryStart(profile)],
          };
        }
        return { chosen: STATES.RETROSPECTIVE, allValid: [STATES.RETROSPECTIVE] };
      }
      // More stories in the same epic.
      return { chosen: nextStoryStart(profile), allValid: [nextStoryStart(profile)] };
    }
    case STATES.RETROSPECTIVE: {
      const sprintDone = !!state.sprint_is_complete;
      const chosen = sprintDone ? STATES.SPRINT_FINALIZE_PENDING : nextStoryStart(profile);
      return { chosen, allValid: [STATES.SPRINT_FINALIZE_PENDING, nextStoryStart(profile)] };
    }
    case STATES.NANO_QUICK_DEV:
      return { chosen: STATES.STORY_DONE, allValid: [STATES.STORY_DONE] };
    case STATES.SPRINT_FINALIZE_PENDING:
      return null;
    default:
      return null;
  }
}

function nextStoryStart(profile) {
  return profile.implementation_flow === 'quick' ? STATES.NANO_QUICK_DEV : STATES.CREATE_STORY;
}

// Best-effort mapping from a next_skill_hint string (e.g. "bmad-code-review")
// to a phase identifier. Used only as a tiebreaker.
const HINT_TO_PHASE = {
  'bmad-create-story': STATES.CREATE_STORY,
  'bmad-check-implementation-readiness': STATES.CHECK_READINESS,
  'bmad-dev-story:red': STATES.DEV_RED,
  'bmad-dev-story:green': STATES.DEV_GREEN,
  'bmad-dev-story:patch': STATES.PATCH_APPLY,
  'bmad-dev-story:rereview': STATES.PATCH_RETEST,
  'bmad-code-review': STATES.CODE_REVIEW,
  'bmad-retrospective': STATES.RETROSPECTIVE,
  'bmad-quick-dev': STATES.NANO_QUICK_DEV,
  story_done: STATES.STORY_DONE,
  sprint_finalize_pending: STATES.SPRINT_FINALIZE_PENDING,
};

function mapHintToPhase(hint, allValidPhases) {
  if (typeof hint !== 'string') return null;
  const phase = HINT_TO_PHASE[hint];
  if (!phase) return null;
  if (!allValidPhases.includes(phase)) return null;
  return phase;
}

function hintMatchesPhase(hint, allValidPhases) {
  return mapHintToPhase(hint, allValidPhases) !== null;
}

module.exports = {
  STATES,
  TERMINAL_STATES,
  FULL_FLOW_SUCCESSORS,
  NANO_FLOW_SUCCESSORS,
  nextAction,
  nextStateAfterSuccess,
  // Exposed for adapt.js to construct fresh-story states.
  nextStoryStart,
  // Exposed for tests / inspection.
  buildTemplateSlots,
  HINT_TO_PHASE,
};
