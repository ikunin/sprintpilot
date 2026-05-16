// user-command-applier.js — apply validated UserCommands to runtime state.
//
// Pure function (state, profile, commands) → { newState, newProfile, sideEffects }
//
// The CLI edge calls user-commands.validate() first, then passes the
// validated commands here. The applier mutates runtime fields ONLY — it
// never touches sprint-status.yaml (that's BMad's domain).
//
// Adapt.js emits an `apply_user_commands` side effect; the CLI runs the
// validation and this applier, then re-emits nextAction with the new state.

'use strict';

const { STATES } = require('./state-machine');

function applyOne(state, profile, cmd) {
  const effects = [];
  let newState = state;
  let newProfile = profile;

  switch (cmd.kind) {
    case 'skip_story':
      // Drop the current story; transition to next-story-start.
      // The CLI is responsible for actually marking sprint-status; we
      // record the intent here so the next nextAction picks up fresh.
      newState = {
        ...state,
        phase:
          profile.implementation_flow === 'quick' ? STATES.NANO_QUICK_DEV : STATES.CREATE_STORY,
        story_key: null,
        story_file_path: null,
        ac_summary: null,
        prior_diagnosis: null,
        patch_findings: null,
        tests_to_rerun: null,
        retry_count_this_phase: 0,
        verify_reject_count: 0,
        consecutive_test_failures: 0,
      };
      effects.push({
        kind: 'state_transition',
        from: state.phase,
        to: newState.phase,
        reason: 'user_skip_story',
        skipped_story: cmd.story_key,
      });
      break;

    case 'abort_sprint':
      newState = {
        ...state,
        phase: STATES.SPRINT_FINALIZE_PENDING,
        sprint_is_complete: true,
      };
      effects.push({
        kind: 'halt',
        reason: 'user_abort_sprint',
        details: cmd.reason || null,
      });
      break;

    case 'force_continue':
      // Clears verify-reject + retry counters so the orchestrator stops
      // looping on a stuck transition. Phase is unchanged. Also clears
      // any pending_alternative — `force_continue` is the explicit "no,
      // keep the planned action" answer to a propose_alternative prompt.
      newState = {
        ...state,
        retry_count_this_phase: 0,
        verify_reject_count: 0,
        consecutive_test_failures: 0,
        pending_alternative: undefined,
      };
      effects.push({
        kind: 'state_transition',
        from: state.phase,
        to: state.phase,
        reason: 'user_force_continue',
        details: cmd.reason || null,
        cleared_pending_alternative: !!state.pending_alternative,
      });
      break;

    case 'change_profile':
      // Session-scoped profile change. The CLI MUST NOT write back to
      // config.yaml. Per-profile orchestrator defaults are re-seeded but
      // the rest of the typed Profile (retrospective_mode, etc.) is left
      // alone unless the user explicitly re-runs validate-config.
      newProfile = {
        ...profile,
        name: cmd.profile,
        // Re-seed budgets from the orchestrator defaults table.
        retry_budget_per_action: defaultRetryBudgetFor(cmd.profile),
        verify_reject_budget: defaultVerifyBudgetFor(cmd.profile),
        // Mark the change so audit can detect it.
        changed_via_user_command: true,
      };
      effects.push({
        kind: 'profile_escalated', // reuse the ledger kind
        from: profile.name,
        to: cmd.profile,
        reason: 'user_change_profile',
      });
      break;

    case 'pause':
      // Set `halt_requested` so adapt.nextAction returns a halt action
      // on this same turn. Without this flag, prior versions of the
      // applier only logged the halt side-effect and the orchestrator
      // kept emitting the next planned action — the loop never stopped.
      // `halt_requested` is cleared by `start` on the next session
      // (same path that clears stale fingerprints on resume).
      newState = {
        ...state,
        halt_requested: {
          reason: cmd.reason || null,
          requested_at: new Date().toISOString(),
        },
      };
      effects.push({
        kind: 'halt',
        reason: 'user_pause',
        details: cmd.reason || null,
      });
      break;

    case 'accept_alternative': {
      // Dispatches the orchestrator's stored `pending_alternative` (set
      // when handleProposeAlternative escalated to a user_prompt at
      // medium/high impact). The CLI edge / adapt's handleUserInput
      // looks for this side-effect and uses `action` as the one-shot
      // nextAction in place of the state-machine default.
      const pending = state.pending_alternative;
      if (!pending || !pending.action) {
        effects.push({
          kind: 'validation_error',
          reason: 'accept_alternative: no pending alternative to accept',
          phase: state.phase,
          details: cmd.reason || null,
        });
        break;
      }
      newState = {
        ...state,
        pending_alternative: undefined,
        retry_count_this_phase: 0,
        verify_reject_count: 0,
      };
      effects.push({
        kind: 'dispatch_action',
        action: pending.action,
        impact: pending.impact || null,
        reason: 'user_accept_alternative',
        details: cmd.reason || null,
      });
      break;
    }

    case 'override_decision':
      // We don't apply a state mutation. The CLI records this so a
      // subsequent verify_override can reference DEC-id.
      effects.push({
        kind: 'state_transition',
        from: state.phase,
        to: state.phase,
        reason: 'user_override_decision',
        decision_id: cmd.decision_id,
        new_value: cmd.new_value,
      });
      break;

    case 'trigger_retrospective':
      // Force-route to RETROSPECTIVE regardless of remaining_stories_in_epic.
      // Used when the user explicitly wants to close out the current epic
      // with deferred stories still showing as non-terminal in sprint-status.
      // Story-bound fields cleared so the retro skill reads from current_epic.
      newState = {
        ...state,
        phase: STATES.RETROSPECTIVE,
        story_key: null,
        story_file_path: null,
        ac_summary: null,
        prior_diagnosis: null,
        patch_findings: null,
        tests_to_rerun: null,
        retry_count_this_phase: 0,
        verify_reject_count: 0,
        consecutive_test_failures: 0,
        // current_epic intentionally preserved — retro skill needs it.
      };
      effects.push({
        kind: 'state_transition',
        from: state.phase,
        to: STATES.RETROSPECTIVE,
        reason: 'user_trigger_retrospective',
        epic: state.current_epic || null,
        details: cmd.reason || null,
      });
      break;

    default:
      effects.push({ kind: 'state_transition', reason: 'unknown_user_command', cmd });
  }

  return { newState, newProfile, effects };
}

// Mirror of profile-rules.ORCHESTRATOR_DEFAULTS_BY_PROFILE — kept inline so
// the applier doesn't pull the whole profile-rules module in tight loops.
function defaultRetryBudgetFor(name) {
  if (name === 'nano') return 1;
  if (name === 'large') return 3;
  return 2;
}
function defaultVerifyBudgetFor(name) {
  if (name === 'nano') return 2;
  return 3;
}

function apply(state, profile, commands) {
  let s = state;
  let p = profile;
  const allEffects = [];
  for (const cmd of commands || []) {
    const r = applyOne(s, p, cmd);
    s = r.newState;
    p = r.newProfile;
    for (const e of r.effects) allEffects.push(e);
  }
  return { newState: s, newProfile: p, sideEffects: allEffects };
}

module.exports = { apply, applyOne };
