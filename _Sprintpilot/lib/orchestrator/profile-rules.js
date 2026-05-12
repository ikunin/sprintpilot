// profile-rules.js — typed Profile, flat→typed adapter, mid-sprint escalation.
//
// Pure module. No I/O. Consumes the flat tree produced by resolve-profile.js
// and produces a typed Profile object the orchestrator can consume directly.
//
// Mid-sprint escalation honors AGENTS.md:
//   "if quick-dev's tests fail or its Classify severity is `high`, the
//    autopilot escalates the session (session-scoped only — never written
//    back to config) to `full` flow"
//
// See plan: BMad sequence § Profile rules.

'use strict';

const VALID_PROFILE_NAMES = ['nano', 'small', 'medium', 'large', 'legacy'];
const VALID_FLOWS = ['full', 'quick'];
const VALID_RETRO_MODES = ['auto', 'stop', 'skip'];
const VALID_GRANULARITIES = ['story', 'epic'];
const VALID_MERGE_STRATEGIES = ['stacked', 'land_as_you_go'];
const VALID_LAND_WHENS = ['no_wait', 'ci_pass', 'ci_and_review'];

// Per-profile defaults for fields the orchestrator manages directly
// (verify_reject_budget, retry_budget_per_action). These are orchestrator-
// internal — not in the shipping YAML — so they're seeded here.
const ORCHESTRATOR_DEFAULTS_BY_PROFILE = {
  nano: { retry_budget_per_action: 1, verify_reject_budget: 2 },
  small: { retry_budget_per_action: 2, verify_reject_budget: 3 },
  medium: { retry_budget_per_action: 2, verify_reject_budget: 3 },
  large: { retry_budget_per_action: 3, verify_reject_budget: 3 },
  legacy: { retry_budget_per_action: 2, verify_reject_budget: 3 },
};

function get(obj, dottedKey) {
  if (obj === null || obj === undefined) return undefined;
  const parts = dottedKey.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function coerceBool(v, fallback) {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return fallback;
}

function coerceInt(v, fallback) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number.parseInt(v, 10);
  return fallback;
}

function coerceEnum(v, allowed, fallback) {
  if (typeof v === 'string' && allowed.includes(v)) return v;
  return fallback;
}

// Convert the flat resolved-config tree (from resolve-profile.js) into a
// typed Profile. Missing keys fall back to documented defaults.
function flatToProfile(resolved, profileName) {
  const name = VALID_PROFILE_NAMES.includes(profileName) ? profileName : 'medium';
  const orch = ORCHESTRATOR_DEFAULTS_BY_PROFILE[name];

  return {
    name,
    implementation_flow: coerceEnum(
      get(resolved, 'autopilot.implementation_flow'),
      VALID_FLOWS,
      'full',
    ),
    session_story_limit: coerceInt(get(resolved, 'autopilot.session_story_limit'), 3),
    retrospective_mode: coerceEnum(
      get(resolved, 'autopilot.retrospective_mode'),
      VALID_RETRO_MODES,
      'auto',
    ),
    coalesce_state_writes: coerceBool(get(resolved, 'autopilot.coalesce_state_writes'), false),
    conditional_boot_work: coerceBool(get(resolved, 'autopilot.conditional_boot_work'), false),
    granularity: coerceEnum(get(resolved, 'git.granularity'), VALID_GRANULARITIES, 'story'),
    worktree_enabled: coerceBool(get(resolved, 'git.worktree.enabled'), true),
    squash_on_merge: coerceBool(get(resolved, 'git.squash_on_merge'), false),
    reuse_user_branch: coerceBool(get(resolved, 'git.reuse_user_branch'), false),
    merge_strategy: coerceEnum(
      get(resolved, 'git.merge_strategy'),
      VALID_MERGE_STRATEGIES,
      'stacked',
    ),
    land_when: coerceEnum(get(resolved, 'git.land_when'), VALID_LAND_WHENS, 'ci_pass'),
    land_wait_minutes: coerceInt(get(resolved, 'git.land_wait_minutes'), 30),
    base_branch:
      typeof get(resolved, 'git.base_branch') === 'string'
        ? get(resolved, 'git.base_branch')
        : 'main',
    parallel_stories: coerceBool(get(resolved, 'ma.parallel_stories'), false),
    max_parallel_stories: coerceInt(get(resolved, 'ma.max_parallel_stories'), 2),
    fallback_on_tests_fail: coerceBool(
      get(resolved, 'autopilot.nano.fallback_on_tests_fail'),
      name === 'nano',
    ),
    fallback_on_quick_dev_high_severity: coerceBool(
      get(resolved, 'autopilot.nano.fallback_on_quick_dev_high_severity'),
      name === 'nano',
    ),
    fallback_target: coerceEnum(
      get(resolved, 'autopilot.nano.fallback_target'),
      ['small', 'medium', 'large'],
      'small',
    ),
    retry_budget_per_action: orch.retry_budget_per_action,
    verify_reject_budget: orch.verify_reject_budget,
  };
}

// Session-scoped mid-sprint escalation. Called when a nano `bmad-quick-dev`
// returns failure indicators. Returns a NEW Profile object — never mutates.
// Returns the original profile unchanged when escalation conditions are not met
// or the profile is not nano.
function escalateOnFailure(profile, signalOutput) {
  if (!profile || profile.name !== 'nano') return profile;
  if (!signalOutput || typeof signalOutput !== 'object') return profile;

  const testsFailed =
    typeof signalOutput.tests_failed === 'number' && signalOutput.tests_failed > 0;
  const highSeverity = signalOutput.severity === 'high';

  const shouldEscalate =
    (testsFailed && profile.fallback_on_tests_fail) ||
    (highSeverity && profile.fallback_on_quick_dev_high_severity);

  if (!shouldEscalate) return profile;

  const targetName = profile.fallback_target || 'small';
  const targetDefaults =
    ORCHESTRATOR_DEFAULTS_BY_PROFILE[targetName] || ORCHESTRATOR_DEFAULTS_BY_PROFILE.small;

  return {
    ...profile,
    name: targetName,
    implementation_flow: 'full',
    retry_budget_per_action: targetDefaults.retry_budget_per_action,
    verify_reject_budget: targetDefaults.verify_reject_budget,
    fallback_on_tests_fail: false,
    fallback_on_quick_dev_high_severity: false,
    escalated_from: 'nano',
    escalation_reason: testsFailed ? 'tests_failed' : 'high_severity',
  };
}

module.exports = {
  VALID_PROFILE_NAMES,
  VALID_FLOWS,
  VALID_RETRO_MODES,
  VALID_GRANULARITIES,
  VALID_MERGE_STRATEGIES,
  VALID_LAND_WHENS,
  ORCHESTRATOR_DEFAULTS_BY_PROFILE,
  flatToProfile,
  escalateOnFailure,
};
