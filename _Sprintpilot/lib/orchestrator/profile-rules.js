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
const VALID_PLATFORM_PROVIDERS = ['auto', 'github', 'gitlab', 'bitbucket', 'gitea', 'git_only'];
const VALID_TESTING_SCOPES = ['affected', 'full'];
const VALID_TESTING_FALLBACKS = ['full', 'directory', 'halt'];
const VALID_FULL_SUITE_MODES = ['ci', 'background', 'skip'];

const DEFAULT_COMMIT_TEMPLATE_STORY = 'feat({epic}): {story-title} ({story-key})';
const DEFAULT_COMMIT_TEMPLATE_PATCH = 'fix({story-key}): {patch-title}';

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

// Per-phase wall-clock budgets (in minutes). When state.phase_started_at
// + budget < now, nextAction emits a user_prompt with
// reason='phase_timeout_exceeded' carrying { phase, elapsed_minutes,
// budget_minutes }. v2.4.0.
//
// Keys must match STATES.* values from state-machine.js. Unknown phases
// (e.g. epic_boundary_check, story_done) are intentionally unbudgeted —
// they're transient routing states, not work states.
//
// `legacy` is `null` (disabled) to preserve v1.0.5 behavior byte-for-byte.
// User overrides via `autopilot.phase_timeout_minutes` always win; set
// to `null` to disable timeouts entirely, or set a per-phase value to
// override a single phase budget.
const PHASE_TIMEOUT_DEFAULTS_BY_PROFILE = {
  nano: {
    nano_quick_dev: 15,
    create_story: 5,
    check_readiness: 5,
  },
  small: {
    create_story: 5,
    check_readiness: 5,
    dev_red: 10,
    dev_green: 20,
    code_review: 10,
    patch_apply: 10,
    patch_retest: 10,
  },
  medium: {
    create_story: 5,
    check_readiness: 5,
    dev_red: 15,
    dev_green: 30,
    code_review: 15,
    patch_apply: 15,
    patch_retest: 15,
  },
  large: {
    create_story: 10,
    check_readiness: 10,
    dev_red: 30,
    dev_green: 60,
    code_review: 30,
    patch_apply: 30,
    patch_retest: 30,
  },
  legacy: null,
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

// Coerce a per-phase timeout map. Accepts:
//   - null / undefined → use defaults
//   - explicit null in YAML → disable all timeouts (returns null)
//   - {} → disable all timeouts (returns {})
//   - object of {phase: minutes} → merge into defaults, user keys win
// Values must be positive finite numbers; invalid entries are dropped.
function coercePhaseTimeouts(v, defaults) {
  if (v === null) return null;
  if (v === undefined) return defaults ? { ...defaults } : null;
  if (typeof v !== 'object' || Array.isArray(v)) {
    return defaults ? { ...defaults } : null;
  }
  const base = defaults ? { ...defaults } : {};
  for (const [k, raw] of Object.entries(v)) {
    if (raw === null) {
      // Explicit null disables that phase's timeout.
      delete base[k];
      continue;
    }
    const num = typeof raw === 'number' ? raw : Number.parseFloat(raw);
    if (Number.isFinite(num) && num > 0) base[k] = num;
  }
  return base;
}

// Compute land_wait_minutes (default 30) and epic_merge_wait_minutes
// (falls back to land_wait_minutes). Kept as a helper so the fallback
// chain is readable; inlining produced a nested coerceInt call that
// was hard to scan.
function resolveWaitMinutes(resolved) {
  const land = coerceInt(get(resolved, 'git.land_wait_minutes'), 30);
  const epic = coerceInt(get(resolved, 'git.epic_merge_wait_minutes'), land);
  return { land_wait_minutes: land, epic_merge_wait_minutes: epic };
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
    // autopilot.phase_timings — when false, logSkillTiming returns early
    // and the .timings/<story>.jsonl shards stop receiving events. Set
    // false on the `legacy` profile (no parallel coordination, no need
    // for granular timing). Default true on every other profile.
    phase_timings: coerceBool(get(resolved, 'autopilot.phase_timings'), true),
    granularity: coerceEnum(get(resolved, 'git.granularity'), VALID_GRANULARITIES, 'story'),
    worktree_enabled: coerceBool(get(resolved, 'git.worktree.enabled'), true),
    // git.worktree.health_check_on_boot — when true, cmdStart runs
    // scripts/health-check.js once per session and halts if it finds
    // ORPHAN worktrees (left over from crashed sessions). Documented in
    // modules/git/config.yaml ("check for orphaned worktrees from
    // crashed sessions").
    worktree_health_check_on_boot: coerceBool(
      get(resolved, 'git.worktree.health_check_on_boot'),
      true,
    ),
    // git.worktree.cleanup_on_merge — when true, planMergeEpic appends
    // `git worktree prune` + per-directory cleanup steps so .worktrees/
    // doesn't accumulate orphans after an epic merges. Documented in
    // modules/git/config.yaml ("false = keep worktrees after epic
    // completion for inspection").
    worktree_cleanup_on_merge: coerceBool(
      get(resolved, 'git.worktree.cleanup_on_merge'),
      true,
    ),
    squash_on_merge: coerceBool(get(resolved, 'git.squash_on_merge'), false),
    reuse_user_branch: coerceBool(get(resolved, 'git.reuse_user_branch'), false),
    merge_strategy: coerceEnum(
      get(resolved, 'git.merge_strategy'),
      VALID_MERGE_STRATEGIES,
      'stacked',
    ),
    land_when: coerceEnum(get(resolved, 'git.land_when'), VALID_LAND_WHENS, 'ci_pass'),
    ...resolveWaitMinutes(resolved),
    base_branch:
      typeof get(resolved, 'git.base_branch') === 'string'
        ? get(resolved, 'git.base_branch')
        : 'main',
    branch_prefix:
      typeof get(resolved, 'git.branch_prefix') === 'string'
        ? get(resolved, 'git.branch_prefix')
        : 'story/',
    // git.enabled — when false, every `git_op` action emitted by the
    // state machine is replaced with a `noop` at decorateGitOp time.
    // Used for evaluation / dry-run setups where the user wants the
    // BMad cycle to run but doesn't want any commits / pushes / PRs.
    enabled: coerceBool(get(resolved, 'git.enabled'), true),
    // git.push.auto — when false, planCommitAndPush drops the push
    // steps (both story-branch and base-branch). Branches stay local.
    push_auto: coerceBool(get(resolved, 'git.push.auto'), true),
    // git.push.create_pr — when true (and merge_strategy=stacked),
    // planCommitAndPush appends a `create-pr.js` step after the push so
    // each story branch gets one PR opened automatically. land_as_you_go
    // already opens its own PRs via land.js, so this knob doesn't gate
    // that path.
    push_create_pr: coerceBool(get(resolved, 'git.push.create_pr'), true),
    pr_template_path:
      typeof get(resolved, 'git.push.pr_template') === 'string'
        ? get(resolved, 'git.push.pr_template')
        : null,
    // Commit message templates. Placeholders expanded in git-plan.js:
    //   {story-key}    — state.story_key
    //   {epic}         — state.current_epic (or derived from story_key)
    //   {story-title}  — state.ac_summary or story_key as fallback
    //   {patch-title}  — set on patch commits (bmad-dev-story owns those)
    commit_template_story:
      typeof get(resolved, 'git.commit_templates.story') === 'string'
        ? get(resolved, 'git.commit_templates.story')
        : DEFAULT_COMMIT_TEMPLATE_STORY,
    commit_template_patch:
      typeof get(resolved, 'git.commit_templates.patch') === 'string'
        ? get(resolved, 'git.commit_templates.patch')
        : DEFAULT_COMMIT_TEMPLATE_PATCH,
    // git.max_branch_length — branchName() truncates long branch names
    // (story keys + prefix) to this length with a 6-char hash suffix to
    // keep the name unique. Honors the contract advertised in config.yaml.
    max_branch_length: coerceInt(get(resolved, 'git.max_branch_length'), 60),
    // git.lock.stale_timeout_minutes — .autopilot.lock is auto-taken-over
    // by cmdStart when older than this. Documented in modules/git/config.yaml
    // ("auto-remove locks older than this"). Forwarded to lock.js via
    // --stale-minutes. 0 disables the auto-takeover entirely (locks are
    // never considered stale; manual `autopilot off` required).
    lock_stale_timeout_minutes: coerceInt(get(resolved, 'git.lock.stale_timeout_minutes'), 30),
    // git.lint.* — post-DEV_GREEN lint gate (scripts/post-green-gates.js).
    // verifyDevGreen invokes it when lint_enabled=true; lint_blocking
    // governs whether a failed gate rejects verify or just records.
    // lint_output_limit caps lines of lint output per gate.
    lint_enabled: coerceBool(get(resolved, 'git.lint.enabled'), false),
    lint_blocking: coerceBool(get(resolved, 'git.lint.blocking'), false),
    lint_output_limit: coerceInt(get(resolved, 'git.lint.output_limit'), 100),
    // git.lint.linters — per-language preference map. Forwarded to
    // lint-changed.js as --linters-json. Empty list disables a language.
    // javascript + typescript merge into js-ts (shared eslint/biome tooling).
    lint_linters: (() => {
      const v = get(resolved, 'git.lint.linters');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    })(),
    // git.platform.provider + base_url — forwarded to create-pr.js when
    // the orchestrator opens or polls PRs. 'auto' delegates platform
    // detection to create-pr.js (currently defaults to github).
    platform_provider: coerceEnum(
      get(resolved, 'git.platform.provider'),
      VALID_PLATFORM_PROVIDERS,
      'auto',
    ),
    platform_base_url:
      typeof get(resolved, 'git.platform.base_url') === 'string'
        ? get(resolved, 'git.platform.base_url')
        : null,
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

    // autopilot.phase_timeout_minutes — v2.4.0 trust bundle.
    //
    // Wall-clock budget per phase. The state machine compares
    // `state.phase_started_at` to `now` on every action emission and
    // halts with `reason: 'phase_timeout_exceeded'` when the active
    // phase has been running longer than its budget. Catches silent
    // multi-hour DEV_GREEN hangs that v2.3.x had no recourse for.
    //
    // Keys match STATES.* values (dev_red, dev_green, code_review,
    // patch_apply, patch_retest, nano_quick_dev, create_story,
    // check_readiness). Phases not in the map are unbudgeted.
    //
    // Defaults scale with profile: nano short (15min quick-dev),
    // medium pragmatic (30min dev_green), large generous (60min
    // dev_green). Legacy keeps timeouts disabled to preserve v1.0.5
    // semantics byte-for-byte.
    //
    // YAML examples:
    //   autopilot.phase_timeout_minutes: null      # disable all timeouts
    //   autopilot.phase_timeout_minutes: {}        # disable all timeouts
    //   autopilot.phase_timeout_minutes:
    //     dev_green: 45                            # override one phase
    //     dev_red: null                            # disable one phase
    phase_timeout_minutes: coercePhaseTimeouts(
      get(resolved, 'autopilot.phase_timeout_minutes'),
      PHASE_TIMEOUT_DEFAULTS_BY_PROFILE[name],
    ),

    // autopilot.resume_mid_skill — v2.6.0. When true, cmdStart inspects
    // the ledger on boot and, if a skill invocation was emitted but
    // never reached a terminal signal (success / failure-prompt /
    // halt), builds a structured `resume_hint` from observable state
    // (git diff on the story branch since phase_started_at, story file
    // AC checkboxes, last test result, patch_commits, last
    // skill_checkpoint) and threads it into the next invoke_skill
    // action's template_slots. Skills that don't know about resume_hint
    // ignore it; skills that do can use it to skip already-done work.
    //
    // Default: true on every profile. Legacy v1.0.5 sessions were
    // crash-restart-from-scratch by design; v2.6.0 brings them in line
    // with the rest of the trust bundle (v2.4.0 budgets, v2.4.0 halt
    // context, v2.5.0 observability). Set to false to preserve the
    // pre-v2.6.0 behaviour for a session.
    resume_mid_skill: coerceBool(get(resolved, 'autopilot.resume_mid_skill'), true),

    // testing.* — tiered test scope (v2.3.18+).
    //
    // The autopilot computes a recommended test command per DEV_RED /
    // DEV_GREEN / PATCH_RETEST / NANO_QUICK_DEV emission and threads it
    // into the dev-story template via the `recommended_test_command`
    // slot. The LLM runs that command instead of the project's
    // default `npm test`. Full regression is still gated by CI (or
    // optionally a local background run) before merge.
    //
    // Knobs:
    //   testing.scope: 'affected' | 'full'
    //     Default: 'affected'. The pre-2.3.18 behavior is `full`; users
    //     who want to keep that explicit can set it.
    //   testing.fallback: 'full' | 'directory' | 'halt'
    //     What to do when affected-detection fails (no adapter, no diff,
    //     no story-authored test_files). 'full' is the safe default;
    //     'halt' surfaces the issue to the user_prompt path.
    //   testing.full_suite_on_story_land: 'ci' | 'background' | 'skip'
    //     Where the safety-net full suite runs. 'ci' (default) trusts
    //     gh pr checks. 'background' spawns the full command after
    //     STORY_DONE and blocks the next story on failure. 'skip' is
    //     speed-over-safety — only for prototyping.
    //   testing.commands.affected / testing.commands.full
    //     Optional user overrides; when set, replace adapter-built
    //     commands verbatim. Useful for monorepos with custom test
    //     orchestration (nx, turbo, lerna, etc.).
    testing_scope: coerceEnum(
      get(resolved, 'testing.scope'),
      VALID_TESTING_SCOPES,
      'affected',
    ),
    testing_fallback: coerceEnum(
      get(resolved, 'testing.fallback'),
      VALID_TESTING_FALLBACKS,
      'full',
    ),
    testing_full_suite_on_story_land: coerceEnum(
      get(resolved, 'testing.full_suite_on_story_land'),
      VALID_FULL_SUITE_MODES,
      'ci',
    ),
    testing_commands_affected:
      typeof get(resolved, 'testing.commands.affected') === 'string'
        ? get(resolved, 'testing.commands.affected')
        : null,
    testing_commands_full:
      typeof get(resolved, 'testing.commands.full') === 'string'
        ? get(resolved, 'testing.commands.full')
        : null,
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
  VALID_PLATFORM_PROVIDERS,
  DEFAULT_COMMIT_TEMPLATE_STORY,
  DEFAULT_COMMIT_TEMPLATE_PATCH,
  ORCHESTRATOR_DEFAULTS_BY_PROFILE,
  PHASE_TIMEOUT_DEFAULTS_BY_PROFILE,
  flatToProfile,
  escalateOnFailure,
};
