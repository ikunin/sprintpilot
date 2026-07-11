// user-commands.js — validate UserCommand payloads emitted via `user_input` signals.
//
// The LLM watches the host chat for user interjections and translates them
// into structured UserCommand objects. The orchestrator validates and
// applies them.
//
// Pure module. No I/O.
//
// Command kinds (initial set; new kinds added via additive PR):
//   skip_story         { story_key: string, reason?: string }
//   abort_sprint       { reason?: string }
//   force_continue     { reason?: string }
//   override_decision  { decision_id: string, new_value: string }
//   change_profile     { profile: 'nano'|'small'|'medium'|'large'|'legacy' }
//   pause              { reason?: string }
//   accept_alternative { reason?: string }
//     Accepts the orchestrator's most recent `propose_alternative` that
//     was escalated to a user_prompt at medium/high impact. Dispatches
//     the stored alternative as the next action and clears the pending
//     entry. Validation rejects this kind when no alternative is pending
//     in state — see user-command-applier.js for the runtime check.
//   trigger_retrospective { reason?: string }
//     Force-routes the orchestrator into RETROSPECTIVE for the current
//     epic regardless of `remaining_stories_in_epic`. Used when the user
//     explicitly wants to close out an epic with deferred stories still
//     in the queue (BMad has no formal `skipped`/`deferred` status for
//     stories, so the orchestrator otherwise counts them as remaining
//     and routes to next-story instead of retro).
//
// v2.3.0 — plan-aware mid-flight commands. These operate on
// sprint-plan.yaml via the Phase 2 primitives. DAG-aware validation
// lives in the applier (it needs the live plan + helper).
//   reorder_queue { order: string[] }
//     Rewrite priorities so the plan's pending stories match `order`.
//     Validated against the DAG: every upstream of each story must be
//     positioned BEFORE it OR plan-terminal. Inline edit — no phase
//     change.
//   add_to_sprint { story_keys: string[], position?: 'end'|'after:<key>'|<int>, issue_ids?: object }
//     Add stories to plan.stories[]. Each key must exist in sprint-status,
//     be non-terminal there, and not already in plan. Optional issue_ids
//     map populates issue_id per added story.
//   remove_from_sprint { story_keys: string[], mark_status?: 'skipped'|'deferred' }
//     Mark stories with plan_status=skipped (default) or 'deferred'.
//     Downstream-in-plan stories get a warning side effect.
//   replan_sprint { reason?: string, focus_epics?: string[],
//                   focus_stories?: string[],
//                   scheduling?: 'top'|'focus_only'|'append'|'custom' }
//     Halt at next story_done boundary and emit invoke_skill for
//     /sprintpilot-plan-sprint. Optional focus_epics / focus_stories +
//     scheduling carry the user's intent through to the skill's Step 0
//     so a re-plan triggered by *"focus on epic 21 at the top"* doesn't
//     have to be re-typed once the next session starts.
//
// Validation returns { ok: true, command } | { ok: false, errors: string[] }.

'use strict';

const VALID_PROFILE_NAMES = ['nano', 'small', 'medium', 'large', 'legacy'];

const COMMAND_KINDS = [
  'skip_story',
  'abort_sprint',
  'force_continue',
  'override_decision',
  'change_profile',
  'pause',
  'accept_alternative',
  'trigger_retrospective',
  // v2.3.0 — plan-aware mid-flight commands.
  'reorder_queue',
  'add_to_sprint',
  'remove_from_sprint',
  'replan_sprint',
  // Fast lane — mark a story/epic fast|full (or `auto` to clear the mark).
  'set_fast_lane',
];

const FAST_LANE_DECISIONS = ['fast', 'full', 'auto'];

