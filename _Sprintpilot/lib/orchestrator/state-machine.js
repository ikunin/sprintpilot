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
  // PREPARE_STORY_BRANCH — emitted as the first state of a fresh story
  // when the active git settings require a per-story or per-epic branch
  // (granularity ∈ {story, epic} AND !reuse_user_branch). Resolves to a
  // git_op with op: 'create_branch' so the story file itself is authored
  // on the story branch. Under `reuse_user_branch: true` this state is
  // skipped and CREATE_STORY / NANO_QUICK_DEV runs directly on the
  // user-locked branch.
  PREPARE_STORY_BRANCH: 'prepare_story_branch',
  CREATE_STORY: 'create_story',
  CHECK_READINESS: 'check_readiness',
  DEV_RED: 'dev_red',
  DEV_GREEN: 'dev_green',
  CODE_REVIEW: 'code_review',
  PATCH_APPLY: 'patch_apply',
  PATCH_RETEST: 'patch_retest',
  STORY_DONE: 'story_done',
  // STORY_LAND — entered only when profile.merge_strategy === 'land_as_you_go'.
  // Composes stack-snapshot.js + land-this-pr.js to merge the just-finished
  // story's PR into base. Skipped (STORY_DONE → EPIC_BOUNDARY_CHECK directly)
  // under the default 'stacked' strategy.
  STORY_LAND: 'story_land',
  // MERGE_EPIC — entered from EPIC_BOUNDARY_CHECK when:
  //   • end-of-epic (remaining_stories_in_epic === 0)
  //   • granularity === 'epic'
  //   • merge_strategy === 'stacked'
  //   • push_auto === true, has_origin !== false, !reuse_user_branch
  // Closes out the epic branch by either merging its PR (push_create_pr=
  // true) or local-merging directly to base (push_create_pr=false). The
  // existing planMergeEpic builds the local-merge sequence; planMergeEpicPr
  // builds the gh-cli sequence.
  MERGE_EPIC: 'merge_epic',
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
  [STATES.PREPARE_STORY_BRANCH]: [STATES.CREATE_STORY],
  [STATES.CREATE_STORY]: [STATES.CHECK_READINESS],
  [STATES.CHECK_READINESS]: [STATES.DEV_RED],
  [STATES.DEV_RED]: [STATES.DEV_GREEN],
  [STATES.DEV_GREEN]: [STATES.CODE_REVIEW],
  [STATES.CODE_REVIEW]: [STATES.PATCH_APPLY, STATES.STORY_DONE], // conditional
  [STATES.PATCH_APPLY]: [STATES.PATCH_RETEST],
  [STATES.PATCH_RETEST]: [STATES.CODE_REVIEW, STATES.STORY_DONE], // conditional (re-review if still blocking)
  [STATES.STORY_DONE]: [STATES.STORY_LAND, STATES.EPIC_BOUNDARY_CHECK], // STORY_LAND only under land_as_you_go
  [STATES.STORY_LAND]: [STATES.EPIC_BOUNDARY_CHECK],
  [STATES.EPIC_BOUNDARY_CHECK]: [
    STATES.MERGE_EPIC,
    STATES.RETROSPECTIVE,
    STATES.PREPARE_STORY_BRANCH,
    STATES.CREATE_STORY,
    STATES.SPRINT_FINALIZE_PENDING,
  ],
  [STATES.MERGE_EPIC]: [STATES.RETROSPECTIVE, STATES.SPRINT_FINALIZE_PENDING],
  [STATES.RETROSPECTIVE]: [
    STATES.PREPARE_STORY_BRANCH,
    STATES.CREATE_STORY,
    STATES.SPRINT_FINALIZE_PENDING,
  ],
};

