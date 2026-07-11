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
        last_verify_issues_signature: null,
        consecutive_identical_rejections: 0,
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
      // v2.3.0: also reset verify-loop trackers so the next reject starts
      // fresh — user explicitly accepted that the prior issues are
      // resolved out of band.
      newState = {
        ...state,
        retry_count_this_phase: 0,
        verify_reject_count: 0,
        consecutive_test_failures: 0,
        last_verify_issues_signature: null,
        consecutive_identical_rejections: 0,
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
      // v2.3.0 — also clear verify-loop trackers. The profile change
      // shifts retry/verify budgets, so prior consecutive-identical
      // counts shouldn't influence the new profile's halt threshold.
      newState = {
        ...state,
        last_verify_issues_signature: null,
        consecutive_identical_rejections: 0,
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
        // v2.3.0 — accepting an alternative supersedes the prior planned
        // action, so prior verify-loop accumulator should reset too.
        // The next reject under the new action is treated as a fresh
        // signal-identity baseline.
        last_verify_issues_signature: null,
        consecutive_identical_rejections: 0,
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
        last_verify_issues_signature: null,
        consecutive_identical_rejections: 0,
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

    // v2.3.0 — plan-aware mid-flight commands. Each emits a side-effect
    // record that the CLI dispatcher handles by calling sprint-plan.js
    // primitives. DAG-aware validation lives in the dispatcher (it needs
    // the live plan file). State mutations are minimal here; only the
    // replan_sprint flow touches state to schedule the halt.
    case 'reorder_queue':
      effects.push({
        kind: 'plan_reorder',
        order: cmd.order,
        reason: cmd.reason || null,
      });
      break;

    case 'add_to_sprint':
      effects.push({
        kind: 'plan_add_stories',
        story_keys: cmd.story_keys,
        position: cmd.position !== undefined ? cmd.position : 'end',
        issue_ids: cmd.issue_ids || null,
        reason: cmd.reason || null,
      });
      break;

    case 'remove_from_sprint':
      effects.push({
        kind: 'plan_remove_stories',
        story_keys: cmd.story_keys,
        mark_status: cmd.mark_status || 'skipped',
        reason: cmd.reason || null,
      });
      break;

    case 'set_fast_lane':
      // Persist a fast|full mark (or clear to `auto`) for a story/epic into the
      // durable fast-lane-overrides store. The CLI edge (applySideEffects) does
      // the write; the applier stays pure.
      effects.push({
        kind: 'set_fast_lane',
        story_key: cmd.story_key !== undefined ? cmd.story_key : null,
        epic: cmd.epic !== undefined ? cmd.epic : null,
        decision: cmd.decision,
      });
      break;

    case 'replan_sprint':
      // Set replan_requested in state so the next cmdStart picks it up
      // and emits the invoke_skill action. Halt now so the autopilot
      // stops at the current story boundary; the user (or the LLM
      // session) restarts to drive the skill.
      //
      // Focus + scheduling fields carry intent from this mid-flight
      // command through to the planner skill's Step 0 — so a re-plan
      // triggered by "focus on epic 21 at the top" doesn't have to be
      // re-typed in the next session.
      newState = {
        ...state,
        replan_requested: {
          reason: cmd.reason || null,
          requested_at: new Date().toISOString(),
          focus_epics: cmd.focus_epics || null,
          focus_stories: cmd.focus_stories || null,
          scheduling: cmd.scheduling || null,
        },
        halt_requested: {
          reason: cmd.reason || 'user_replan_sprint',
          requested_at: new Date().toISOString(),
        },
      };
      effects.push({
        kind: 'halt',
        reason: 'user_replan_sprint',
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