const STORY_KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;
const EPIC_ID_RE = /^[A-Za-z0-9._-]{1,32}$/;
const DECISION_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const VALID_REMOVE_STATUSES = ['skipped', 'deferred'];
const VALID_SCHEDULING_MODES = ['top', 'focus_only', 'append', 'custom'];

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function validateOne(cmd) {
  const errors = [];
  if (!isPlainObject(cmd)) {
    return { ok: false, errors: ['command is not an object'] };
  }
  if (!nonEmptyString(cmd.kind)) {
    errors.push('missing kind');
    return { ok: false, errors };
  }
  if (!COMMAND_KINDS.includes(cmd.kind)) {
    errors.push(`unknown kind: ${cmd.kind}`);
    return { ok: false, errors };
  }

  switch (cmd.kind) {
    case 'skip_story': {
      if (!nonEmptyString(cmd.story_key)) errors.push('skip_story.story_key required');
      else if (!STORY_KEY_RE.test(cmd.story_key))
        errors.push('skip_story.story_key must match [A-Za-z0-9._-]{1,64}');
      if ('reason' in cmd && cmd.reason !== undefined && typeof cmd.reason !== 'string')
        errors.push('skip_story.reason must be string when present');
      break;
    }
    case 'set_fast_lane': {
      // Exactly one target: story_key OR epic. decision ∈ fast|full|auto.
      const hasStory = 'story_key' in cmd && cmd.story_key !== undefined;
      const hasEpic = 'epic' in cmd && cmd.epic !== undefined;
      if (hasStory === hasEpic) {
        errors.push('set_fast_lane requires exactly one of story_key or epic');
      } else if (hasStory) {
        if (!nonEmptyString(cmd.story_key) || !STORY_KEY_RE.test(cmd.story_key))
          errors.push('set_fast_lane.story_key must match [A-Za-z0-9._-]{1,64}');
      } else if (!nonEmptyString(cmd.epic) || !EPIC_ID_RE.test(cmd.epic)) {
        errors.push('set_fast_lane.epic must match [A-Za-z0-9._-]{1,32}');
      }
      if (!nonEmptyString(cmd.decision) || !FAST_LANE_DECISIONS.includes(cmd.decision))
        errors.push(`set_fast_lane.decision must be one of ${FAST_LANE_DECISIONS.join(', ')}`);
      break;
    }
    case 'abort_sprint':
    case 'force_continue':
    case 'pause':
    case 'accept_alternative':
    case 'trigger_retrospective': {
      if ('reason' in cmd && cmd.reason !== undefined && typeof cmd.reason !== 'string')
        errors.push(`${cmd.kind}.reason must be string when present`);
      break;
    }
    case 'reorder_queue': {
      if (!Array.isArray(cmd.order) || cmd.order.length === 0) {
        errors.push('reorder_queue.order must be a non-empty array of story keys');
        break;
      }
      const seen = new Set();
      for (const k of cmd.order) {
        if (!nonEmptyString(k) || !STORY_KEY_RE.test(k)) {
          errors.push(`reorder_queue.order entry ${JSON.stringify(k)} must match [A-Za-z0-9._-]{1,64}`);
          continue;
        }
        if (seen.has(k)) {
          errors.push(`reorder_queue.order contains duplicate key ${JSON.stringify(k)}`);
          continue;
        }
        seen.add(k);
      }
      break;
    }
    case 'add_to_sprint': {
      if (!Array.isArray(cmd.story_keys) || cmd.story_keys.length === 0) {
        errors.push('add_to_sprint.story_keys must be a non-empty array');
        break;
      }
      for (const k of cmd.story_keys) {
        if (!nonEmptyString(k) || !STORY_KEY_RE.test(k)) {
          errors.push(
            `add_to_sprint.story_keys entry ${JSON.stringify(k)} must match [A-Za-z0-9._-]{1,64}`,
          );
        }
      }
      if (cmd.position !== undefined && cmd.position !== null) {
        const p = cmd.position;
        const isEnd = p === 'end';
        const isAfter = typeof p === 'string' && p.startsWith('after:') && p.length > 6;
        const isInt = typeof p === 'number' && Number.isFinite(p);
        if (!isEnd && !isAfter && !isInt) {
          errors.push(
            "add_to_sprint.position must be 'end', 'after:<key>', or an integer index",
          );
        }
      }
      if (cmd.issue_ids !== undefined && cmd.issue_ids !== null) {
        if (!isPlainObject(cmd.issue_ids)) {
          errors.push('add_to_sprint.issue_ids must be an object map { story_key: issue_id }');
        } else {
          for (const [k, v] of Object.entries(cmd.issue_ids)) {
            if (!STORY_KEY_RE.test(k)) {
              errors.push(
                `add_to_sprint.issue_ids key ${JSON.stringify(k)} must match [A-Za-z0-9._-]{1,64}`,
              );
            }
            if (typeof v !== 'string' && v !== null) {
              errors.push(`add_to_sprint.issue_ids[${k}] must be a string or null`);
            }
          }
        }
      }
      break;
    }
    case 'remove_from_sprint': {
      if (!Array.isArray(cmd.story_keys) || cmd.story_keys.length === 0) {
        errors.push('remove_from_sprint.story_keys must be a non-empty array');
        break;
      }
      for (const k of cmd.story_keys) {
        if (!nonEmptyString(k) || !STORY_KEY_RE.test(k)) {
          errors.push(
            `remove_from_sprint.story_keys entry ${JSON.stringify(k)} must match [A-Za-z0-9._-]{1,64}`,
          );
        }
      }
      if (cmd.mark_status !== undefined && cmd.mark_status !== null) {
        if (!VALID_REMOVE_STATUSES.includes(cmd.mark_status)) {
          errors.push(
            `remove_from_sprint.mark_status must be one of ${VALID_REMOVE_STATUSES.join(', ')}`,
          );
        }
      }
      break;
    }
    case 'replan_sprint': {
      if ('reason' in cmd && cmd.reason !== undefined && typeof cmd.reason !== 'string') {
        errors.push('replan_sprint.reason must be string when present');
      }
      if ('focus_epics' in cmd && cmd.focus_epics !== undefined && cmd.focus_epics !== null) {
        if (!Array.isArray(cmd.focus_epics) || cmd.focus_epics.length === 0) {
          errors.push('replan_sprint.focus_epics must be a non-empty array when present');
        } else {
          for (const id of cmd.focus_epics) {
            if (!nonEmptyString(id) || !EPIC_ID_RE.test(id)) {
              errors.push(
                `replan_sprint.focus_epics entry ${JSON.stringify(id)} must match [A-Za-z0-9._-]{1,32}`,
              );
            }
          }
        }
      }
      if ('focus_stories' in cmd && cmd.focus_stories !== undefined && cmd.focus_stories !== null) {
        if (!Array.isArray(cmd.focus_stories) || cmd.focus_stories.length === 0) {
          errors.push('replan_sprint.focus_stories must be a non-empty array when present');
        } else {
          for (const k of cmd.focus_stories) {
            if (!nonEmptyString(k) || !STORY_KEY_RE.test(k)) {
              errors.push(
                `replan_sprint.focus_stories entry ${JSON.stringify(k)} must match [A-Za-z0-9._-]{1,64}`,
              );
            }
          }
        }
      }
      if ('scheduling' in cmd && cmd.scheduling !== undefined && cmd.scheduling !== null) {
        if (!VALID_SCHEDULING_MODES.includes(cmd.scheduling)) {
          errors.push(
            `replan_sprint.scheduling must be one of ${VALID_SCHEDULING_MODES.join(', ')}`,
          );
        }
      }
      break;
    }
    case 'override_decision': {
      if (!nonEmptyString(cmd.decision_id)) errors.push('override_decision.decision_id required');
      else if (!DECISION_ID_RE.test(cmd.decision_id))
        errors.push('override_decision.decision_id must match [A-Za-z0-9._-]{1,64}');
      if (!nonEmptyString(cmd.new_value)) errors.push('override_decision.new_value required');
      break;
    }
    case 'change_profile': {
      if (!nonEmptyString(cmd.profile)) errors.push('change_profile.profile required');
      else if (!VALID_PROFILE_NAMES.includes(cmd.profile))
        errors.push(`change_profile.profile must be one of ${VALID_PROFILE_NAMES.join(',')}`);
      break;
    }
    default:
      errors.push(`unhandled kind: ${cmd.kind}`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, command: cmd };
}

// validate(commands) — accepts a single command or an array. Returns:
//   { ok: true, commands: UserCommand[] } when every command validates
//   { ok: false, errors: { index, errors: string[] }[] } otherwise
function validate(input) {
  const list = Array.isArray(input) ? input : [input];
  const valid = [];
  const errors = [];
  for (let i = 0; i < list.length; i += 1) {
    const r = validateOne(list[i]);
    if (r.ok) valid.push(r.command);
    else errors.push({ index: i, errors: r.errors });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, commands: valid };
}

module.exports = {
  COMMAND_KINDS,
  VALID_PROFILE_NAMES,
  VALID_REMOVE_STATUSES,
  STORY_KEY_RE,
  validate,
  validateOne,
};