const NANO_FLOW_SUCCESSORS = {
  [STATES.PREPARE_STORY_BRANCH]: [STATES.NANO_QUICK_DEV],
  [STATES.NANO_QUICK_DEV]: [STATES.STORY_DONE],
  [STATES.STORY_DONE]: [STATES.STORY_LAND, STATES.EPIC_BOUNDARY_CHECK],
  [STATES.STORY_LAND]: [STATES.EPIC_BOUNDARY_CHECK],
  [STATES.EPIC_BOUNDARY_CHECK]: [
    STATES.MERGE_EPIC,
    STATES.RETROSPECTIVE,
    STATES.PREPARE_STORY_BRANCH,
    STATES.NANO_QUICK_DEV,
    STATES.SPRINT_FINALIZE_PENDING,
  ],
  [STATES.MERGE_EPIC]: [STATES.RETROSPECTIVE, STATES.SPRINT_FINALIZE_PENDING],
  [STATES.RETROSPECTIVE]: [
    STATES.PREPARE_STORY_BRANCH,
    STATES.NANO_QUICK_DEV,
    STATES.SPRINT_FINALIZE_PENDING,
  ],
};

// Build instruction template content slots from state + profile. This is the
// LLM-intelligence preservation channel: every skill invocation gets a rich
// context bundle, not a free-form prose blob.
//
// Test-scope slots (test_scope, recommended_test_command, test_files_hint,
// test_scope_decision_summary, test_scope_hint_guidance) are seeded null
// here and filled in by the CLI edge (autopilot.js#decorateTestScope) for
// the test-running phases: DEV_RED, DEV_GREEN, PATCH_APPLY, PATCH_RETEST,
// NANO_QUICK_DEV. The state machine stays pure (no fs/git I/O); the
// decorator runs `git diff` + picks the right adapter.
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
    // Filled by autopilot.js#decorateTestScope for test-running phases.
    test_scope: null,
    recommended_test_command: null,
    test_files_hint: null,
    test_scope_decision_summary: null,
    test_scope_hint_guidance: null,
    ...extra,
  };
}

