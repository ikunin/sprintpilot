// _Sprintpilot/lib/orchestrator/sprint-plan.js — orchestrator-side
// wrappers around the sprint-plan.js script. This module:
//
//   - knows about autopilot/profile/config concerns (auto_plan_on_start
//     opt-in gate, --no-auto-plan CLI flag);
//   - composes the plan-aware story queue from sprint-plan.yaml;
//   - drives one-shot legacy-file migration on first cmdStart;
//   - computes plan staleness for the auto-derive trigger.
//
// It does NOT execute any LLM call; auto-derive emits a `invoke_skill`
// action that the LLM session handles. By design this layer stays
// host-agnostic and unit-testable.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sprintPlanScript = require('../../scripts/sprint-plan.js');

const REPO_BIN = path.join(__dirname, '..', '..', 'scripts');
const INFER_SCRIPT = path.join(REPO_BIN, 'infer-dependencies.js');

// Plan-status values that mean "do not run this story" (queue resolver
// drops these). 'pending' is the only state the autopilot picks up.
const NON_PENDING_PLAN_STATUSES = new Set(['done', 'skipped', 'excluded']);

// Reasons surfaced by planStaleness().
const STALENESS_REASONS = {
  missing: 'missing',
  added_stories: 'added_stories',
  removed_stories: 'removed_stories',
  migration_needed: 'migration_needed',
};

// Path to the legacy dependencies.yaml file (pre-v2.3.0). Used by the
// migration trigger; never read by the live DAG resolver.
function legacyDependenciesPath(projectRoot) {
  return path.join(projectRoot, '_Sprintpilot', 'sprints', 'dependencies.yaml');
}

// ---------------------------------------------------------------
// Reading sprint-status (minimal pull — we only need the keys here)
// ---------------------------------------------------------------

function sprintStatusPath(projectRoot) {
  return path.join(
    projectRoot,
    '_bmad-output',
    'implementation-artifacts',
    'sprint-status.yaml',
  );
}