// Phases where the CLI edge should populate test-scope slots.
const TEST_PHASES = new Set([
  STATES.DEV_RED,
  STATES.DEV_GREEN,
  STATES.PATCH_APPLY,
  STATES.PATCH_RETEST,
  STATES.NANO_QUICK_DEV,
]);
function isTestPhase(phase) {
  return TEST_PHASES.has(phase);
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
  // session_story_limit: when this session has completed >= limit
  // stories, halt cleanly. The next /sprint-autopilot-on resets the
  // counter and continues. Skipped when limit === 0 (unlimited per
  // Sprintpilot.md) or limit is unset.
  const sessionLimit = profile && profile.session_story_limit;
  const sessionDone = state.session_stories_completed || 0;
  if (
    typeof sessionLimit === 'number' &&
    sessionLimit > 0 &&
    sessionDone >= sessionLimit &&
    // Don't halt when we're at a story-start phase — that would
    // create an infinite halt loop on resume. The limit check should
    // fire at the boundary between stories (epic_boundary_check or
    // before the next story is picked). Most natural is to halt
    // before emitting the next story-start action.
    (state.phase === STATES.EPIC_BOUNDARY_CHECK ||
      state.phase === STATES.RETROSPECTIVE ||
      state.phase === STATES.PREPARE_STORY_BRANCH ||
      state.phase === STATES.CREATE_STORY ||
      state.phase === STATES.NANO_QUICK_DEV)
  ) {
    return {
      type: 'halt',
      reason: 'session_story_limit_reached',
      prompt:
        `Session story limit reached (${sessionDone}/${sessionLimit}). ` +
        `Run /sprint-autopilot-on to start a new session and continue with the next pending story.`,
      session_stories_completed: sessionDone,
      session_story_limit: sessionLimit,
    };
  }

  switch (state.phase) {
    case STATES.PREPARE_STORY_BRANCH: {
      // Safety net: PREPARE_STORY_BRANCH needs a known story_key (and,
      // under granularity=epic, a current_epic) so git-plan.branchName
      // can compute a real branch. composeRuntimeState resolves these
      // from sprint-status.yaml before we get here — but if BOTH are
      // null (sprint-status was empty, unreadable, or doesn't exist
      // yet) we'd emit `branch: story/unknown` and confuse the runner.
      // Emit a user_prompt instead so the user fixes the upstream
      // condition (run BMad sprint-planning) rather than acting on a
      // garbage action.
      const haveStoryKey = !!state.story_key;
      const haveEpicForBranch =
        profile.granularity === 'epic' && !!state.current_epic;
      if (!haveStoryKey && !haveEpicForBranch) {
        return {
          type: 'user_prompt',
          phase: state.phase,
          reason: 'prepare_story_branch_no_story_key',
          prompt:
            'PREPARE_STORY_BRANCH was emitted but the orchestrator could not resolve a next story_key from sprint-status.yaml. ' +
            'Either run BMad sprint-planning to populate sprint-status.yaml, set `git.reuse_user_branch: true` in modules/git/config.yaml to commit on the current branch, ' +
            'or set `git.enabled: false` for a dry run without git operations.',
        };
      }
      // The edge layer (autopilot.js#decorateGitOp) inlines the planned
      // argv steps via git-plan.js#planCreateBranch. It also probes git
      // for branch existence and threads `state.branch_exists` through
      // so the plan can degrade `git switch -c` to `git switch` when the
      // branch already exists (e.g. second story under granularity=epic,
      // or resume after partial failure).
      return {
        type: 'git_op',
        phase: state.phase,
        op: 'create_branch',
        story_key: state.story_key,
        epic_key: state.current_epic,
        profile: profile.name,
      };
    }
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
    case STATES.MERGE_EPIC:
      // Edge layer (decorateGitOp) inlines the argv steps via
      // git-plan.js#planMergeEpic. The plan branches internally on
      // profile.push_create_pr to choose `gh pr merge --squash` vs the
      // local-merge sequence.
      return {
        type: 'git_op',
        phase: state.phase,
        op: 'merge_epic',
        story_key: state.story_key,
        epic_key: state.current_epic,
        profile: profile.name,
      };
    case STATES.STORY_LAND:
      // Land-as-you-go: orchestrator plumbing emits a `run_script` that
      // wraps the existing stack-snapshot.js + land-this-pr.js scripts.
      // Honors land_when (no_wait | ci_pass | ci_and_review) and
      // land_wait_minutes from the profile.
      return {
        type: 'run_script',
        phase: state.phase,
        op: 'land_story',
        story_key: state.story_key,
        profile: profile.name,
        land_when: profile.land_when || 'ci_pass',
        land_wait_minutes:
          typeof profile.land_wait_minutes === 'number' ? profile.land_wait_minutes : 30,
        squash_on_merge: !!profile.squash_on_merge,
        // The CLI edge composes the actual argv via land.js#planLand; this
        // action only declares intent so the harness/log can see it.
        helper: 'lib/orchestrator/land.js',
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
    case STATES.PREPARE_STORY_BRANCH: {
      // Branch is on disk → enter the actual story work (flow-dependent).
      const next = profile.implementation_flow === 'quick'
        ? STATES.NANO_QUICK_DEV
        : STATES.CREATE_STORY;
      return { chosen: next, allValid: [next] };
    }
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
    case STATES.STORY_DONE: {
      // Land-as-you-go: route through STORY_LAND before EPIC_BOUNDARY_CHECK.
      // The default 'stacked' strategy skips STORY_LAND entirely.
      const goLand =
        profile && profile.merge_strategy === 'land_as_you_go'
          ? STATES.STORY_LAND
          : STATES.EPIC_BOUNDARY_CHECK;
      return { chosen: goLand, allValid: [STATES.STORY_LAND, STATES.EPIC_BOUNDARY_CHECK] };
    }
    case STATES.STORY_LAND:
      return { chosen: STATES.EPIC_BOUNDARY_CHECK, allValid: [STATES.EPIC_BOUNDARY_CHECK] };
    case STATES.EPIC_BOUNDARY_CHECK: {
      const remainingInEpic = state.remaining_stories_in_epic || 0;
      const sprintDone = !!state.sprint_is_complete;
      // End of epic?
      if (remainingInEpic <= 0) {
        // Epic merge: granularity=epic + stacked + autoremote-push +
        // !reuse_user_branch + git enabled → close out the epic branch
        // (MERGE_EPIC) before retrospective / next-epic routing.
        if (epicMergeNeeded(profile)) {
          return { chosen: STATES.MERGE_EPIC, allValid: [STATES.MERGE_EPIC] };
        }
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
    case STATES.MERGE_EPIC: {
      const sprintDone = !!state.sprint_is_complete;
      const successor = nextStoryStart(profile);
      // Structurally-valid successors per FULL/NANO_FLOW_SUCCESSORS:
      // [RETROSPECTIVE, SPRINT_FINALIZE_PENDING]. Include the next-story
      // start under retro=skip so the hint tiebreaker can route to it
      // when the LLM has a strong opinion.
      const allValid = [STATES.RETROSPECTIVE, STATES.SPRINT_FINALIZE_PENDING, successor];
      if (profile.retrospective_mode === 'skip') {
        return {
          chosen: sprintDone ? STATES.SPRINT_FINALIZE_PENDING : successor,
          allValid,
        };
      }
      return { chosen: STATES.RETROSPECTIVE, allValid };
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

// nextStoryStart(profile) — the first phase of a fresh story.
//
// Under settings that require a per-story or per-epic branch
// (granularity ∈ {story, epic} AND !reuse_user_branch) the very first
// phase is PREPARE_STORY_BRANCH so the branch exists before the story
// file is authored. Otherwise we skip straight to the flow-appropriate
// implementation step.
//
// The `reuse_user_branch: true` path is handled by autopilot.js#cmdStart
// which detects the current branch and locks it in via state.user_branch;
// PREPARE_STORY_BRANCH is unnecessary in that mode (every story commits
// to the same already-checked-out branch).
// epicMergeNeeded(profile) — true when EPIC_BOUNDARY_CHECK at end-of-epic
// should route through MERGE_EPIC instead of jumping straight to
// retrospective / next-story. Matches the same triggers as the per-story
// PR/merge in planCommitAndPush, just shifted to the epic-branch flow.
function epicMergeNeeded(profile) {
  return (
    profile &&
    profile.enabled !== false &&
    !profile.reuse_user_branch &&
    profile.granularity === 'epic' &&
    (profile.merge_strategy || 'stacked') === 'stacked' &&
    profile.push_auto !== false &&
    profile.has_origin !== false
  );
}

// shouldSkipVerifyWhenGitDisabled(phase) — true when verify.js should
// be bypassed under `git.enabled: false`. This covers phases that emit
// a git_op (PREPARE_STORY_BRANCH, STORY_DONE, MERGE_EPIC) and STORY_LAND
// (which emits a run_script but reports the same kind of post-merge
// bookkeeping that requires git operations to have happened).
//
// Centralizing the list here means new phases of either kind won't
// silently miss the verify-skip wiring — add them to the set below.
// (Previously named `isGitOpPhase`; renamed because STORY_LAND is not
// strictly a git_op and the old name lied.)
const GIT_INTERACTING_PHASES = new Set([
  STATES.PREPARE_STORY_BRANCH,
  STATES.STORY_DONE,
  STATES.MERGE_EPIC,
  STATES.STORY_LAND,
]);
function shouldSkipVerifyWhenGitDisabled(phase) {
  return GIT_INTERACTING_PHASES.has(phase);
}

function nextStoryStart(profile) {
  const needsBranchPrep =
    !profile.reuse_user_branch &&
    (profile.granularity === 'story' || profile.granularity === 'epic');
  if (needsBranchPrep) return STATES.PREPARE_STORY_BRANCH;
  return profile.implementation_flow === 'quick' ? STATES.NANO_QUICK_DEV : STATES.CREATE_STORY;
}

// Best-effort mapping from a next_skill_hint string (e.g. "bmad-code-review")
// to a phase identifier. Used only as a tiebreaker.
const HINT_TO_PHASE = {
  prepare_story_branch: STATES.PREPARE_STORY_BRANCH,
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
  merge_epic: STATES.MERGE_EPIC,
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
  // Exposed for autopilot.js verify-skip routing.
  shouldSkipVerifyWhenGitDisabled,
  // Exposed for tests / inspection.
  buildTemplateSlots,
  HINT_TO_PHASE,
  // Exposed for autopilot.js#decorateTestScope to know which phases
  // get the test-scope slot population.
  isTestPhase,
};