// Parse story keys (and their bmad status) out of sprint-status.yaml.
// Mirrors the pull logic in resolve-dag.js#readStoriesFromStatus — we
// duplicate here to keep the orchestrator helper independent of the
// strategy layer (which reads from sprint-plan.yaml).
function readSprintStatusKeys(projectRoot) {
  const file = sprintStatusPath(projectRoot);
  if (!fs.existsSync(file)) return { exists: false, ordered: [], byKey: {} };
  const raw = fs.readFileSync(file, 'utf8');
  const ordered = [];
  const byKey = {};
  const lines = raw.split(/\r?\n/);
  let inStories = false;
  let storyIndent = null;
  for (const rawLine of lines) {
    const trimmed = rawLine.trimEnd();
    if (/^(development_status|stories):\s*$/.test(trimmed)) {
      inStories = true;
      storyIndent = null;
      continue;
    }
    if (inStories && /^\S/.test(trimmed)) {
      inStories = false;
      storyIndent = null;
    }
    if (!inStories) continue;
    const m = trimmed.match(/^([\t ]+)([A-Za-z0-9][A-Za-z0-9-]*):\s*(\S+)?/);
    if (!m) continue;
    if (storyIndent === null) storyIndent = m[1];
    else if (m[1] !== storyIndent) continue;
    const status = m[3] ? m[3].replace(/^["']|["']$/g, '') : null;
    if (byKey[m[2]] === undefined) {
      ordered.push(m[2]);
      byKey[m[2]] = { key: m[2], status };
    }
  }
  return { exists: true, ordered, byKey };
}

// ---------------------------------------------------------------
// Staleness detection
// ---------------------------------------------------------------

// Compute whether the current sprint-plan.yaml needs regeneration.
// Returns:
//   { stale: false }                                — plan is fresh OR no plan exists yet
//   { stale: true, reason: 'missing' }              — plan absent AND legacy file absent
//   { stale: true, reason: 'migration_needed' }     — legacy file present, plan absent
//   { stale: true, reason: 'added_stories', missing_keys } — sprint-status has stories not in plan
//   { stale: true, reason: 'removed_stories', removed_keys } — plan stories absent from sprint-status
function planStaleness({ projectRoot }) {
  const planResult = sprintPlanScript.read({ projectRoot });

  // Plan present but corrupt — not "stale" per se; callers handle this
  // via the corrupt-recovery user_prompt. We surface it as a sentinel.
  if (planResult && typeof planResult === 'object' && 'error' in planResult) {
    return { stale: true, reason: 'corrupt', error: planResult.error, message: planResult.message };
  }

  const legacyExists = fs.existsSync(legacyDependenciesPath(projectRoot));

  if (planResult === null) {
    if (legacyExists) {
      return { stale: true, reason: STALENESS_REASONS.migration_needed };
    }
    return { stale: true, reason: STALENESS_REASONS.missing };
  }

  // Plan exists — compare against sprint-status keys.
  const ss = readSprintStatusKeys(projectRoot);
  if (!ss.exists) {
    // No sprint-status to compare against. Plan stands alone.
    return { stale: false };
  }
  const planStoryKeys = new Set(
    (planResult.stories || []).map((s) => s && s.key).filter((k) => typeof k === 'string'),
  );
  const ssSet = new Set(ss.ordered);

  const missingFromPlan = ss.ordered.filter((k) => !planStoryKeys.has(k));
  if (missingFromPlan.length > 0) {
    return {
      stale: true,
      reason: STALENESS_REASONS.added_stories,
      missing_keys: missingFromPlan,
    };
  }
  const removedFromStatus = [...planStoryKeys].filter((k) => !ssSet.has(k));
  if (removedFromStatus.length > 0) {
    return {
      stale: true,
      reason: STALENESS_REASONS.removed_stories,
      removed_keys: removedFromStatus,
    };
  }
  return { stale: false };
}

// ---------------------------------------------------------------
// Migration trigger
// ---------------------------------------------------------------

// One-shot upgrade path: if a legacy `_Sprintpilot/sprints/dependencies.yaml`
// exists, invoke `infer-dependencies.js migrate` to import it into
// sprint-plan.yaml. Idempotent — subsequent calls are no-ops since
// migrate archives the legacy file on success.
//
// Returns the parsed JSON output from migrate, or { skipped: true }
// when no legacy file is present.
function bootstrapMigrationIfNeeded({ projectRoot }) {
  if (!fs.existsSync(legacyDependenciesPath(projectRoot))) {
    return { skipped: true, reason: 'no_legacy_file' };
  }
  const r = spawnSync('node', [INFER_SCRIPT, 'migrate', '--project-root', projectRoot], {
    encoding: 'utf8',
  });
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    parsed = null;
  }
  if (r.status !== 0) {
    return {
      migrated: false,
      reason: 'migrate_failed',
      status: r.status,
      stdout: r.stdout,
      stderr: r.stderr,
      parsed,
    };
  }
  return parsed || { migrated: false, reason: 'unparseable_migrate_output' };
}

// ---------------------------------------------------------------
// Plan-aware queue composition
// ---------------------------------------------------------------

// Build an ordered story queue from sprint-plan.yaml's pending entries.
// Returns null when no usable plan exists (caller falls back to
// sprint-status order). Empty array means plan exists but has no pending
// stories (queue is exhausted).
//
// Ordering: by `priority` ascending. Stories without a priority sink to
// the end in their array-position order.
function composePlanQueue({ projectRoot }) {
  const plan = sprintPlanScript.read({ projectRoot });
  if (plan === null) return null;
  if (plan && typeof plan === 'object' && 'error' in plan) return null;
  if (!Array.isArray(plan.stories) || plan.stories.length === 0) {
    return null; // no curation done yet — fall through to legacy
  }
  const pending = plan.stories.filter(
    (s) => s && s.key && !NON_PENDING_PLAN_STATUSES.has(s.plan_status),
  );
  pending.sort((a, b) => {
    const pa = typeof a.priority === 'number' ? a.priority : Number.MAX_SAFE_INTEGER;
    const pb = typeof b.priority === 'number' ? b.priority : Number.MAX_SAFE_INTEGER;
    return pa - pb;
  });
  return pending.map((s) => s.key);
}

// Detect "plan exhausted" — every entry in plan.stories[] has a terminal
// plan_status (done / skipped / excluded). Returns:
//   { exhausted: true, plan_id, total, terminal_counts }
//   { exhausted: false, reason: '<short tag>' }
// Reasons:
//   - 'no_plan'              — no sprint-plan.yaml on disk
//   - 'corrupt_plan'         — file exists but is unreadable
//   - 'empty_stories'        — plan.stories is [] (skill didn't curate yet)
//   - 'has_pending'          — at least one story has plan_status='pending'
//
// Distinct from `plan_fresh` in shouldAutoDerive: exhaustion means the
// plan WAS curated and every story finished. Caller archives the plan
// and emits a `plan_exhausted` user_prompt halt.
function planExhausted({ projectRoot }) {
  const plan = sprintPlanScript.read({ projectRoot });
  if (plan === null) return { exhausted: false, reason: 'no_plan' };
  if (plan && typeof plan === 'object' && 'error' in plan) {
    return { exhausted: false, reason: 'corrupt_plan' };
  }
  if (!Array.isArray(plan.stories) || plan.stories.length === 0) {
    return { exhausted: false, reason: 'empty_stories' };
  }
  const terminal_counts = { done: 0, skipped: 0, excluded: 0 };
  let hasPending = false;
  for (const s of plan.stories) {
    if (!s || !s.key) continue;
    if (s.plan_status === 'pending') {
      hasPending = true;
      break;
    }
    if (s.plan_status in terminal_counts) {
      terminal_counts[s.plan_status] += 1;
    }
  }
  if (hasPending) return { exhausted: false, reason: 'has_pending' };
  return {
    exhausted: true,
    plan_id: plan.plan_id,
    total: plan.stories.length,
    terminal_counts,
  };
}

// Check whether a persisted current_story is plan-terminal. Returns a
// reason string when the story exists in the plan with terminal
// plan_status, else null. Used by composeRuntimeState reconciliation
// alongside the existing sprint-status-based persistedStoryRejectionReason.
//
// Distinct from refreshBmadStatus's eager transition — that flow runs
// for stories whose BMAD status is terminal. This handles the case
// where the USER manually marked plan_status='skipped' / 'excluded' but
// sprint-status hasn't caught up yet.
function planRejectionReason(story_key, { projectRoot }) {
  if (typeof story_key !== 'string' || !story_key) return null;
  const plan = sprintPlanScript.read({ projectRoot });
  if (plan === null) return null;
  if (plan && typeof plan === 'object' && 'error' in plan) return null;
  if (!Array.isArray(plan.stories)) return null;
  const entry = plan.stories.find((s) => s && s.key === story_key);
  if (!entry) return null;
  if (entry.plan_status === 'done') return `sprint-plan.yaml plan_status='done'`;
  if (entry.plan_status === 'skipped') return `sprint-plan.yaml plan_status='skipped'`;
  if (entry.plan_status === 'excluded') return `sprint-plan.yaml plan_status='excluded'`;
  return null;
}

// ---------------------------------------------------------------
// refreshBmadStatus wrapper (best-effort)
// ---------------------------------------------------------------

// Refresh the plan's bmad_status cache from sprint-status.yaml. Returns
// the result envelope from sprint-plan.js#refreshBmadStatus. Failures
// are non-fatal — the caller logs and proceeds. (We never want a stale
// status cache to wedge cmdStart.)
function refreshIfPlanExists({ projectRoot }) {
  try {
    return sprintPlanScript.refreshBmadStatus({ projectRoot });
  } catch (e) {
    return { wrote: false, reason: 'refresh_failed', message: e.message };
  }
}

// ---------------------------------------------------------------
// Auto-derive gating
// ---------------------------------------------------------------

// planCorruptHaltDescriptor({ projectRoot }) — when the live plan file
// fails to parse / validate, build a user_prompt halt descriptor with
// the parser error verbatim so the user can pinpoint the bad line.
// Returns null when the plan is fine. The autopilot CLI consults this
// BEFORE shouldAutoDerive so corrupt files surface as a halt rather
// than silently auto-rebuilding from scratch.
function planCorruptHaltDescriptor({ projectRoot }) {
  const staleness = planStaleness({ projectRoot });
  if (!staleness.stale || staleness.reason !== 'corrupt') return null;
  return {
    reason: 'sprint_plan_corrupt',
    error: staleness.error || 'parse_error',
    message: staleness.message || 'sprint-plan.yaml could not be parsed',
    file: path.join(projectRoot, '_bmad-output', 'implementation-artifacts', 'sprint-plan.yaml'),
  };
}

// Decide whether cmdStart should emit an `invoke_skill` action for
// /sprintpilot-plan-sprint based on:
//   - whether the plan is stale,
//   - whether the user opted into auto-derive (config or env),
//   - whether the user explicitly disabled it via --no-auto-plan,
//   - whether explicit --stories / --epic flags overrode planning.
//
// Returns { auto_derive: bool, reason: '<short tag>' }.
function shouldAutoDerive({ projectRoot, profile, opts }) {
  if (opts && opts['no-auto-plan']) {
    return { auto_derive: false, reason: 'no_auto_plan_flag' };
  }
  if (opts && (Array.isArray(opts.stories) ? opts.stories.length > 0 : opts.stories)) {
    return { auto_derive: false, reason: 'explicit_stories_flag' };
  }
  if (opts && opts.epic !== undefined && opts.epic !== null) {
    return { auto_derive: false, reason: 'explicit_epic_flag' };
  }

  const staleness = planStaleness({ projectRoot });
  // Corrupt plan — DO NOT auto-derive. A re-derive via /sprintpilot-plan-sprint
  // would discard the entire existing plan (added_at, plan_status, history,
  // user-added entries) just because of a localized parse error. The autopilot
  // CLI catches this via planCorruptHaltDescriptor and emits a user_prompt
  // with the file path + parser message so the user can fix manually OR
  // explicitly opt into the destructive re-derive.
  if (staleness.stale && staleness.reason === 'corrupt') {
    return {
      auto_derive: false,
      reason: 'plan_corrupt',
      error: staleness.error,
      message: staleness.message,
    };
  }
  // Plan exists and is stale → ALWAYS re-derive (the user already adopted
  // the plan workflow; we keep it fresh). Spread staleness first so the
  // explicit `reason` (with `stale_` prefix) wins.
  if (staleness.stale && staleness.reason !== STALENESS_REASONS.missing &&
      staleness.reason !== STALENESS_REASONS.migration_needed) {
    return { ...staleness, auto_derive: true, reason: `stale_${staleness.reason}` };
  }
  // Plan missing (greenfield) → only auto-derive if user opted in via config.
  // Default config (per user direction) is auto_plan_on_start: false →
  // greenfield runs in sprint-status order without LLM invocation.
  if (staleness.stale && staleness.reason === STALENESS_REASONS.missing) {
    const enabled = profile && profile.auto_plan_on_start === true;
    if (enabled) {
      return { auto_derive: true, reason: 'opt_in_missing' };
    }
    return { auto_derive: false, reason: 'greenfield_default_no_auto_plan' };
  }
  // Migration needed → migrate is NOT auto-derive (no LLM). The migration
  // bootstrap runs separately; if after migration the plan is fresh, no
  // derive needed.
  if (staleness.stale && staleness.reason === STALENESS_REASONS.migration_needed) {
    return { auto_derive: false, reason: 'migration_only' };
  }
  return { auto_derive: false, reason: 'plan_fresh' };
}

// ---------------------------------------------------------------
// DAG validation (Phase 5 — reorder_queue)
// ---------------------------------------------------------------

// Collect transitive upstreams of `story_key` from a plan. Walks both
// plan.dependencies.stories[*].depends_on (intra-epic edges) AND
// plan.cross_epic_deps (cross-boundary edges). Returns a Set of keys
// (excluding the story itself).
function collectUpstreams(story_key, plan) {
  const upstreams = new Set();
  if (!plan || !plan.dependencies || !plan.dependencies.stories) return upstreams;
  const intra = plan.dependencies.stories;
  const cross = Array.isArray(plan.cross_epic_deps) ? plan.cross_epic_deps : [];

  // `visited` tracks which keys we've already walked (to avoid re-walking
  // shared subtrees and to break cycles). `upstreams` is the result Set —
  // we only add a key to it when it's discovered as a real upstream
  // (excluding the starting story_key itself).
  const visited = new Set();
  const visit = (key) => {
    if (visited.has(key)) return;
    visited.add(key);
    const direct = intra[key]?.depends_on;
    if (Array.isArray(direct)) {
      for (const up of direct) {
        if (up !== story_key) {
          upstreams.add(up);
          visit(up);
        }
      }
    }
    // cross_epic_deps semantics: from_story depends on to_story.
    // So an edge with from_story === key adds to_story as upstream.
    for (const edge of cross) {
      if (!edge) continue;
      if (edge.from_story === key && typeof edge.to_story === 'string') {
        const up = edge.to_story;
        if (up !== story_key) {
          upstreams.add(up);
          visit(up);
        }
      }
    }
  };

  visit(story_key);
  return upstreams;
}

// Is a story in a plan-terminal state (done / skipped / excluded)?
function isPlanTerminal(story_key, plan) {
  if (!plan || !Array.isArray(plan.stories)) return false;
  const entry = plan.stories.find((s) => s && s.key === story_key);
  if (!entry) return false;
  return entry.plan_status === 'done' || entry.plan_status === 'skipped' || entry.plan_status === 'excluded';
}

// Is a story terminal in sprint-status.yaml (done/skipped/wont_do/etc)?
function isTerminalInSprintStatus(story_key, projectRoot) {
  const ss = readSprintStatusKeys(projectRoot);
  if (!ss.exists) return false;
  const entry = ss.byKey[story_key];
  if (!entry) return false;
  const TERMINAL = new Set([
    'done',
    'skipped',
    'wont_do',
    "won't_do",
    'cancelled',
    'canceled',
    'deferred',
    'abandoned',
  ]);
  return entry.status ? TERMINAL.has(String(entry.status).toLowerCase()) : false;
}

// Validate a proposed reorder against the plan's DAG. For each story in
// `proposedOrder`, every transitive upstream must be either:
//   - positioned BEFORE the story in proposedOrder, OR
//   - plan-terminal (done/skipped/excluded), OR
//   - terminal in sprint-status.yaml.
// Returns { valid: bool, violations: [{story, upstream, suggestion}] }.
// Each violation includes a suggestion ("insert <upstream> before <story>")
// so the user_prompt can guide the user.
function validateOrdering(proposedOrder, plan, { projectRoot } = {}) {
  if (!Array.isArray(proposedOrder)) {
    return { valid: false, violations: [{ reason: 'order must be an array' }] };
  }
  const indexOf = Object.create(null);
  for (let i = 0; i < proposedOrder.length; i++) {
    indexOf[proposedOrder[i]] = i;
  }
  const violations = [];
  for (const story of proposedOrder) {
    const ups = collectUpstreams(story, plan);
    for (const up of ups) {
      const planTerminal = isPlanTerminal(up, plan);
      const ssTerminal = projectRoot ? isTerminalInSprintStatus(up, projectRoot) : false;
      const positionedBefore = up in indexOf && indexOf[up] < indexOf[story];
      if (!planTerminal && !ssTerminal && !positionedBefore) {
        violations.push({
          story,
          upstream: up,
          suggestion: `insert ${up} before ${story}`,
        });
      }
    }
  }
  return { valid: violations.length === 0, violations };
}

// ---------------------------------------------------------------
// Sentinel file for the first-time auto-plan prompt (Phase 3 stub).
// The full sentinel UX lives in Phase 4.5 wiring; this module exposes
// just the path so cmdStart can probe it.
// ---------------------------------------------------------------

function autoPlanFirstSeenSentinelPath(projectRoot) {
  return path.join(projectRoot, '.sprintpilot', '.auto-plan-first-seen');
}

module.exports = {
  NON_PENDING_PLAN_STATUSES,
  STALENESS_REASONS,
  planCorruptHaltDescriptor,
  legacyDependenciesPath,
  sprintStatusPath,
  readSprintStatusKeys,
  planStaleness,
  bootstrapMigrationIfNeeded,
  composePlanQueue,
  refreshIfPlanExists,
  shouldAutoDerive,
  planExhausted,
  planRejectionReason,
  collectUpstreams,
  isPlanTerminal,
  isTerminalInSprintStatus,
  validateOrdering,
  autoPlanFirstSeenSentinelPath,
};
