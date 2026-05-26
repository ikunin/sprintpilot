#!/usr/bin/env node

// autopilot.js — orchestrator CLI.
//
// Subcommands:
//   start              Boot a session; emit the first action or resume divergence prompt.
//   next               Emit the next planned action (JSON to stdout).
//   record --signal    Consume a signal (JSON via stdin or --signal-file).
//   state              Print the current orchestrator state (YAML).
//   report             Print a summary of the current session.
//   validate-config    Resolve the active profile + report it.
//   status             One-line status for shell prompts and watch scripts.
//
// Single JSON object on stdout (per subcommand). Logs/warnings on stderr.
// Pure: read state → apply pure functions → write state. State lives in
// _bmad-output/implementation-artifacts/autopilot-state.yaml.
//
// All side effects route through:
//   - state-store.js     (state writes; honors coalesce_state_writes)
//   - action-ledger.js   (append-only audit log)
//   - decision-log.js    (decisions[] audit channel)

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');

const stateMachine = require('../lib/orchestrator/state-machine');
const adapt = require('../lib/orchestrator/adapt');
const profileRules = require('../lib/orchestrator/profile-rules');
const verifyMod = require('../lib/orchestrator/verify');
const stateStore = require('../lib/orchestrator/state-store');
const ledger = require('../lib/orchestrator/action-ledger');
const backgroundSuite = require('../lib/orchestrator/background-suite');
const changeSizeClassifier = require('../lib/orchestrator/change-size-classifier');
const flakyQuarantine = require('../lib/orchestrator/flaky-quarantine');
const haltExplainer = require('../lib/orchestrator/halt-explainer');
const sprintHealth = require('../lib/orchestrator/sprint-health');
const decisionLog = require('../lib/orchestrator/decision-log');
const userCommands = require('../lib/orchestrator/user-commands');
const divergence = require('../lib/orchestrator/divergence');
const reportRenderer = require('../lib/orchestrator/report');
const gitPlan = require('../lib/orchestrator/git-plan');
const land = require('../lib/orchestrator/land');
const testingScope = require('../lib/orchestrator/testing/scope');
const orchSprintPlan = require('../lib/orchestrator/sprint-plan');
const sprintPlanScript = require('../scripts/sprint-plan');
const {
  parseStatuses: parseSprintStatuses,
  remainingFrom: remainingStoriesFrom,
} = require('../scripts/list-remaining-stories');

const { STATES } = stateMachine;

const SUBCOMMANDS = ['start', 'next', 'record', 'state', 'report', 'validate-config', 'status', 'progress', 'heartbeat', 'tasks', 'quarantine', 'watch'];

// v2.3.12 — canonical per-story task list (the BMad 7-step cycle,
// collapsed into operator-visible labels). Used by `autopilot tasks` to
// derive a checkbox view of progress, mirrored into the host coding
// agent's native task tool (Claude Code's TaskCreate, Gemini's TODO,
// etc.) AND auto-written to sprint-tasks.md as a portable fallback.
//
// Each entry maps one user-facing task to the orchestrator phases that
// "satisfy" it: a task counts as done when its terminal phase has been
// recorded as completed in the ledger (or when the current phase is
// past its terminal one).
//
// Order here is execution order — also the rendering order.
const STORY_TASK_DEFINITIONS = [
  { id: 'create_story', label: 'Create story spec', phases: ['create_story'] },
  { id: 'check_readiness', label: 'Check readiness', phases: ['check_readiness'] },
  { id: 'dev_red', label: 'Write failing tests (RED)', phases: ['dev_red'] },
  { id: 'dev_green', label: 'Implement to GREEN', phases: ['dev_green'] },
  { id: 'code_review', label: 'Run code review', phases: ['code_review'] },
  { id: 'patch_apply_retest', label: 'Apply review patches + retest', phases: ['patch_apply', 'patch_retest'] },
  { id: 'story_land', label: 'Land story (commit, push, merge)', phases: ['story_done', 'story_land'] },
];

// Total ordered list of phases for "which phase is past which". Used to
// classify tasks as completed when the current phase has moved beyond
// their terminal phase.
const STORY_PHASE_ORDER = [
  'prepare_story_branch',
  'create_story',
  'check_readiness',
  'dev_red',
  'dev_green',
  'code_review',
  'patch_apply',
  'patch_retest',
  'story_done',
  'story_land',
];

function phaseOrderIndex(phase) {
  if (!phase) return -1;
  const i = STORY_PHASE_ORDER.indexOf(phase);
  return i < 0 ? -1 : i;
}

function help() {
  log.out(
    [
      'Usage:',
      '  autopilot start              Boot/resume the session',
      '  autopilot next               Emit the next planned action (JSON)',
      '  autopilot record --signal <json> | --signal-file <path>',
      '  autopilot state              Print current state (YAML)',
      '  autopilot report             Session report (markdown)',
      '  autopilot validate-config    Resolve + print active profile',
      '  autopilot status             One-line status',
      '  autopilot quarantine list|add <id>|eject <id>',
      '                               Inspect/manage flaky-test quarantine',
      '  autopilot watch [--once] [--no-tui]',
      '                               Live ledger tail: status header +',
      '                               recent events, re-rendered on each',
      '                               new ledger entry. `--once` for one',
      '                               render; `--no-tui` for plain output.',
      '',
      'Global flags:',
      '  --project-root <path>        Default: CWD',
      '  --profile <nano|small|medium|large|legacy>',
      '                               Override resolved profile',
      '  --help                       Show this help',
      '',
      'Story-selection flags (on `start` only):',
      '  --stories <k1,k2,...>        Explicit queue of story keys to run, in',
      '                               order. Keys must exist in sprint-status.yaml',
      '                               and not be already done. Once the queue',
      '                               exhausts, the orchestrator falls back to',
      '                               its normal next-pending-story flow.',
      '  --epic <id>                  Queue all non-done stories of the given',
      '                               epic (id matches `epic-N` or bare `N`),',
      '                               in sprint-status.yaml order. --stories',
      '                               takes priority when both are given.',
      '  --force                      Overwrite an in-flight queue. Without',
      '                               this, --stories/--epic refuses to run',
      '                               when current_story is set or a queue',
      '                               already exists.',
      '',
      'Natural-language entry: `/sprint-autopilot-on epic 4` /',
      '`/sprint-autopilot-on stories 3.1, 4.5` — the skill resolves the NL',
      'directive to canonical keys and invokes `autopilot start --stories`.',
      '',
      'Test-scope flag (on `next` only):',
      '  --test-scope <affected|full> Force the test scope for this single',
      '                               emission, overriding profile.testing_scope.',
      '                               `affected` runs only the change-impacted',
      '                               tests; `full` runs the project suite.',
    ].join('\n'),
  );
}

// ------------------------------------------------------------ profile + state

function resolveProjectRoot(opts) {
  return path.resolve(opts['project-root'] || process.cwd());
}

// Loads the resolved profile tree by shelling out to resolve-profile.js? No —
// we read the profile YAML files directly via the same logic. To avoid
// duplicating that here, we just `require` it inline. resolve-profile.js
// exports its resolver functions.
function resolveProfile(projectRoot, explicit) {
  const resolver = require('../scripts/resolve-profile.js');
  const r = resolver.resolveProfile(projectRoot, explicit || null);
  const typed = profileRules.flatToProfile(r.resolved, r.profile);
  return { resolved: r.resolved, typed, source: r.source };
}

function loadState(projectRoot) {
  return stateStore.read({ projectRoot });
}

// Existence probe that never throws. Used by composeRuntimeState's
// migration guard so a stale `persisted.story_file_path` from before
// the file was actually written doesn't suppress migration. Returns
// false on any error (path is null/undefined, fs permission, etc.).
function safeExistsSync(p) {
  if (!p || typeof p !== 'string') return false;
  try {
    return fs.existsSync(p);
  } catch (_e) {
    return false;
  }
}

// Resolve the next pending story key from BMad's sprint-status.yaml.
// Used by composeRuntimeState to populate state.story_key BEFORE
// emitting PREPARE_STORY_BRANCH — without this, branchName() falls
// back to "story/unknown" because state.story_key is null on a fresh
// sprint (CREATE_STORY hasn't run yet; for nano there's no CREATE_STORY
// at all and quick-dev reads sprint-status itself). Returns the first
// non-done STORY key (filtering out epic rollup headers), or null when:
//   - the status file doesn't exist (pre-planning)
//   - all stories are done (sprint complete)
//   - the file can't be parsed
//   - the only non-done entries are epic rollups (no real stories yet)
function resolveNextStoryKey(projectRoot) {
  if (!projectRoot) return null;
  const sprintStatusPath = path.join(
    projectRoot,
    '_bmad-output',
    'implementation-artifacts',
    'sprint-status.yaml',
  );
  if (!safeExistsSync(sprintStatusPath)) return null;
  try {
    const raw = fs.readFileSync(sprintStatusPath, 'utf8');
    const stories = parseSprintStatuses(raw);
    const remaining = remainingStoriesFrom(stories);
    // parseStatuses returns every key under `development_status:` —
    // including BMad's epic rollup headers (`epic-4: in-progress`).
    // Filter them out so the orchestrator never branches on an epic
    // identifier (which would produce `story/epic-4` instead of
    // `story/4-8-...`).
    const realStories = remaining.filter(looksLikeStoryKey);
    return realStories.length > 0 ? realStories[0] : null;
  } catch (_e) {
    return null;
  }
}

// Validate a persisted current_story key against sprint-status.yaml.
// Returns null when the key is valid (the orchestrator should keep it).
// Returns a short reason string when the key is poisoned or stale (the
// orchestrator should drop it and re-resolve).
//
// NARROW filter (vs looksLikeStoryKey which is strict). Only rejects:
//   - `epic-N` shape (epic-rollup header — not a story id)
//   - bare numeric `N` (legacy bare-id epic form)
//   - `*-retrospective` shape
// Accepts everything else as a plausible story key (including short test
// keys like `S1`, `S1.2`, and non-BMad-canonical naming conventions).
// The orchestrator should not nuke valid state just because the key
// doesn't match the strict BMad `<epic>-<story>-<slug>` shape.
//
// Defensive: when sprint-status can't be read, returns null so the
// orchestrator preserves persisted value. The user shouldn't have their
// session reset just because the artifact is missing.
function persistedStoryRejectionReason(key, projectRoot) {
  if (typeof key !== 'string' || !key) return 'not a string';
  if (isObviouslyEpicHeader(key)) {
    return 'matches epic-rollup header shape (epic-N or bare N) — not a story id';
  }
  if (/-retrospective$/i.test(key)) {
    return 'matches retrospective entry shape — not a story';
  }
  const stories = readSprintStatuses(projectRoot);
  if (!stories) return null; // sprint-status absent → defer to caller; don't reject.
  if (!Object.prototype.hasOwnProperty.call(stories, key)) {
    return 'not present in sprint-status.yaml';
  }
  const status = String(stories[key].status || '').trim().toLowerCase();
  if (status === 'done') {
    return `sprint-status shows status='done'; story already complete`;
  }
  // v2.3.0 — also reject when the user manually marked plan_status terminal
  // in sprint-plan.yaml but sprint-status hasn't caught up. Returns null
  // when no plan exists (greenfield projects keep existing semantics).
  const planRejection = orchSprintPlan.planRejectionReason(key, { projectRoot });
  if (planRejection) return planRejection;
  return null;
}

// v2.3.0 Phase 4.5 — story-bound phases. When a transition involves any
// of these, emit story_step_started / story_step_completed ledger events
// so `autopilot progress` can render live sub-step status. NANO_QUICK_DEV
// is treated as a single sub-step (the inner Implement/Review/Classify/Commit
// loop happens inside bmad-quick-dev's own machinery).
function isStoryBoundPhase(phase) {
  if (!phase || typeof phase !== 'string') return false;
  return (
    phase === STATES.CHECK_READINESS ||
    phase === STATES.DEV_RED ||
    phase === STATES.DEV_GREEN ||
    phase === STATES.CODE_REVIEW ||
    phase === STATES.PATCH_APPLY ||
    phase === STATES.PATCH_RETEST ||
    phase === STATES.STORY_DONE ||
    phase === STATES.STORY_LAND ||
    phase === STATES.NANO_QUICK_DEV
  );
}

// Emit story_step_started + story_step_completed ledger events when the
// phase changes between two story-bound phases. Also writes the transient
// `current_step` field on the plan story entry so `autopilot progress` can
// render without re-reading the ledger. Best-effort + silent on failure;
// plan-layer issues never block the autopilot cycle.
function emitPhaseTransitionEvents(prevRuntime, newState, projectRoot) {
  const prevPhase = prevRuntime && prevRuntime.phase;
  const nextPhase = newState && newState.phase;
  const story_key = newState && newState.story_key;
  if (!nextPhase) return;
  if (prevPhase === nextPhase) return;

  const prevIsStoryBound = isStoryBoundPhase(prevPhase);
  const nextIsStoryBound = isStoryBoundPhase(nextPhase);
  if (!prevIsStoryBound && !nextIsStoryBound) return;

  try {
    if (prevIsStoryBound && story_key) {
      ledger.append(
        {
          kind: 'story_step_completed',
          detail: { story_key, step_name: prevPhase, outcome: 'success' },
        },
        { projectRoot },
      );
    }
    if (nextIsStoryBound && story_key) {
      ledger.append(
        {
          kind: 'story_step_started',
          detail: { story_key, step_name: nextPhase, started_at: new Date().toISOString() },
        },
        { projectRoot },
      );
    }
  } catch (e) {
    // Ledger failures shouldn't ever wedge — skip silently.
    log.warn(`phase transition ledger emission failed: ${e.message}`);
  }

  // Mirror the phase into plan.stories[].current_step so the renderer
  // doesn't need to re-tail the ledger to know what's running.
  try {
    const planRead = sprintPlanScript.read({ projectRoot });
    if (planRead && !(typeof planRead === 'object' && 'error' in planRead) && story_key) {
      const stepLabel = nextIsStoryBound ? nextPhase : null;
      sprintPlanScript.markRunning(story_key, stepLabel, { projectRoot });
    }
  } catch (_e) {
    // No plan or plan corrupt — fine; renderer will fall back to ledger.
  }
}

// Catch documented poisoned shapes that may appear in persisted.current_story
// (e.g. when sprint-status drift left a stale entry):
//   - `epic-N` with no further hyphen-separated segments (epic rollup
//     header that should never have been written as a story id).
//   - bare numeric `N` (legacy BMad bare-id epic form).
// Does NOT reject short test keys like `S1` / `S1.2` or other non-BMad
// naming conventions — those are valid persisted state.
function isObviouslyEpicHeader(key) {
  if (typeof key !== 'string' || !key) return false;
  if (/^epic-[A-Za-z0-9_]+$/i.test(key)) return true;
  if (/^\d+$/.test(key)) return true;
  return false;
}

// Tell story keys apart from non-story bookkeeping entries in
// sprint-status.yaml. BMad development_status: holds three kinds of
// entries that parseStatuses returns side-by-side:
//
//   1. Real stories — `4-8-realm-wide-matcher` / `epic-1-game-engine`.
//      Always have at least one hyphen AFTER the epic identifier.
//   2. Epic rollup headers — `epic-4` / bare `4`. The status reflects
//      child-story rollup, not a unit of work for the autopilot.
//   3. Retrospective entries — `4-retrospective` / `epic-4-retrospective`.
//      Status tracks whether the per-epic retro ritual has run; not a
//      story to dev.
//
// Reject (2) and (3) so the orchestrator never picks a rollup or
// retrospective entry as the next story (which would produce branches
// like `story/epic-4` or `story/4-retrospective`).
function looksLikeStoryKey(key) {
  if (typeof key !== 'string' || !key) return false;
  // Retrospective entries (`-retrospective` suffix, with or without epic
  // prefix). Match anywhere the suffix appears so `epic-4-retrospective`
  // and `4-retrospective` are both rejected.
  if (/-retrospective$/i.test(key)) return false;
  // Strip any leading `epic-` prefix and require a remaining hyphen.
  // `epic-4` → `4` → no hyphen → epic header (reject).
  // `epic-1-game-engine` → `1-game-engine` → has hyphen → story (accept).
  // `4-8-realm-wide-matcher` → unchanged → has hyphen → story (accept).
  const withoutEpicPrefix = key.replace(/^epic-/i, '');
  return withoutEpicPrefix.includes('-');
}

// Build an explicit story queue from CLI opts (--stories / --epic).
// Returns { queue: [], error?: string }. Either or both flags can be
// provided; --stories is the canonical list and --epic expands to all
// non-done stories under that epic. When both are given, --stories
// takes priority. When neither is given, returns an empty queue
// (orchestrator falls back to resolveNextStoryKey).
//
// Validation:
//   - Every key listed in --stories must exist in sprint-status.yaml.
//   - Every key must NOT have status 'done'.
//   - For --epic, the epic must have at least one non-done story.
function buildExplicitQueueFromOpts(opts, projectRoot) {
  const rawStories = typeof opts.stories === 'string' ? opts.stories : null;
  const rawEpic = opts.epic !== undefined && opts.epic !== null ? String(opts.epic) : null;
  if (!rawStories && !rawEpic) return { queue: [] };

  const sprintStories = readSprintStatuses(projectRoot);
  if (!sprintStories || Object.keys(sprintStories).length === 0) {
    return {
      queue: [],
      error:
        '--stories / --epic given but sprint-status.yaml is missing or empty. ' +
        'Run BMad sprint-planning to populate it before queuing stories.',
    };
  }

  if (rawStories) {
    const requested = rawStories
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (requested.length === 0) {
      return { queue: [], error: '--stories was empty after parsing the comma-separated list.' };
    }
    const missing = [];
    const alreadyDone = [];
    const queue = [];
    for (const key of requested) {
      if (!Object.prototype.hasOwnProperty.call(sprintStories, key)) {
        missing.push(key);
        continue;
      }
      const status = String(sprintStories[key].status || '').trim().toLowerCase();
      if (status === 'done') {
        alreadyDone.push(key);
        continue;
      }
      queue.push(key);
    }
    if (missing.length > 0 || alreadyDone.length > 0) {
      const parts = [];
      if (missing.length > 0) {
        parts.push(
          `not in sprint-status.yaml: ${missing.join(', ')}. ` +
            'Use canonical keys (e.g. 4-8-realm-wide-matcher), not story numbers (e.g. 4.8).',
        );
      }
      if (alreadyDone.length > 0) {
        parts.push(`already done: ${alreadyDone.join(', ')}`);
      }
      return { queue: [], error: `--stories rejected: ${parts.join(' | ')}` };
    }
    return { queue };
  }

  // --epic only
  const expanded = resolveStoriesForEpic(projectRoot, rawEpic);
  if (expanded.length === 0) {
    return {
      queue: [],
      error: `--epic ${rawEpic}: no non-done stories found in sprint-status.yaml`,
    };
  }
  return { queue: expanded };
}

// Read and parse sprint-status.yaml. Returns { stories } where stories
// is a map of {key: {status: string|null}}. Returns null on any failure
// (missing file, parse error). Callers handle null gracefully.
function readSprintStatuses(projectRoot) {
  if (!projectRoot) return null;
  const p = path.join(
    projectRoot,
    '_bmad-output',
    'implementation-artifacts',
    'sprint-status.yaml',
  );
  if (!safeExistsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return parseSprintStatuses(raw);
  } catch (_e) {
    return null;
  }
}

// v2.3.13 — boot-time state reconciliation with BMAD's sprint-status.yaml.
//
// BMAD's sprint-status.yaml is the master record of story progress.
// Whenever the autopilot resumes, the world may have moved on outside
// it: stories merged manually, stories deleted, new stories appended.
// Previously every divergence forced a `resume_divergence` halt and
// required the user to pass `--accept-divergence` — friction that
// turned routine boot into a manual step.
//
// Reconciliation mutates the persisted state in-place so the rest of
// cmdStart sees an already-aligned view. Returns
//
//   { ok: true, actions: Reconciliation[] }   — silent success (may be empty)
//   { ok: false, reason, details }            — cannot reconcile (caller
//                                                falls back to the divergence
//                                                halt path)
//
// Each Reconciliation action is one of:
//   { kind: 'clear_completed_story',    story }
//   { kind: 'clear_unknown_story',      story }
//   { kind: 'prune_completed_from_queue', removed: string[] }
//   { kind: 'skip_clear_unpushed',       story, branch, reason }
//
// Pure-ish: reads sprint-status.yaml, mutates `persisted` fields, and
// returns a diff. No ledger writes, no fingerprint writes — caller owns
// those so reconciliation can be unit-tested without I/O fixtures.
//
// `gitProbe` (optional): { branchForStory(storyKey) => string|null,
// remoteBranchExists(branch) => boolean }. When supplied AND the current
// story's persisted phase is pre-push (i.e., the STORY_DONE / NANO_QUICK_DEV
// commit-and-push hasn't completed yet), this guards the "sprint-status says
// done → clear" path against the regression where the LLM updated
// sprint-status.yaml=done in working tree but the commit was never pushed
// (session interrupted between status edit and `git push`). Without the
// probe, the reconciler silently clears `current_story` and the autopilot
// moves on; the unpushed work is forgotten.
//
// When the probe blocks a clear, emits `skip_clear_unpushed` and leaves
// `persisted.current_story` intact. The caller falls through to the legacy
// fingerprint-divergence path, which will halt the user when sprint-status
// drift can't be auto-acked (or re-fire the STORY_DONE git_op if it can).
const PRE_PUSH_PHASES_FOR_RECONCILE = new Set([
  'prepare_story_branch',
  'create_story',
  'check_readiness',
  'dev_red',
  'dev_green',
  'code_review',
  'patch_apply',
  'patch_retest',
  'story_done',
  'nano_quick_dev',
]);

function reconcileWithSprintStatus({ projectRoot, persisted, gitProbe }) {
  if (!persisted || typeof persisted !== 'object') {
    return { ok: false, reason: 'no_persisted_state' };
  }
  const sprintStatus = readSprintStatuses(projectRoot);
  // Missing or unparseable sprint-status: can't reconcile blind. The
  // caller should fall back to the existing divergence flow (which has
  // its own clearer error messages for the no-baseline case).
  if (!sprintStatus) {
    return { ok: false, reason: 'sprint_status_missing_or_unparseable' };
  }

  const statusOf = (key) => {
    const entry = sprintStatus[key];
    if (!entry) return null;
    return String(entry.status || '').trim().toLowerCase() || null;
  };

  const actions = [];

  // 1. persisted.current_story — clear if it's now done in sprint-status,
  //    or if sprint-status no longer knows about it.
  if (persisted.current_story && typeof persisted.current_story === 'string') {
    const s = statusOf(persisted.current_story);
    if (s === 'done') {
      // Unpushed-work guard: if the persisted phase is pre-push AND the
      // story branch isn't on origin, the LLM marked sprint-status=done
      // without finishing commit/push. Skip the clear so STORY_DONE
      // can re-fire its git_op.
      const phase = persisted.current_bmad_step || null;
      const isPrePush = phase && PRE_PUSH_PHASES_FOR_RECONCILE.has(phase);
      let blocked = null;
      if (isPrePush && gitProbe && typeof gitProbe.branchForStory === 'function' &&
          typeof gitProbe.remoteBranchExists === 'function') {
        const branch = gitProbe.branchForStory(persisted.current_story);
        if (branch && !gitProbe.remoteBranchExists(branch)) {
          blocked = { branch, reason: 'remote_branch_missing' };
        }
      }
      if (blocked) {
        actions.push({
          kind: 'skip_clear_unpushed',
          story: persisted.current_story,
          branch: blocked.branch,
          reason: blocked.reason,
        });
      } else {
        actions.push({ kind: 'clear_completed_story', story: persisted.current_story });
        persisted.current_story = null;
        persisted.story_file_path = null;
        persisted.current_epic = null;
        persisted.current_bmad_step = null;
      }
    } else if (s === null) {
      actions.push({ kind: 'clear_unknown_story', story: persisted.current_story });
      persisted.current_story = null;
      persisted.story_file_path = null;
      persisted.current_epic = null;
      persisted.current_bmad_step = null;
    }
  }

  // 2. persisted.story_queue — drop entries that are now done.
  if (Array.isArray(persisted.story_queue) && persisted.story_queue.length > 0) {
    const removed = [];
    const kept = [];
    for (const key of persisted.story_queue) {
      if (typeof key !== 'string') continue;
      if (statusOf(key) === 'done') removed.push(key);
      else kept.push(key);
    }
    if (removed.length > 0) {
      actions.push({ kind: 'prune_completed_from_queue', removed });
      persisted.story_queue = kept;
    }
  }

  return { ok: true, actions };
}

// Resolve all non-done story keys for the given epic id, in
// sprint-status.yaml insertion order. Used by `autopilot start
// --epic <id>` to expand into an explicit queue. Returns [] when:
//   - sprint-status doesn't exist or fails to parse
//   - no stories match the epic
//   - all matching stories are already done
// Terminal statuses for sprint-status entries — stories in these states
// are NOT counted as "remaining" for epic-done routing. BMad's official
// vocabulary only has `done`, but users frequently need to mark stories
// out-of-scope without lying that they shipped:
//   - skipped / wont_do / cancelled / deferred — explicit user intent
//   - abandoned — alternate spelling seen in the wild
// Any entry in TERMINAL_STATUSES is treated as non-remaining for
// epic-done routing.
const TERMINAL_STATUSES = new Set([
  'done',
  'skipped',
  'wont_do',
  "won't_do",
  'cancelled',
  'canceled',
  'deferred',
  'abandoned',
]);

function resolveStoriesForEpic(projectRoot, epicId) {
  if (!epicId) return [];
  const stories = readSprintStatuses(projectRoot);
  if (!stories) return [];
  const keys = Object.keys(stories);
  const out = [];
  for (const key of keys) {
    if (!looksLikeStoryKey(key)) continue;
    const derivedEpic = deriveEpicFromStoryKey(key);
    if (derivedEpic !== epicId && derivedEpic !== `epic-${epicId}`) continue;
    const status = String(stories[key].status || '').trim().toLowerCase();
    if (TERMINAL_STATUSES.has(status)) continue;
    out.push(key);
  }
  return out;
}

// Derive the epic identifier from a BMad story key. Convention:
// `epic-N-slug` → `epic-N`; `<epic>-<story>-<slug>` → `<epic>`.
// Returns null when the key doesn't parse cleanly. Kept in sync with
// adapt.js#deriveEpicKey; centralized here so composeRuntimeState
// doesn't have to import adapt's private helper.
function deriveEpicFromStoryKey(storyKey) {
  if (typeof storyKey !== 'string' || !storyKey) return null;
  const epicPrefixed = storyKey.match(/^(epic-[A-Za-z0-9_]+)-/);
  if (epicPrefixed) return epicPrefixed[1];
  const firstSeg = storyKey.match(/^([A-Za-z0-9_]+)-/);
  if (firstSeg) return firstSeg[1];
  return null;
}

function persistState(updates, profile, projectRoot, story) {
  return stateStore.write(updates, profile, { projectRoot, story });
}

// Compose the runtime `state` shape the state machine expects from the
// persisted autopilot-state.yaml. Missing fields default to fresh-session
// values; the CLI does not assume more than what's on disk.
//
// `profile` is consulted ONLY to pick the default initial phase when
// `persisted.current_bmad_step` is missing — nano (and any future
// `implementation_flow: quick` profile) boots at NANO_QUICK_DEV so the
// first emitted action is `invoke_skill: bmad-quick-dev`. This applies
// regardless of which CLI entrypoint composed the runtime (workflow.
// orchestrator.md tells the LLM to call `next` directly, bypassing
// cmdStart).
function composeRuntimeState(persisted, profile, projectRoot) {
  // Fresh-sprint initial phase. When git settings require a per-story or
  // per-epic branch (granularity ∈ {story, epic} AND !reuse_user_branch
  // AND git.enabled !== false), boot at PREPARE_STORY_BRANCH so the very
  // first action is a `git_op: create_branch` — the story file is then
  // authored on the story branch rather than on `main`.
  //
  // Skipped when:
  //   - reuse_user_branch: true → cmdStart detects + locks user branch
  //   - enabled: false           → git is disabled entirely; no branch
  //                                to prepare. State machine still emits
  //                                git_ops at STORY_DONE but decorateGitOp
  //                                empties their steps.
  const needsBranchPrep =
    profile &&
    profile.enabled !== false &&
    !profile.reuse_user_branch &&
    (profile.granularity === 'story' || profile.granularity === 'epic');
  const flowStart =
    profile && profile.implementation_flow === 'quick'
      ? STATES.NANO_QUICK_DEV
      : STATES.CREATE_STORY;
  const defaultPhase = needsBranchPrep ? STATES.PREPARE_STORY_BRANCH : flowStart;
  let phase = persisted.current_bmad_step || defaultPhase;

  // Phase enum validation: if persisted state has a garbage phase (typo
  // / manual edit / pre-rename leftover), don't pass it through to
  // nextAction which would throw "unknown phase" with a stack trace.
  // Emit a clear warning and reset to the profile-aware default; the
  // user can re-run after fixing the file or accept the reset.
  const KNOWN_PHASES = new Set(Object.values(STATES));
  if (!KNOWN_PHASES.has(phase)) {
    process.stderr.write(
      `[autopilot] WARN persisted current_bmad_step "${phase}" is not a known phase — resetting to ${defaultPhase}. Edit autopilot-state.yaml or run \`autopilot start\` to override.\n`,
    );
    phase = defaultPhase;
  }

  // Migration: a sprint that was started before PREPARE_STORY_BRANCH
  // shipped will have persisted `current_bmad_step: create_story` (or
  // `nano_quick_dev`) with no story-level state set yet. On upgrade,
  // route those fresh-story-start phases through PREPARE_STORY_BRANCH
  // so the bug we fixed actually applies to existing sprints.
  //
  // Bail out if there's any sign of an in-flight story:
  //   - persisted.current_story set → story_key is being tracked
  //   - persisted.story_file_path set AND the file actually exists →
  //     bmad-create-story already wrote it; we'd lose work by re-routing
  //   - prior_diagnosis / retry_count_this_phase → mid-retry of this phase
  // The file-exists check guards against stale persisted paths (e.g.
  // when `coalesce_state_writes` persisted the field optimistically
  // before the skill ran). Any genuine in-flight marker means mid-cycle.
  const storyFileExists =
    !!persisted.story_file_path && safeExistsSync(persisted.story_file_path);
  const midStorySignals =
    !!persisted.current_story ||
    storyFileExists ||
    !!persisted.prior_diagnosis ||
    (persisted.retry_count_this_phase || 0) > 0;
  if (
    needsBranchPrep &&
    !midStorySignals &&
    (phase === STATES.CREATE_STORY || phase === STATES.NANO_QUICK_DEV)
  ) {
    phase = STATES.PREPARE_STORY_BRANCH;
  }

  // Resolve story_key for PREPARE_STORY_BRANCH. The branch creation step
  // needs a known story_key (and current_epic under granularity=epic) to
  // compute the branch name — without resolution, branchName() falls
  // back to "story/unknown" and we'd push a useless ref to origin.
  //
  // Why this is needed: PREPARE_STORY_BRANCH runs BEFORE CREATE_STORY in
  // the full flow (and NANO_QUICK_DEV picks the story itself in quick
  // flow), so the story_key from persisted state can be null on a fresh
  // sprint. Read sprint-status.yaml — the same source of truth bmad-
  // create-story / bmad-quick-dev use — to look ahead and find the
  // next pending story.
  //
  // If nothing is pending (pre-planning OR sprint complete OR parse
  // failure), fall back to flowStart so the LLM gets a meaningful
  // skill invocation. PREPARE_STORY_BRANCH with no story_key would be
  // a confusing emission to act on.
  // Validate persisted.current_story against sprint-status before
  // trusting it. Persisted state can drift from reality when stories
  // get renamed, deleted, or merged externally between sessions.
  //
  // Treat persisted.current_story as null when:
  //   - it doesn't look like a real story key (epic header, retro, garbage)
  //   - sprint-status.yaml exists but the key isn't in it (deleted/renamed)
  //   - sprint-status shows the key as 'done' (already complete; advancing
  //     past STORY_DONE should have cleared it, so something is stale)
  //
  // Defensive: if sprint-status can't be read, preserve persisted value
  // (don't punish the user for a missing artifact). The warning is on
  // stderr so the user sees what was rejected and why.
  const persistedCurrentStory = persisted.current_story || null;
  let resolvedStoryKey = persistedCurrentStory;
  let resolvedEpic = persisted.current_epic || null;
  let resolvedStoryFilePath = persisted.story_file_path || null;
  if (persistedCurrentStory) {
    const rejection = persistedStoryRejectionReason(
      persistedCurrentStory,
      projectRoot,
    );
    if (rejection) {
      // Phase-aware rejection gate. The "marked done" rejection is NOT
      // a poisoned-state signal when state.phase is a story-bound phase
      // (CHECK_READINESS through STORY_LAND) — at STORY_DONE the story
      // IS expected to be marked done in sprint-status (verifyStoryDone
      // enforces it). Skipping the rejection at those phases avoids
      // nulling story_key mid-record (which would produce branch
      // "story/unknown" on commit_and_push_story).
      //
      // Epic-rollup-header / retrospective / not-in-sprint-status
      // rejections are ALWAYS poison and fire regardless of phase.
      const STORY_BOUND_PHASES = new Set([
        STATES.CHECK_READINESS,
        STATES.DEV_RED,
        STATES.DEV_GREEN,
        STATES.CODE_REVIEW,
        STATES.PATCH_APPLY,
        STATES.PATCH_RETEST,
        STATES.STORY_DONE,
        STATES.STORY_LAND,
      ]);
      const isDoneRejection = /already complete/.test(rejection);
      const skipDoneRejection = isDoneRejection && STORY_BOUND_PHASES.has(phase);
      if (!skipDoneRejection) {
        process.stderr.write(
          `[autopilot] WARN persisted current_story "${persistedCurrentStory}" rejected: ${rejection}. ` +
            'Treating as null and falling through to queue / sprint-status resolution. ' +
            'Next emission will clean it up.\n',
        );
        resolvedStoryKey = null;
        resolvedEpic = null;
        resolvedStoryFilePath = null;
        // When the rejected story was at a phase that REQUIRES a story_key
        // to emit a coherent action, also reset state.phase to flowStart.
        // Otherwise the next emission produces a story-bound action (e.g.,
        // commit_and_push_story) with null story_key → branch resolves to
        // "story/unknown" → execution fails or corrupts the working tree.
        if (STORY_BOUND_PHASES.has(phase)) {
          process.stderr.write(
            `[autopilot] WARN phase was "${phase}" (requires story_key) — resetting to ${flowStart} so next emission re-enters story-start.\n`,
          );
          phase = flowStart;
        }
      }
    }
  }
  // Explicit queue (populated by `autopilot start --stories` / `--epic`)
  // takes priority over the linear resolveNextStoryKey scan: when a
  // user specifies "start with stories 4-1, 4-2, 4-5" we honor that
  // order regardless of what comes first in sprint-status.yaml.
  //
  // Queue consumption is GATED to story-start phases. Without this gate,
  // composeRuntimeState would pull the queue head as runtime.story_key
  // during EPIC_BOUNDARY_CHECK / RETROSPECTIVE / STORY_LAND — phases
  // where the orchestrator isn't starting a new story yet. That would
  // pollute state and (via adapt.advanceState's signal-output
  // propagation) overwrite current_epic with the next story's epic
  // BEFORE retrospective runs.
  //
  // Forward-compat for ma.parallel_stories: the queue is the source
  // multiple workers will pull from when the parallel-batch path is
  // wired into the state machine.
  // Validate persisted.story_queue entries against sprint-status. Same
  // rejection rules as current_story (epic-rollup shape / retrospective
  // / missing from sprint-status / marked done) — applies to every queue
  // member. Without this, a legacy queue persisted by an older
  // orchestrator (or after a sprint-status edit that removed entries)
  // would feed garbage keys to subsequent emissions.
  //
  // Defensive: if sprint-status can't be read, only the shape-based
  // rejections (epic-N, retrospective) apply; presence/status checks
  // are skipped. Same don't-punish-missing-artifact policy as
  // current_story validation.
  const rawPersistedQueue = Array.isArray(persisted.story_queue)
    ? persisted.story_queue.filter((k) => typeof k === 'string' && k.length > 0)
    : [];
  const persistedQueue = [];
  for (const k of rawPersistedQueue) {
    const reason = persistedStoryRejectionReason(k, projectRoot);
    if (reason) {
      process.stderr.write(
        `[autopilot] WARN story_queue entry "${k}" rejected: ${reason}. ` +
          'Dropping from queue.\n',
      );
      continue;
    }
    persistedQueue.push(k);
  }
  const isNewStoryStartPhase =
    phase === STATES.CREATE_STORY ||
    phase === STATES.NANO_QUICK_DEV ||
    phase === STATES.PREPARE_STORY_BRANCH;
  if (isNewStoryStartPhase && !resolvedStoryKey && persistedQueue.length > 0) {
    resolvedStoryKey = persistedQueue[0];
    // Unconditional re-derive: when picking a new story_key, current_epic
    // MUST match. A queue spanning multiple epics (e.g. [4-1, 5-1]) needs
    // to update current_epic when crossing the boundary. The previous
    // story's epic — preserved through EPIC_BOUNDARY_CHECK + RETROSPECTIVE
    // by adapt.advanceState — would otherwise carry over and mislabel
    // commits/branches.
    resolvedEpic = deriveEpicFromStoryKey(resolvedStoryKey) || resolvedEpic;
  }
  if (phase === STATES.PREPARE_STORY_BRANCH && !resolvedStoryKey) {
    const next = resolveNextStoryKey(projectRoot);
    if (next) {
      resolvedStoryKey = next;
      resolvedEpic = deriveEpicFromStoryKey(next) || resolvedEpic;
    } else {
      process.stderr.write(
        `[autopilot] WARN PREPARE_STORY_BRANCH needs a next-story key but sprint-status.yaml has none pending — falling back to ${flowStart}. ` +
          'Run BMad sprint-planning first, or set git.reuse_user_branch=true to commit on the current branch.\n',
      );
      phase = flowStart;
    }
  }

  // Count non-terminal stories in the current epic. state-machine.js's
  // EPIC_BOUNDARY_CHECK reads this to decide between RETROSPECTIVE (end
  // of epic, count === 0) and next-story-start (count > 0). Recomputed
  // from sprint-status.yaml each emission when current_epic is known.
  //
  // Count semantics: excludes any TERMINAL_STATUSES entry (done,
  // skipped, wont_do, cancelled, deferred, abandoned, …) AND non-story
  // entries (epic rollup headers, -retrospective entries) via the same
  // looksLikeStoryKey filter resolveNextStoryKey uses.
  let remainingStoriesInEpic = persisted.remaining_stories_in_epic || 0;
  if (resolvedEpic && projectRoot) {
    const epicStories = resolveStoriesForEpic(projectRoot, resolvedEpic);
    remainingStoriesInEpic = epicStories.length;
  }

  // Catch-all guard: if state.phase REQUIRES a story_key to emit a
  // coherent action AND we still don't have one after every resolution
  // path (queue / validator / sprint-status), reset phase to flowStart.
  //
  // Real-world scenario: persisted state ends up with current_story: null
  // at story_done (e.g. from manual edits or migration). The rejection-
  // branch reset only fires when there's a rejection to fire; a NULL
  // story_key doesn't trigger one. This guard catches that case + any
  // bug class where story_key ends up null at a story-bound phase.
  //
  // The reset is safe: the next emission re-enters story-start (or
  // PREPARE_STORY_BRANCH per the migration rule) and picks the next
  // pending story from queue / sprint-status.
  const STORY_BOUND_PHASES_CATCH_ALL = new Set([
    STATES.CHECK_READINESS,
    STATES.DEV_RED,
    STATES.DEV_GREEN,
    STATES.CODE_REVIEW,
    STATES.PATCH_APPLY,
    STATES.PATCH_RETEST,
    STATES.STORY_DONE,
    STATES.STORY_LAND,
  ]);
  if (!resolvedStoryKey && STORY_BOUND_PHASES_CATCH_ALL.has(phase)) {
    process.stderr.write(
      `[autopilot] WARN phase "${phase}" requires a story_key but none resolved (queue empty, sprint-status lookup didn't fire for this phase). ` +
        `Resetting to ${flowStart} so next emission re-enters story-start.\n`,
    );
    phase = flowStart;
  }

  return {
    phase,
    story_key: resolvedStoryKey,
    story_file_path: resolvedStoryFilePath,
    current_epic: resolvedEpic,
    ac_summary: persisted.ac_summary || null,
    prior_diagnosis: persisted.prior_diagnosis || null,
    relevant_decisions: persisted.relevant_decisions || [],
    prior_signals_summary: persisted.prior_signals_summary || null,
    patch_findings: persisted.patch_findings || null,
    tests_to_rerun: persisted.tests_to_rerun || null,
    remaining_stories_in_epic: remainingStoriesInEpic,
    sprint_is_complete: !!persisted.sprint_is_complete,
    retry_count_this_phase: persisted.retry_count_this_phase || 0,
    verify_reject_count: persisted.verify_reject_count || 0,
    consecutive_test_failures: persisted.consecutive_test_failures || 0,
    escalation_note: persisted.escalation_note || null,
    // Branch reuse: persisted across resumes once detected on first boot.
    user_branch: persisted.user_branch || null,
    // Tiered testing (v2.3.18+): test_scope_hint is set by dev-story
    // signals when the LLM decides the current story is structural and
    // needs a wider test scope. decorateTestScope reads it at the next
    // emission. test_scope_override is the per-emission CLI flag.
    test_scope_hint: persisted.test_scope_hint || null,
    test_scope_override: persisted.test_scope_override || null,
    test_files: Array.isArray(persisted.test_files) ? persisted.test_files : null,
    // Explicit story queue from `autopilot start --stories` / `--epic`.
    // Head is the current pick; adapt.advanceState pops on story
    // completion. Empty array means "no override; use resolveNextStoryKey."
    story_queue: persistedQueue,
    // Land-as-you-go: pending land state survives rebase-conflict halts.
    land_pending: persisted.land_pending || null,
    // Pending alternative (propose_alternative → user_prompt) survives
    // across halts so the next session re-emits the prompt rather than
    // silently dropping the LLM's proposal.
    pending_alternative: persisted.pending_alternative || null,
    // session_story_limit counter: per-session count of stories completed.
    // adapt.advanceState increments on STORY_DONE → EPIC_BOUNDARY_CHECK;
    // state-machine.nextAction emits a halt when this hits profile.session_story_limit.
    // cmdStart resets to 0 on each new session boot (the limit is per-session,
    // not lifetime). Persisted across in-session resumes so a `pause` mid-flow
    // doesn't reset progress against the limit.
    session_stories_completed: persisted.session_stories_completed || 0,
    // v2.4.0 — per-phase wall-clock budget tracking. Stamped by
    // adapt.advanceState on every phase advance; consumed by
    // state-machine.checkPhaseTimeout on each emission. Backfilled here
    // when:
    //   (a) the persisted YAML predates v2.4.0 and has no stamp, OR
    //   (b) composeRuntimeState changed `phase` from the persisted value
    //       (e.g. a phase reset for missing story_key, or a fresh-session
    //       flow start) — the old stamp would track the wrong phase.
    // Either way, we treat "now" as the entry into the resolved phase so
    // the first emission isn't immediately budget-exhausted.
    phase_started_at:
      typeof persisted.phase_started_at === 'string' &&
      persisted.current_bmad_step === phase
        ? persisted.phase_started_at
        : new Date().toISOString(),
    // v2.4.1 — diagnostic mode state. Restored only when the phase
    // matches; a phase reset clears it (the new phase gets a fresh
    // chance at its own diagnostic insertion).
    diagnostic_pending:
      persisted.current_bmad_step === phase && persisted.diagnostic_pending === true,
    diagnostic_completed:
      persisted.current_bmad_step === phase && persisted.diagnostic_completed === true,
    diagnostic_trace:
      persisted.current_bmad_step === phase && typeof persisted.diagnostic_trace === 'string'
        ? persisted.diagnostic_trace
        : null,
    // .autopilot.lock holder ID, persisted so subsequent cmdStart calls
    // recognize their own lock and refresh in place. Cleared by
    // sprint-autopilot-off (which calls `lock.js release`).
    lock_session_id: persisted.lock_session_id || null,
    // halt_requested is intentionally NOT carried forward here: cmdStart
    // clears it on each new session (a `pause` cleanly halts THIS session
    // and the next /sprint-autopilot-on resumes normally).
  };
}

// Persist a runtime state (returned by adapt) back to the autopilot-state.yaml.
function persistRuntimeState(runtime, profile, projectRoot) {
  const updates = {
    current_bmad_step: runtime.phase,
    current_story: runtime.story_key,
    story_file_path: runtime.story_file_path,
    current_epic: runtime.current_epic,
    ac_summary: runtime.ac_summary,
    prior_diagnosis: runtime.prior_diagnosis,
    relevant_decisions: runtime.relevant_decisions,
    prior_signals_summary: runtime.prior_signals_summary,
    patch_findings: runtime.patch_findings,
    tests_to_rerun: runtime.tests_to_rerun,
    remaining_stories_in_epic: runtime.remaining_stories_in_epic,
    sprint_is_complete: runtime.sprint_is_complete,
    retry_count_this_phase: runtime.retry_count_this_phase,
    verify_reject_count: runtime.verify_reject_count,
    consecutive_test_failures: runtime.consecutive_test_failures,
    user_branch: runtime.user_branch,
    story_queue: Array.isArray(runtime.story_queue) ? runtime.story_queue : [],
    land_pending: runtime.land_pending,
    pending_alternative: runtime.pending_alternative || null,
    session_stories_completed: runtime.session_stories_completed || 0,
    lock_session_id: runtime.lock_session_id || null,
    // v2.4.0 — phase wall-clock tracking. See composeRuntimeState comment.
    phase_started_at: runtime.phase_started_at || null,
    // v2.4.1 — diagnostic mode state. Cleared on phase advance by
    // adapt.advanceState. Persisted so a resume mid-cycle doesn't lose
    // the one-shot trigger and re-run the diagnostic on every retry.
    diagnostic_pending: runtime.diagnostic_pending === true,
    diagnostic_completed: runtime.diagnostic_completed === true,
    diagnostic_trace: runtime.diagnostic_trace || null,
  };
  return persistState(updates, profile, projectRoot, runtime.story_key || 'sprint');
}

// Detect the current git branch via plain `git rev-parse`. Returns null
// on any error (not a git repo, command missing, etc.). Pure-ish — uses
// execFileSync so callers control timeout/error policy.
function detectCurrentBranch(projectRoot) {
  try {
    const { execFileSync } = require('node:child_process');
    return execFileSync('git', ['-C', projectRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      timeout: 10_000,
    }).trim();
  } catch (_e) {
    return null;
  }
}

// Probe `git ls-remote --heads origin <branch>` and return true iff the
// branch exists on origin. Used by reconcileWithSprintStatus to detect
// the "sprint-status marked done but commit never pushed" regression
// before silently clearing current_story. Returns false on any error
// (no origin, network failure, etc.) so the guard fails closed: when
// we can't prove the branch is on origin, we don't clear.
function probeRemoteBranchExists(projectRoot, branch) {
  if (!branch || typeof branch !== 'string') return false;
  try {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync(
      'git',
      ['-C', projectRoot, 'ls-remote', '--heads', 'origin', branch],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 },
    );
    // ls-remote prints "<sha>\trefs/heads/<branch>\n" when present, empty otherwise.
    return typeof out === 'string' && out.trim().length > 0;
  } catch (_e) {
    return false;
  }
}

// Emit a per-skill timing event into the legacy .timings/<story>.jsonl
// shards. This is what `observedParallelism()` reads in the e2e tests —
// having the orchestrator emit it removes the LLM-driven coupling and
// makes parallelism observable without LLM cooperation.
//
// Fire-and-forget: never halts the autopilot on failure (matches the
// legacy log-timing convention). Honors `autopilot.phase_timings: false`.
//
// log-timing.js validates `--story` against `/^[a-z0-9][a-z0-9-]*$/` so
// BMad-style keys like 'S1' or 'S1.2' must be sanitized first.
function sanitizeStoryForTiming(key) {
  if (typeof key !== 'string') return 'sprint';
  const lowered = key.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  return /^[a-z0-9][a-z0-9-]*$/.test(lowered) ? lowered : 'sprint';
}

function logSkillTiming(projectRoot, event, story, skillName, profile) {
  if (profile && profile.phase_timings === false) return;
  if (!skillName || !story) return;
  const scriptPath = path.join(projectRoot, '_Sprintpilot', 'scripts', 'log-timing.js');
  if (!fs.existsSync(scriptPath)) return;
  const safeStory = sanitizeStoryForTiming(story);
  try {
    const { execFileSync } = require('node:child_process');
    execFileSync(
      'node',
      [
        scriptPath,
        event,
        '--story',
        safeStory,
        '--phase',
        `skill.${skillName}`,
        '--project-root',
        projectRoot,
      ],
      { stdio: 'ignore', timeout: 5_000 },
    );
  } catch (_e) {
    // Advisory only — timing logger is fire-and-forget per the legacy contract.
  }
}

// git_op actions carry an abstract `op` (e.g. commit_and_push_story).
// Inline the planned argv steps from git-plan.js so the LLM doesn't have
// to interpret the op — it just executes `action.steps` in order.
// Without this, live-LLM sessions silently skip `git push` after STORY_DONE.
// v2.4.0 — Self-explaining halts. When the orchestrator emits a
// user_prompt action (verify_rejected, retry_budget_exhausted,
// phase_timeout_exceeded, etc.), thread in a `context` object carrying:
//   - recent_actions: last 3 invoke_skill/git_op/run_script entries
//   - verifier_check: most recent failed verify_result (when applicable)
//   - elapsed_in_phase: state.phase_started_at vs now
//   - similar_halt: prior halt with the same (phase, reason)
// Replaces the v2.3.x cryptic "verify_rejected: test_files…" prompts
// that forced the user to spelunk the ledger to diagnose anything.
// Falls back to the bare action on any read failure — pure additive.
function decorateHaltContext(action, state, projectRoot) {
  if (!action || action.type !== 'user_prompt') return action;
  try {
    const entries = ledger.read({ projectRoot });
    return haltExplainer.enrich(action, { ledgerEntries: entries, state });
  } catch (e) {
    log.warn(`halt-explainer failed (${e.message}); emitting bare prompt`);
    return action;
  }
}

function decorateGitOp(action, state, profile, projectRoot) {
  if (!action || action.type !== 'git_op') return action;
  // git.enabled: false — emit the git_op with an empty step list so the
  // LLM's "execute steps in order" loop trivially succeeds and signals
  // back, advancing the state machine without touching git. A bare
  // `type: noop` would loop here because cmdNext re-emits the same phase
  // until a success signal is recorded.
  if (profile && profile.enabled === false) {
    return {
      ...action,
      branch: null,
      steps: [],
      git_disabled: true,
    };
  }
  try {
    // For create_branch: probe git locally to detect whether the planned
    // branch already exists (resume after partial failure, second story
    // on an epic branch under granularity=epic). The plan uses this to
    // emit `git switch <branch>` (idempotent) instead of `git switch -c`
    // (which would fail on collision). Probe is best-effort — failure
    // leaves branch_exists false and the plan defaults to the create
    // path (the safer default for fresh stories).
    // Threading project_root onto the state so pure-ish helpers in
    // git-plan.js can load files (pr_template_path) without taking it
    // as a separate arg. The plan itself is still deterministic given
    // the same inputs.
    let enrichedState = { ...state, project_root: projectRoot || process.cwd() };
    if (action.op === 'create_branch') {
      const branch = gitPlan.branchName(profile, state.story_key, state.current_epic, state);
      const branchExists = probeBranchExists(enrichedState.project_root, branch);
      enrichedState = { ...enrichedState, branch_exists: branchExists };
    }
    const planned = gitPlan.plan(enrichedState, profile, action);
    // Surface plan-level warnings (e.g. pr_template_path not found) via
    // the orchestrator's stderr so the LLM context sees them, without
    // git-plan.js itself writing to stderr from a pure-ish function.
    if (Array.isArray(planned.warnings)) {
      for (const w of planned.warnings) {
        process.stderr.write(`[git-plan] WARN: ${w}\n`);
      }
    }
    // Some plans (e.g. epic merge on unsupported platforms) return a
    // `halt_action` field instead of executable steps. Convert it into
    // a top-level user_prompt action so the orchestrator pauses instead
    // of silently running zero steps and advancing.
    if (planned.halt_action) {
      return { ...planned.halt_action, phase: action.phase };
    }
    return { ...action, branch: planned.branch, steps: planned.steps };
  } catch (e) {
    log.warn(`git-plan failed for op=${action.op}: ${e.message}`);
    return action;
  }
}

// run_script actions for op=land_story carry only metadata from the
// state machine (helper, land_when, squash_on_merge, ...). The CLI edge
// composes the actual argv via land.js#planLand and inlines it here —
// symmetric to decorateGitOp for git_op actions.
function decorateRunScript(action, state, profile, projectRoot) {
  if (!action || action.type !== 'run_script') return action;
  if (action.op === 'land_story') {
    try {
      const root = projectRoot || process.cwd();
      const scriptsDir = path.join(root, '_Sprintpilot', 'scripts');
      const snapshotPath = path.join(
        root,
        '_bmad-output',
        'implementation-artifacts',
        '.land-snapshots',
        `${state.story_key || 'sprint'}.json`,
      );
      const branch = gitPlan.branchName(profile, state.story_key, state.current_epic, state);
      const platform = profile.platform_provider || 'auto';
      // Compose the PR title + body from the same templates planCommitAndPush
      // uses under stacked mode, so the PR auto-opened by STORY_LAND looks
      // the same as a stacked-mode PR. Build failures are non-fatal — we
      // fall through to planLand's generic defaults so the step still runs.
      let prTitle = null;
      let prBody = null;
      try {
        prTitle = gitPlan.buildStoryCommitMessage(state, profile);
      } catch (_e) {
        /* fall through to planLand default */
      }
      try {
        prBody = gitPlan.buildPrBody(state, profile, root, []);
      } catch (_e) {
        /* fall through to planLand default */
      }
      const planned = land.planLand(state, profile, {
        scriptsDir,
        snapshotPath,
        branch,
        platform,
        platformBaseUrl: profile.platform_base_url || null,
        prTitle,
        prBody,
        projectRoot: root,
      });
      return { ...action, branch: planned.branch, steps: planned.steps };
    } catch (e) {
      log.warn(`land-plan failed for op=${action.op}: ${e.message}`);
      return action;
    }
  }
  if (action.op === 'install_dependencies') {
    const root = projectRoot || process.cwd();
    const steps = planDependencyInstall(root);
    if (steps.length === 0) {
      // No manifest detected — fall back to a no-op success rather than
      // halting the autopilot on an unrecognized project shape. The LLM
      // already had a recoverable blocker; the orchestrator's retry will
      // either succeed (the LLM resolves the dependency another way) or
      // hit the retry budget and prompt.
      return { ...action, steps: [], no_manifest_detected: true };
    }
    return { ...action, steps };
  }
  return action;
}

// v2.4.1 — decorateReviewDepth. Classifies the current change
// (LOC delta + files touched + structural signals like dep version
// bumps, schema/migration paths, barrel-index edits) and threads
// `review_depth` + `recommended_reviewer_count` + `recommended_layers`
// into bmad-code-review's template_slots so trivial changes get a
// single-reviewer pass instead of the full 3-layer suite.
//
// Failure mode: any throw leaves the slots absent, which the
// review skill template interprets as "use the default 3-layer
// review" — current pre-2.4.1 behavior. Pure additive.
function decorateReviewDepth(action, state, profile, projectRoot) {
  if (!action || action.type !== 'invoke_skill') return action;
  if (action.skill !== 'bmad-code-review') return action;
  let classification;
  try {
    classification = changeSizeClassifier.classifyChange({
      projectRoot,
      baseBranch: profile.base_branch || 'main',
    });
  } catch (e) {
    log.warn(`change-size-classifier failed: ${e.message}`);
    return action;
  }
  const routing = changeSizeClassifier.reviewLayersForSize(classification.size);
  const slots = action.template_slots || {};
  const updated = {
    ...slots,
    review_depth: routing.review_depth,
    recommended_reviewer_count: routing.recommended_reviewer_count,
    recommended_review_layers: routing.recommended_layers,
    review_depth_notes: routing.notes,
    extended_edge_case_hunter: routing.extended_edge_case_hunter || false,
    change_size_summary: {
      size: classification.size,
      loc_added: classification.loc_added,
      loc_removed: classification.loc_removed,
      files_touched: classification.files_touched,
      reason: classification.reason,
      structural_signals: classification.structural_signals,
    },
  };
  try {
    ledger.append(
      {
        kind: 'review_depth_decision',
        phase: state.phase,
        detail: {
          size: classification.size,
          reviewer_count: routing.recommended_reviewer_count,
          loc_added: classification.loc_added,
          loc_removed: classification.loc_removed,
          files_touched: classification.files_touched,
          structural_signals: classification.structural_signals,
          reason: classification.reason,
        },
      },
      { projectRoot },
    );
  } catch (_e) {
    /* ledger failure is non-fatal */
  }
  return { ...action, template_slots: updated };
}

// decorateTestScope — fill in the tiered-testing template slots for
// phases where the LLM is about to run tests (DEV_RED / DEV_GREEN /
// PATCH_APPLY / PATCH_RETEST / NANO_QUICK_DEV). The state machine
// emits these slots as null placeholders; we resolve the right scope
// + command here (where we have access to projectRoot + git) so the
// machine stays pure.
//
// Failure mode: any throw inside the resolver leaves the slots null,
// which the dev-story template interprets as "no recommendation,
// run your usual suite." The autopilot doesn't crash on a malformed
// git state.
function decorateTestScope(action, state, profile, projectRoot) {
  if (!action || action.type !== 'invoke_skill') return action;
  if (!state || !stateMachine.isTestPhase(state.phase)) return action;
  // CLI override takes precedence over profile.testing_scope. Threaded
  // via state.test_scope_override at cmdNext/cmdRecord entry.
  const override =
    typeof state.test_scope_override === 'string' ? state.test_scope_override : null;
  const effectiveProfile = override
    ? { ...profile, testing_scope: override }
    : profile;
  // v2.4.0 — load the flaky-test quarantine list once per emission so
  // the adapter can append exclude flags and the template can surface
  // the skipped IDs to the LLM. Failure (missing file, parse error)
  // degrades silently to "no quarantine."
  let quarantinedTests = [];
  try {
    quarantinedTests = flakyQuarantine.listQuarantined(flakyQuarantine.read(projectRoot));
  } catch (_e) {
    quarantinedTests = [];
  }
  let decision;
  try {
    decision = testingScope.resolveTestScope({
      state,
      profile: effectiveProfile,
      projectRoot,
      baseBranch: profile.base_branch || 'main',
      phase: state.phase,
      excludeTestIds: quarantinedTests,
      // v2.4.1 — diagnostic mode flips verbose flags on the recommended
      // command. adapt.js sets state.diagnostic_pending=true between
      // the last retry and user_prompt escalation for test phases.
      verbose: state.diagnostic_pending === true,
    });
  } catch (e) {
    log.warn(`testingScope.resolveTestScope failed: ${e.message}`);
    return action;
  }
  const summary = formatTestScopeSummary(decision);
  const slots = action.template_slots || {};
  const updated = {
    ...slots,
    test_scope: decision.scope,
    recommended_test_command: decision.command,
    test_files_hint: Array.isArray(decision.test_files) && decision.test_files.length
      ? decision.test_files
      : null,
    test_scope_decision_summary: summary,
    test_scope_hint_guidance: TEST_SCOPE_HINT_GUIDANCE,
    // v2.4.0 — tests currently skipped due to flaky-quarantine. Empty
    // array (not null) when none; templates can render
    // `{{quarantined_tests.length}}` cleanly.
    quarantined_tests: Array.isArray(decision.excluded_tests) ? decision.excluded_tests : [],
  };
  // Audit trail. Wrap append in try/catch so a ledger I/O hiccup never
  // blocks the action emission — the slots are still threaded.
  try {
    ledger.append(
      {
        kind: 'test_scope_decision',
        phase: state.phase,
        detail: {
          scope: decision.scope,
          adapter: decision.adapter,
          command: decision.command,
          reason: decision.reason,
          fallback: decision.fallback,
          changed_files_count: Array.isArray(decision.changed_files)
            ? decision.changed_files.length
            : null,
          test_files_count: Array.isArray(decision.test_files)
            ? decision.test_files.length
            : 0,
          override: override || null,
        },
      },
      { projectRoot },
    );
  } catch (_e) {
    /* ledger failure is non-fatal */
  }
  return { ...action, template_slots: updated };
}

const TEST_SCOPE_HINT_GUIDANCE =
  'You may widen the test scope for the NEXT phase by including ' +
  '`test_scope_hint: { scope: "full" }` or `test_scope_hint: { ' +
  'include_dirs: ["src/shared/", "tests/integration/"] }` in your ' +
  'success signal output. Use this when the change is structural ' +
  '(e.g., refactor of a shared util, dependency bump, schema migration, ' +
  'renamed exported symbol) — the per-phase affected detection might ' +
  'miss far-reaching impact in those cases. For ordinary feature work ' +
  'leave the hint out; the orchestrator-supplied recommendation is fine.';

function formatTestScopeSummary(decision) {
  if (!decision) return null;
  const parts = [`scope=${decision.scope}`];
  if (decision.adapter) parts.push(`adapter=${decision.adapter}`);
  if (decision.reason) parts.push(`reason=${decision.reason}`);
  if (decision.fallback) parts.push('fallback=true');
  if (Array.isArray(decision.changed_files)) {
    parts.push(`changed_files=${decision.changed_files.length}`);
  }
  if (Array.isArray(decision.test_files) && decision.test_files.length) {
    parts.push(`test_files=${decision.test_files.length}`);
  }
  return parts.join(' ');
}

// Detect manifest files in the project root and return install steps
// for each language. Returns [] when no manifest is found (caller can
// degrade to a no-op rather than hardcoding npm install).
//
// Order matters: the first match wins for the install. We pick the
// first detected, since most projects are single-language at the root.
// Monorepos with multiple manifests still install for the primary
// (and the LLM can run additional installs via subsequent signals).
function planDependencyInstall(projectRoot) {
  const exists = (rel) => {
    try {
      return fs.existsSync(path.join(projectRoot, rel));
    } catch {
      return false;
    }
  };
  // pnpm / yarn / npm: pick the lockfile that exists; fall back to npm.
  if (exists('package.json')) {
    if (exists('pnpm-lock.yaml')) {
      return [{ args: ['pnpm', 'install', '--frozen-lockfile'], description: 'install pnpm deps' }];
    }
    if (exists('yarn.lock')) {
      return [{ args: ['yarn', 'install', '--frozen-lockfile'], description: 'install yarn deps' }];
    }
    if (exists('bun.lockb')) {
      return [{ args: ['bun', 'install', '--frozen-lockfile'], description: 'install bun deps' }];
    }
    return [{ args: ['npm', 'install'], description: 'install npm deps' }];
  }
  // Python: prefer uv > poetry > pipenv > pip
  if (exists('pyproject.toml')) {
    if (exists('uv.lock')) return [{ args: ['uv', 'sync'], description: 'install python deps via uv' }];
    if (exists('poetry.lock')) {
      return [{ args: ['poetry', 'install'], description: 'install python deps via poetry' }];
    }
    return [{ args: ['pip', 'install', '-e', '.'], description: 'install python project deps' }];
  }
  if (exists('requirements.txt')) {
    return [{ args: ['pip', 'install', '-r', 'requirements.txt'], description: 'install pip requirements' }];
  }
  if (exists('Pipfile')) {
    return [{ args: ['pipenv', 'install'], description: 'install python deps via pipenv' }];
  }
  // Rust
  if (exists('Cargo.toml')) {
    return [{ args: ['cargo', 'fetch'], description: 'fetch rust deps via cargo' }];
  }
  // Go
  if (exists('go.mod')) {
    return [{ args: ['go', 'mod', 'download'], description: 'download go modules' }];
  }
  // Ruby
  if (exists('Gemfile')) {
    return [{ args: ['bundle', 'install'], description: 'install ruby deps via bundler' }];
  }
  // Java / Kotlin
  if (exists('pom.xml')) {
    return [{ args: ['mvn', '-q', 'dependency:resolve'], description: 'resolve maven deps' }];
  }
  if (exists('build.gradle') || exists('build.gradle.kts')) {
    return [{ args: ['./gradlew', '--quiet', 'dependencies'], description: 'resolve gradle deps' }];
  }
  // PHP
  if (exists('composer.json')) {
    return [{ args: ['composer', 'install'], description: 'install composer deps' }];
  }
  // .NET
  if (exists('global.json') || exists('*.csproj')) {
    return [{ args: ['dotnet', 'restore'], description: 'restore dotnet deps' }];
  }
  // Swift
  if (exists('Package.swift')) {
    return [{ args: ['swift', 'package', 'resolve'], description: 'resolve swift packages' }];
  }
  return [];
}

// Detect whether a branch exists, locally OR on origin. Used by
// decorateGitOp so the create_branch plan can degrade to a plain switch
// when the branch is already known. Checking remote refs avoids the
// failure mode where a teammate / prior worktree pushed the branch but
// it's not in our local refs — `git switch -c` would either fail or
// later collide on push. Returns false on any error so the create path
// (the safer default for fresh stories) is selected.
//
// Refreshes the local mirror of the specific remote ref via `git fetch
// origin <branch>` before checking refs/remotes/origin/<branch> — without
// this, a stale local clone can miss a recently-pushed remote branch.
// The fetch is best-effort and capped at 5s.
function probeBranchExists(projectRoot, branch) {
  if (!branch || typeof branch !== 'string') return false;
  const { execFileSync } = require('node:child_process');
  // Local ref?
  try {
    execFileSync(
      'git',
      ['-C', projectRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
      { stdio: 'ignore', timeout: 5_000 },
    );
    return true;
  } catch (_e) {
    /* fall through */
  }
  // Skip the remote-ref dance entirely when there's no origin
  // configured — every emit on a local-only repo would otherwise pay
  // ~5s of fetch timeout for no gain. `git remote get-url origin`
  // exits non-zero (~50ms) when origin is absent.
  try {
    execFileSync('git', ['-C', projectRoot, 'remote', 'get-url', 'origin'], {
      stdio: 'ignore',
      timeout: 2_000,
    });
  } catch (_e) {
    return false; // no origin → no remote ref to check
  }
  // Best-effort: refresh the remote ref before checking. Fetching a
  // specific branch ref is much cheaper than `git fetch origin` (no
  // tag/all-branch traffic) and is silent on a non-existent ref.
  try {
    execFileSync(
      'git',
      ['-C', projectRoot, 'fetch', 'origin', branch, '--quiet', '--no-tags'],
      { stdio: 'ignore', timeout: 5_000 },
    );
  } catch (_e) {
    /* network / branch absent — fall through to local check */
  }
  // Remote ref now (possibly) up to date.
  try {
    execFileSync(
      'git',
      ['-C', projectRoot, 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
      { stdio: 'ignore', timeout: 5_000 },
    );
    return true;
  } catch (_e) {
    return false;
  }
}

// ------------------------------------------------------------ side effects

// v2.3.0 — applySideEffects MAY return a `surfaceFailure` envelope when
// a plan_* side-effect cannot complete (DAG violation, missing keys,
// disk error). cmdRecord uses this to override the emitted nextAction
// with a user_prompt halt so the LLM session sees the failure rather
// than silently moving on. Returns null when no failure needs surfacing.
function applySideEffects(sideEffects, runtime, profile, projectRoot) {
  let surfaceFailure = null;
  // Helper: record a plan-side-effect failure for the caller to surface.
  // First failure wins; subsequent failures are ledgered but not raised
  // (the user can only act on one prompt at a time).
  const recordFailure = (kind, prompt, details) => {
    if (!surfaceFailure) surfaceFailure = { kind, prompt, details };
  };
  for (const eff of sideEffects || []) {
    switch (eff.kind) {
      case 'append_decisions': {
        const validated = decisionLog.validateMany(eff.decisions);
        if (!validated.ok) {
          log.warn(`decisions validation failed: ${JSON.stringify(validated.errors)}`);
        }
        const valid = validated.ok ? validated.decisions : validated.valid;
        if (valid && valid.length > 0) {
          const logPath = path.join(
            projectRoot,
            '_bmad-output',
            'implementation-artifacts',
            'decision-log.yaml',
          );
          const result = decisionLog.append(logPath, valid, {
            story: runtime.story_key || 'sprint',
          });
          ledger.append(
            {
              kind: 'decisions_appended',
              story: runtime.story_key,
              phase: eff.phase,
              ids: result.ids,
            },
            { projectRoot },
          );
        }
        break;
      }
      case 'apply_user_commands': {
        const validated = userCommands.validate(eff.commands);
        ledger.append(
          {
            kind: 'user_commands_applied',
            phase: eff.phase,
            valid: validated.ok,
            commands: eff.commands,
          },
          { projectRoot },
        );
        // adapt.handleUserInput now applies these commands itself (so
        // pause halts on the same turn, accept_alternative dispatches the
        // stored alternative, etc.). This branch is kept purely for the
        // ledger entry — re-applying here would double-mutate state.
        // BMad-owned mutations (e.g. skip_story → sprint-status) still
        // live elsewhere; this CLI never touches sprint-status directly.
        break;
      }
      case 'record_flaky_tests': {
        // v2.4.0 — persist flip counts; auto-quarantine + emit decisions
        // for any tests crossing the threshold this iteration.
        try {
          const before = flakyQuarantine.read(projectRoot);
          let stateNow = before;
          const newlyQuarantined = [];
          for (const testId of eff.tests || []) {
            stateNow = flakyQuarantine.recordFlip(stateNow, {
              testId,
              storyKey: eff.story_key,
            });
            const promoted = flakyQuarantine.promoteToQuarantineMaybe(stateNow, { testId });
            stateNow = promoted.state;
            if (promoted.quarantined) newlyQuarantined.push(testId);
          }
          flakyQuarantine.write(projectRoot, stateNow);
          ledger.append(
            {
              kind: 'state_transition',
              detail: {
                flaky_recorded: eff.tests || [],
                newly_quarantined: newlyQuarantined,
                story_key: eff.story_key,
                phase: eff.phase,
              },
            },
            { projectRoot },
          );
          // Audit each new quarantine in decisions[] per roadmap.
          if (newlyQuarantined.length > 0) {
            const decisionPath = path.join(
              projectRoot,
              '_bmad-output',
              'implementation-artifacts',
              'decision-log.yaml',
            );
            const decisions = newlyQuarantined.map((testId) => ({
              decision: `Auto-quarantined flaky test \`${testId}\``,
              rationale:
                'Flip count crossed the default threshold (3 failure→pass replays across stories). ' +
                'Test is excluded from the recommended command via the adapter; review and either fix or eject via ' +
                '`autopilot quarantine eject <test_id>`.',
              category: 'testing',
              source: 'sprintpilot.flaky-quarantine.v1',
            }));
            try {
              const validated = decisionLog.validateMany(decisions);
              const valid = validated.ok ? validated.decisions : validated.valid;
              if (valid && valid.length > 0) {
                decisionLog.append(decisionPath, valid, {
                  story: eff.story_key || 'sprint',
                });
              }
            } catch (e) {
              log.warn(`flaky-quarantine decision append failed: ${e.message}`);
            }
          }
        } catch (e) {
          log.warn(`record_flaky_tests failed: ${e.message}`);
        }
        break;
      }
      case 'profile_escalated':
      case 'log_alternative_proposed':
      case 'log_verify_rejection':
      case 'log_verify_override': {
        const kind =
          eff.kind === 'profile_escalated'
            ? 'profile_escalated'
            : eff.kind === 'log_alternative_proposed'
              ? 'alternative_proposed'
              : eff.kind === 'log_verify_rejection'
                ? 'verify_rejected'
                : 'verify_override';
        ledger.append({ ...eff, kind }, { projectRoot });
        break;
      }
      case 'plan_reorder': {
        // v2.3.0 — DAG-validated reorder of plan.stories[]. Failures
        // emit a structured ledger entry AND surface a user_prompt halt
        // (via the surfaceFailure return) so the LLM session sees the
        // violation rather than silently moving on. Without this, the
        // user issues `reorder_queue` and gets no feedback when it fails.
        try {
          const planRead = sprintPlanScript.read({ projectRoot });
          if (!planRead || (typeof planRead === 'object' && 'error' in planRead)) {
            ledger.append(
              { kind: 'plan_reorder_failed', reason: 'no_plan_or_corrupt' },
              { projectRoot },
            );
            recordFailure(
              'plan_reorder_failed',
              `reorder_queue rejected: no sprint-plan.yaml exists yet or the file is corrupt. ` +
                `Run /sprintpilot-plan-sprint to build a plan first.`,
              { reason: 'no_plan_or_corrupt' },
            );
            break;
          }
          const validation = orchSprintPlan.validateOrdering(eff.order, planRead, { projectRoot });
          if (!validation.valid) {
            ledger.append(
              { kind: 'plan_reorder_rejected', violations: validation.violations },
              { projectRoot },
            );
            const violationLines = validation.violations
              .slice(0, 5)
              .map((v) => `  - ${v.story} depends on ${v.upstream} (suggestion: ${v.suggestion})`)
              .join('\n');
            recordFailure(
              'plan_reorder_rejected',
              `reorder_queue violates the dependency DAG. Violations:\n${violationLines}` +
                (validation.violations.length > 5 ? `\n  ...and ${validation.violations.length - 5} more` : '') +
                `\n\nResubmit reorder_queue with a corrected order, or use add_to_sprint to bring missing upstreams into the plan first.`,
              { violations: validation.violations },
            );
            break;
          }
          sprintPlanScript.reorder(eff.order, { projectRoot });
          ledger.append(
            { kind: 'plan_reordered', order: eff.order, reason: eff.reason },
            { projectRoot },
          );
        } catch (e) {
          ledger.append(
            { kind: 'plan_reorder_failed', message: e.message },
            { projectRoot },
          );
          recordFailure(
            'plan_reorder_failed',
            `reorder_queue failed: ${e.message}`,
            { message: e.message },
          );
        }
        break;
      }
      case 'plan_add_stories': {
        try {
          // Build entries from story_keys; populate issue_id from optional map.
          const issueMap = eff.issue_ids && typeof eff.issue_ids === 'object' ? eff.issue_ids : {};
          const entries = eff.story_keys.map((key) => ({
            key,
            issue_id: typeof issueMap[key] === 'string' ? issueMap[key] : null,
            added_by: 'user',
          }));
          sprintPlanScript.addStories(entries, { projectRoot, position: eff.position || 'end' });
          ledger.append(
            {
              kind: 'plan_stories_added',
              story_keys: eff.story_keys,
              position: eff.position || 'end',
              reason: eff.reason,
            },
            { projectRoot },
          );
        } catch (e) {
          ledger.append(
            { kind: 'plan_add_stories_failed', message: e.message },
            { projectRoot },
          );
          recordFailure(
            'plan_add_stories_failed',
            `add_to_sprint failed: ${e.message}`,
            { message: e.message, story_keys: eff.story_keys },
          );
        }
        break;
      }
      case 'plan_remove_stories': {
        try {
          sprintPlanScript.removeStories(eff.story_keys, {
            projectRoot,
            status: eff.mark_status || 'skipped',
          });
          ledger.append(
            {
              kind: 'plan_stories_removed',
              story_keys: eff.story_keys,
              mark_status: eff.mark_status || 'skipped',
              reason: eff.reason,
            },
            { projectRoot },
          );
        } catch (e) {
          ledger.append(
            { kind: 'plan_remove_stories_failed', message: e.message },
            { projectRoot },
          );
          recordFailure(
            'plan_remove_stories_failed',
            `remove_from_sprint failed: ${e.message}`,
            { message: e.message, story_keys: eff.story_keys },
          );
        }
        break;
      }
      default:
        // Unknown side-effect kinds are recorded but otherwise ignored.
        ledger.append({ kind: 'state_transition', detail: eff }, { projectRoot });
    }
  }
  return surfaceFailure;
}

// ------------------------------------------------------------ subcommands

// Detect + lock the user's working branch under `reuse_user_branch:
// true`. Returns null if the runtime is already locked, or `{ halt }`
// with a halt/user_prompt action when the environment is invalid. Side-
// effect: mutates `runtime.user_branch` on success and appends a ledger
// entry. Used by both cmdStart and cmdNext so the LLM-direct path
// (workflow.orchestrator.md tells LLMs to call `next` without `start`)
// gets the same enforcement.
function lockUserBranchIfNeeded(runtime, profile, projectRoot) {
  if (!profile.reuse_user_branch || runtime.user_branch) return null;
  const current = detectCurrentBranch(projectRoot);
  const base = profile.base_branch || 'main';
  if (!current) {
    return {
      halt: {
        type: 'halt',
        reason: 'reuse_user_branch_no_git',
        prompt:
          'reuse_user_branch is on but git is not available / no current branch detected. Initialize a git repo and check out the branch you want autopilot to use.',
      },
    };
  }
  if (current === base) {
    return {
      halt: {
        type: 'user_prompt',
        reason: 'reuse_user_branch_on_base',
        prompt: `reuse_user_branch is on but you're on the base branch (${base}). Create + checkout the branch you want autopilot to commit on, then re-run.`,
      },
    };
  }
  runtime.user_branch = current;
  ledger.append(
    { kind: 'state_transition', detail: { user_branch_detected: current } },
    { projectRoot },
  );
  return null;
}

// .autopilot.lock: prevent concurrent autopilot sessions on the same
// project. Lockfile contract documented in modules/git/config.yaml
// ("Lock file (.autopilot.lock — prevents concurrent autopilot sessions)")
// and implemented in scripts/lock.js. cmdStart wires it in here.
//
// Idempotency: a /sprint-autopilot-on mid-flow (e.g. after a halt) must
// not refuse to resume just because the prior cmdStart left a lock. We
// store the lock's session_id in autopilot-state.yaml on first acquire and
// treat a matching id on subsequent cmdStart calls as "my lock; refresh".
//
// Return shape:
//   { acquired: true,  id, refreshed?: true }  — proceed
//   { acquired: false, holder, ageMin }        — halt; caller emits user_prompt
//   { acquired: true,  id, takeover: 'stale' } — stale takeover; proceed
function acquireAutopilotLock(persisted, profile, projectRoot) {
  const { execFileSync: runFile } = require('node:child_process');
  const lockScript = path.join(projectRoot, '_Sprintpilot', 'scripts', 'lock.js');
  if (!fs.existsSync(lockScript)) {
    return { acquired: true, id: null, skipped: true };
  }
  const lockFile = path.join(projectRoot, '.autopilot.lock');
  const stale = typeof profile.lock_stale_timeout_minutes === 'number'
    ? profile.lock_stale_timeout_minutes
    : 30;
  // stale_timeout_minutes <= 0 means "never auto-take-over". Pass a very
  // large value to lock.js so it never deems anything STALE.
  const staleArg = stale > 0 ? String(stale) : '999999';

  const callLock = (action) => {
    try {
      const out = runFile(
        'node',
        [lockScript, action, '--file', lockFile, '--stale-minutes', staleArg],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ).trim();
      return { ok: true, out };
    } catch (e) {
      return { ok: false, out: (e.stdout && e.stdout.toString().trim()) || '', code: e.status };
    }
  };

  const checkResult = callLock('check');
  const checkOut = checkResult.out || 'FREE';

  if (checkOut === 'FREE') {
    const acq = callLock('acquire');
    if (acq.ok && acq.out.startsWith('ACQUIRED:')) {
      return { acquired: true, id: acq.out.slice('ACQUIRED:'.length) };
    }
    // Race: another acquirer just created the lock. Fall through to retry.
  }

  const match = /^(LOCKED|STALE):([^:]+):(\d+)m$/.exec(checkOut);
  if (match) {
    const state = match[1];
    const holderId = match[2];
    const ageMin = parseInt(match[3], 10);

    // My own lock? Refresh (rewrite ts + same id) and proceed.
    if (state === 'LOCKED' && persisted.lock_session_id && persisted.lock_session_id === holderId) {
      try {
        const ts = Math.floor(Date.now() / 1000);
        fs.writeFileSync(lockFile, `${ts}\n${holderId}\n`, { encoding: 'utf8', mode: 0o644 });
        return { acquired: true, id: holderId, refreshed: true };
      } catch (e) {
        return { acquired: false, holder: holderId, ageMin, error: `lock refresh failed: ${e.message}` };
      }
    }

    if (state === 'STALE') {
      const acq = callLock('acquire');
      if (acq.ok && acq.out.startsWith('ACQUIRED_STALE:')) {
        return { acquired: true, id: acq.out.slice('ACQUIRED_STALE:'.length), takeover: 'stale' };
      }
      if (acq.ok && acq.out.startsWith('ACQUIRED:')) {
        return { acquired: true, id: acq.out.slice('ACQUIRED:'.length) };
      }
      const reMatch = /^LOCKED:([^:]+):(\d+)m$/.exec(acq.out);
      if (reMatch) {
        return { acquired: false, holder: reMatch[1], ageMin: parseInt(reMatch[2], 10) };
      }
      return { acquired: false, holder: holderId, ageMin };
    }

    return { acquired: false, holder: holderId, ageMin };
  }

  return { acquired: true, id: null, warning: `unrecognized lock state: ${checkOut}` };
}

// Worktree health check on boot. Documented in modules/git/config.yaml
// as "check for orphaned worktrees from crashed sessions". The script
// (scripts/health-check.js) categorizes worktrees as CLEAN_DONE /
// COMMITTED / STALE / DIRTY / ORPHAN and writes a SUMMARY line.
//
// We treat ORPHAN as halt-worthy (a worktree directory exists but
// `git rev-parse --git-dir` fails or no branch is checked out — almost
// certainly leftover from a crashed session that needs cleanup). DIRTY
// is logged but doesn't halt (user may be actively working in it).
//
// Returns one of:
//   { ok: true, summary }                — no orphans; proceed
//   { ok: false, prompt, orphans, summary } — halt; caller emits user_prompt
//   { ok: true, skipped: true }          — script missing / no worktrees dir / disabled
function runWorktreeHealthCheck(profile, projectRoot) {
  if (!profile.worktree_health_check_on_boot) {
    return { ok: true, skipped: true, reason: 'disabled' };
  }
  if (!profile.worktree_enabled) {
    return { ok: true, skipped: true, reason: 'worktrees_disabled' };
  }
  const script = path.join(projectRoot, '_Sprintpilot', 'scripts', 'health-check.js');
  if (!fs.existsSync(script)) {
    return { ok: true, skipped: true, reason: 'script_missing' };
  }
  const worktreesDir = path.join(projectRoot, '.worktrees');
  if (!fs.existsSync(worktreesDir)) {
    return { ok: true, skipped: true, reason: 'no_worktrees_dir' };
  }

  const { execFileSync: runFile } = require('node:child_process');
  let stdout = '';
  try {
    stdout = runFile(
      'node',
      [
        script,
        '--worktrees-dir',
        worktreesDir,
        '--base-branch',
        profile.base_branch || 'main',
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: projectRoot,
        timeout: 60_000,
      },
    );
  } catch (e) {
    // Health check failure isn't fatal — log and proceed. A broken
    // script shouldn't gate the autopilot.
    return {
      ok: true,
      skipped: true,
      reason: 'health_check_error',
      error: e.message || String(e),
    };
  }

  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const summaryLine = lines.find((l) => l.startsWith('SUMMARY:')) || '';
  // SUMMARY:total:cleanDone:committed:stale:dirty:orphan
  const parts = summaryLine.split(':');
  const summary = {
    total: parseInt(parts[1] || '0', 10),
    clean_done: parseInt(parts[2] || '0', 10),
    committed: parseInt(parts[3] || '0', 10),
    stale: parseInt(parts[4] || '0', 10),
    dirty: parseInt(parts[5] || '0', 10),
    orphan: parseInt(parts[6] || '0', 10),
  };
  const orphans = lines
    .filter((l) => l.startsWith('ORPHAN:'))
    .map((l) => l.slice('ORPHAN:'.length));

  if (summary.orphan > 0) {
    return {
      ok: false,
      summary,
      orphans,
      prompt:
        `Found ${summary.orphan} orphaned worktree(s) under .worktrees/ from a previous (possibly crashed) session: ${orphans.join(', ')}. ` +
        `Run \`git worktree prune\` and remove the leftover directories before resuming, or run \`node _Sprintpilot/scripts/health-check.js --worktrees-dir .worktrees\` to see all categories.`,
    };
  }

  return { ok: true, summary };
}

function cmdStart(opts) {
  const projectRoot = resolveProjectRoot(opts);
  const { typed: profile } = resolveProfile(projectRoot, opts.profile);
  const persisted = loadState(projectRoot);

  // Build an explicit story queue from --stories / --epic flags. The
  // user (or the LLM via /sprint-autopilot-on natural-language args)
  // tells the orchestrator EXACTLY which stories to run, and in what
  // order. Queue head is consumed first; resolveNextStoryKey takes
  // over once the queue exhausts.
  const queueBuildResult = buildExplicitQueueFromOpts(opts, projectRoot);
  if (queueBuildResult.error) {
    log.error(queueBuildResult.error);
    process.stdout.write(
      `${JSON.stringify({ error: queueBuildResult.error, kind: 'queue_validation_error' }, null, 2)}\n`,
    );
    return 2;
  }
  const explicitQueue = queueBuildResult.queue; // may be []

  // Mid-sprint guard: refuse to overwrite an in-flight queue without
  // --force. The user almost certainly wants to finish what's running
  // before pivoting; a silent overwrite would lose state.
  if (
    explicitQueue.length > 0 &&
    (persisted.current_story || (persisted.story_queue || []).length > 0) &&
    !opts.force
  ) {
    const err =
      `Sprint already in progress (current_story=${persisted.current_story || '<queue head>'}). ` +
      `Pass --force to overwrite the queue, or finish the current story first.`;
    log.error(err);
    process.stdout.write(`${JSON.stringify({ error: err, kind: 'mid_sprint_queue_overwrite' }, null, 2)}\n`);
    return 2;
  }

  // Resume detection: if a prior session left a fingerprint, diff.
  // Two escape hatches let cmdStart proceed despite a divergent fingerprint:
  //
  //   1. External completion (auto): if the last halt's `current_story`
  //      is now marked `done` in sprint-status, the divergence is the
  //      EXPECTED result of completing that story outside the autopilot
  //      (manual merge, hot-fix, PR landed via the UI). Clear the
  //      stale story identity from persisted state and proceed —
  //      composeRuntimeState's resolver will pick the next pending story.
  //
  //   2. Explicit --accept-divergence flag: catch-all for cases (1) doesn't
  //      cover (multiple stories completed, branch heads moved, etc.). The
  //      flag is logged into the ledger so the audit trail records that
  //      the user opted in to bypass.
  // v2.3.13 — auto-reconcile with BMAD's sprint-status.yaml.
  //
  // BMAD's sprint-status.yaml is the source of truth for story progress.
  // If stories were completed (or removed) outside the autopilot, the
  // persisted state must yield to sprint-status — no user prompt, no
  // `--accept-divergence` ritual. Reconciliation mutates `persisted`
  // in-place, logs the diff to the ledger as `state_reconciled`, and
  // stamps a fresh fingerprint so the legacy divergence detector below
  // sees nothing to halt on.
  //
  // If sprint-status is missing or unparseable, reconciliation reports
  // `ok: false` and we fall through to the legacy fingerprint divergence
  // path — which produces a clearer "sprint-status missing" error.
  let reconciledThisBoot = false;
  // Only attach the unpushed-work probe when git is actually enabled.
  // Under `git.enabled: false` no commits/pushes happen, so the
  // "verify origin has the branch" check is meaningless and would
  // misfire (no origin → probe returns false → every legitimate clear
  // becomes skip_clear_unpushed). Same logic for reuse_user_branch,
  // where every story commits to the same long-lived user branch and
  // the branch's presence on origin tells us nothing about whether the
  // specific story's commit was pushed.
  const gitProbeEnabled =
    profile && profile.enabled !== false && !profile.reuse_user_branch;
  const reconcileResult = reconcileWithSprintStatus({
    projectRoot,
    persisted,
    gitProbe: gitProbeEnabled
      ? {
          branchForStory: (storyKey) => {
            try {
              return gitPlan.branchName(
                profile,
                storyKey,
                deriveEpicFromStoryKey(storyKey),
                persisted,
              );
            } catch (_e) {
              return null;
            }
          },
          remoteBranchExists: (branch) => probeRemoteBranchExists(projectRoot, branch),
        }
      : undefined,
  });
  if (reconcileResult.ok && reconcileResult.actions.length > 0) {
    ledger.append(
      { kind: 'state_reconciled', detail: { actions: reconcileResult.actions } },
      { projectRoot },
    );
    // `skip_clear_unpushed` records an audit decision but mutates nothing,
    // so it must NOT count as a real reconciliation. If it did, the
    // re-baseline below would mask the very drift we want the legacy
    // divergence detector to catch (sprint-status changed under us while
    // the work wasn't pushed). Only count actions that actually mutated
    // persisted state.
    const mutatedActions = reconcileResult.actions.filter(
      (a) => a && a.kind !== 'skip_clear_unpushed',
    );
    if (mutatedActions.length > 0) {
      // Fresh fingerprint = new baseline. Computed AFTER the state_reconciled
      // and resume appends below to keep the bmadTree hash stable for the
      // next boot. (Computing before would let the very next append shift
      // the tree out from under the stamp.)
      const reconcileFp = divergence.fingerprint({ projectRoot });
      ledger.append(
        {
          kind: 'resume',
          divergence: { kind: 'state_reconciled', actions: mutatedActions },
          fingerprint: reconcileFp,
        },
        { projectRoot },
      );
      reconciledThisBoot = true;
    }
  }

  // Most-recent ledger entry that carries a fingerprint — either the last
  // clean `halt` or a previously-accepted `resume` (which we re-baseline
  // on accept, below). Without the re-baseline, every subsequent
  // `autopilot start` re-detected the same divergence and re-accepted
  // in a loop.
  //
  // v2.3.13: when reconciliation already handled drift this boot, the
  // legacy fingerprint divergence path is skipped entirely. Reconciliation
  // is the authoritative answer for sprint-status drift; running the
  // fingerprint comparator on top would (a) re-stamp redundantly and
  // (b) risk false-positive divergence because ledger appends shift the
  // bmadTree hash mid-flight. The freshly-stamped state_reconciled
  // baseline is the truth subsequent boots see.
  const lastBaseline = reconciledThisBoot
    ? null
    : ledger.lastWithFingerprint({ projectRoot });
  if (lastBaseline && lastBaseline.fingerprint) {
    const d = divergence.detect({ projectRoot }, lastBaseline.fingerprint);
    if (!d.identical) {
      let autoAck = null;
      const persistedStory = persisted.current_story || null;
      if (persistedStory) {
        const stories = readSprintStatuses(projectRoot);
        const status = stories && stories[persistedStory]
          ? String(stories[persistedStory].status || '').trim().toLowerCase()
          : null;
        if (status === 'done') {
          autoAck = { reason: 'external_completion', story: persistedStory };
        }
      }
      const accepted = autoAck || (opts['accept-divergence'] ? { reason: 'explicit_accept' } : null);
      if (!accepted) {
        const result = {
          kind: 'resume_divergence',
          differences: d.differences,
          last_phase: persisted.current_bmad_step || null,
          hint:
            'Pass --accept-divergence to proceed despite the diff, or finish externally-merged stories so sprint-status reflects reality before resuming.',
        };
        ledger.append({ kind: 'resume', divergence: result }, { projectRoot });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
      }
      // Clear the stale story identity before composeRuntimeState runs.
      // Without this the runtime would re-enter the same story (which is
      // now done) and verifyStoryDone would loop on "already complete".
      persisted.current_story = null;
      persisted.story_file_path = null;
      persisted.current_epic = null;
      persisted.current_bmad_step = null;
      // v2.3.9 — re-baseline the fingerprint on the resume entry. The
      // next `autopilot start` reads lastWithFingerprint and sees THIS
      // fresh fingerprint instead of the stale halt one, so the same
      // divergence won't re-fire on every boot.
      const rebaseline = divergence.fingerprint({ projectRoot });
      ledger.append(
        {
          kind: 'resume',
          divergence: {
            kind: 'divergence_accepted',
            ...accepted,
            differences: d.differences,
            last_phase: lastBaseline.phase || null,
          },
          fingerprint: rebaseline,
        },
        { projectRoot },
      );
    }
  }

  // .autopilot.lock — acquire before any state mutation. If another
  // session holds the lock (and it isn't ours and isn't stale), bail out
  // with a user_prompt action so the LLM/user knows to either wait or
  // run `sprint-autopilot-off` in the other session.
  const lockOutcome = acquireAutopilotLock(persisted, profile, projectRoot);
  if (!lockOutcome.acquired) {
    const haltAction = decorateHaltContext(
      {
        type: 'user_prompt',
        phase: persisted.current_bmad_step || null,
        reason: 'autopilot_lock_held',
        prompt:
          `Another autopilot session holds .autopilot.lock (session ${lockOutcome.holder}, age ${lockOutcome.ageMin}m). ` +
          `Wait for it to finish, run \`/sprint-autopilot-off\` in the other session, or delete .autopilot.lock if you're sure the holder crashed.`,
        holder: lockOutcome.holder,
        age_minutes: lockOutcome.ageMin,
      },
      { phase: persisted.current_bmad_step || null, phase_started_at: persisted.phase_started_at || null },
      projectRoot,
    );
    ledger.append(
      { kind: 'action_emitted', phase: persisted.current_bmad_step || null, action: haltAction },
      { projectRoot },
    );
    process.stdout.write(`${JSON.stringify({ action: haltAction, phase: persisted.current_bmad_step || null }, null, 2)}\n`);
    return 0;
  }
  if (lockOutcome.id) {
    persisted.lock_session_id = lockOutcome.id;
    // Eagerly persist lock_session_id so a crash between here and the
    // final persistRuntimeState below doesn't leave the lockfile owned
    // by an ID that nothing knows about. Without this, a mid-cmdStart
    // crash would brick the project until the lock goes stale.
    persistState({ lock_session_id: lockOutcome.id }, profile, projectRoot, 'sprint');
    if (profile.coalesce_state_writes) stateStore.flush(profile, { projectRoot, story: 'sprint' });
    ledger.append(
      {
        kind: 'lock_acquired',
        detail: {
          session_id: lockOutcome.id,
          takeover: lockOutcome.takeover || null,
          refreshed: !!lockOutcome.refreshed,
        },
      },
      { projectRoot },
    );
  }

  // v2.4.0 — background full-suite gate.
  //
  // If the previous session spawned a background full-suite run and it
  // failed (and hasn't been acknowledged), halt this session before any
  // story work begins. The user must investigate the failure and either
  // fix the test or acknowledge the sidecar manually before proceeding.
  // CLI override: `--ack-background-suite` to mark + skip past the halt.
  const ackBackground = !!(opts && opts['ack-background-suite']);
  const prior = backgroundSuite.checkPriorRun(projectRoot, profile);
  if (prior && !ackBackground) {
    const sidecar = prior.sidecar;
    const haltAction = decorateHaltContext(
      {
        type: 'user_prompt',
        phase: persisted.current_bmad_step || null,
        reason: 'background_full_suite_failed',
        prompt:
          `Background full-suite run for story ${sidecar.story_key} exited ` +
          `${sidecar.exit_code} (started ${sidecar.started_at}, completed ${sidecar.completed_at}). ` +
          `Command: ${sidecar.command}\n\n` +
          `Investigate the failing tests, fix or skip them, then re-run \`autopilot start\` ` +
          `(or pass \`--ack-background-suite\` to suppress this halt and continue anyway). ` +
          `Log tail follows:\n\n${prior.log_tail || '(empty)'}`,
        story_key: sidecar.story_key,
        exit_code: sidecar.exit_code,
        command: sidecar.command,
        sidecar_path: sidecar.sidecar_path,
        log_path: sidecar.log_path,
      },
      { phase: persisted.current_bmad_step || null, phase_started_at: persisted.phase_started_at || null },
      projectRoot,
    );
    ledger.append(
      {
        kind: 'action_emitted',
        phase: persisted.current_bmad_step || null,
        action: haltAction,
      },
      { projectRoot },
    );
    process.stdout.write(
      `${JSON.stringify({ action: haltAction, phase: persisted.current_bmad_step || null }, null, 2)}\n`,
    );
    return 0;
  }
  if (prior && ackBackground) {
    backgroundSuite.acknowledgeSidecar(prior.sidecar.sidecar_path);
    ledger.append(
      {
        kind: 'state_transition',
        detail: {
          background_full_suite: 'acknowledged',
          story_key: prior.sidecar.story_key,
          exit_code: prior.sidecar.exit_code,
        },
      },
      { projectRoot },
    );
    log.info(
      `Background full-suite failure for ${prior.sidecar.story_key} acknowledged; continuing.`,
    );
  }

  // parallel_stories: when the flag is set, surface that the BMad state
  // machine emits stories sequentially even though the dispatch-layer
  // building blocks (planBatch, dispatch-layer.js, agent-adapter.js,
  // merge-shards.js) are wired. Without the notice users could assume
  // parallel emission is happening when it isn't.
  if (profile.parallel_stories) {
    ledger.append(
      {
        kind: 'state_transition',
        detail: {
          parallel_stories_notice:
            'ma.parallel_stories=true: the planBatch / dispatch-layer.js building blocks are honored, but the BMad state machine emits one story at a time in this build. Stories run sequentially.',
        },
      },
      { projectRoot },
    );
    process.stderr.write(
      '[autopilot] NOTICE ma.parallel_stories=true honored at the dispatch-layer level; state-machine emission remains sequential in this build.\n',
    );
  }
  if (profile.lint_enabled) {
    // lint_enabled routes verifyDevGreen through post-green-gates.js
    // (lint-changed + lint-test-pitfalls + ci-parity scan). lint_blocking
    // governs whether a failed gate rejects verify or just records.
    ledger.append(
      {
        kind: 'state_transition',
        detail: {
          lint_enabled: true,
          lint_blocking: !!profile.lint_blocking,
        },
      },
      { projectRoot },
    );
  }

  // Worktree health check — once per session, after lock acquire so we
  // don't compete with another active session for the same .worktrees
  // directory.
  const healthOutcome = runWorktreeHealthCheck(profile, projectRoot);
  ledger.append(
    {
      kind: 'worktree_health_check',
      detail: {
        ok: healthOutcome.ok,
        skipped: !!healthOutcome.skipped,
        reason: healthOutcome.reason || null,
        summary: healthOutcome.summary || null,
      },
    },
    { projectRoot },
  );
  if (!healthOutcome.ok) {
    const haltAction = decorateHaltContext(
      {
        type: 'user_prompt',
        phase: persisted.current_bmad_step || null,
        reason: 'worktree_orphans_detected',
        prompt: healthOutcome.prompt,
        orphans: healthOutcome.orphans,
        summary: healthOutcome.summary,
      },
      { phase: persisted.current_bmad_step || null, phase_started_at: persisted.phase_started_at || null },
      projectRoot,
    );
    ledger.append(
      { kind: 'action_emitted', phase: persisted.current_bmad_step || null, action: haltAction },
      { projectRoot },
    );
    process.stdout.write(
      `${JSON.stringify({ action: haltAction, phase: persisted.current_bmad_step || null }, null, 2)}\n`,
    );
    return 0;
  }

  // v2.3.0 — plan-aware integration. Three independent steps, ordered for
  // simplicity:
  //   1. One-shot legacy import: if a pre-v2.3.0 `_Sprintpilot/sprints/dependencies.yaml`
  //      exists, archive + import its content into sprint-plan.yaml.
  //   2. Refresh the plan's bmad_status cache from sprint-status.yaml.
  //      Eagerly transitions terminal stories to plan_status=done so the
  //      queue resolver doesn't pick them. No-op on a fresh plan or when
  //      the diff is empty (Risk #23 disk-thrash mitigation).
  //   3. If no explicit --stories/--epic flags AND a plan with pending
  //      stories exists, hydrate persisted.story_queue from the plan.
  //      composeRuntimeState (below) consumes the queue head as usual —
  //      no changes needed in composeRuntimeState itself.
  //
  // All three are best-effort. Failures emit a ledger event and fall
  // through to the legacy resolveNextStoryKey path; cmdStart never
  // wedges on plan-layer issues.
  try {
    const migration = orchSprintPlan.bootstrapMigrationIfNeeded({ projectRoot });
    if (migration && migration.migrated) {
      ledger.append({ kind: 'plan_migrated', detail: migration }, { projectRoot });
    } else if (migration && migration.reason === 'migrate_failed') {
      ledger.append({ kind: 'plan_migration_failed', detail: migration }, { projectRoot });
    }
  } catch (e) {
    ledger.append({ kind: 'plan_migration_failed', detail: { message: e.message } }, { projectRoot });
  }

  try {
    const refresh = orchSprintPlan.refreshIfPlanExists({ projectRoot });
    if (refresh && refresh.wrote) {
      ledger.append({ kind: 'plan_refreshed', detail: refresh.changed }, { projectRoot });
    }
  } catch (e) {
    ledger.append({ kind: 'plan_refresh_failed', detail: { message: e.message } }, { projectRoot });
  }

  if (explicitQueue.length === 0) {
    try {
      const planQueue = orchSprintPlan.composePlanQueue({ projectRoot });
      if (Array.isArray(planQueue) && planQueue.length > 0) {
        persisted.story_queue = planQueue;
        ledger.append(
          { kind: 'plan_queue_loaded', queue: planQueue.slice(0, 20) },
          { projectRoot },
        );
      }
    } catch (e) {
      ledger.append(
        { kind: 'plan_queue_failed', detail: { message: e.message } },
        { projectRoot },
      );
    }
  }

  // Replan gate (v2.3.0) — user issued `replan_sprint` mid-flight; the
  // previous cmdRecord set state.replan_requested and halted. On the next
  // start, emit the invoke_skill action so the LLM session re-runs
  // /sprintpilot-plan-sprint. Clear the flag once emitted so the request
  // is one-shot.
  if (persisted.replan_requested) {
    const requested = persisted.replan_requested;
    const inviteAction = {
      type: 'invoke_skill',
      skill: 'sprintpilot-plan-sprint',
      template_slots: {
        replan: true,
        reason: requested.reason || 'user_requested',
        requested_at: requested.requested_at || null,
      },
    };
    persisted.replan_requested = null;
    persistState({ replan_requested: null }, profile, projectRoot, 'sprint');
    if (profile.coalesce_state_writes) stateStore.flush(profile, { projectRoot, story: 'sprint' });
    ledger.append(
      { kind: 'replan_requested_consumed', detail: requested },
      { projectRoot },
    );
    ledger.append(
      { kind: 'action_emitted', phase: persisted.current_bmad_step || null, action: inviteAction },
      { projectRoot },
    );
    process.stdout.write(
      `${JSON.stringify({ action: inviteAction, phase: persisted.current_bmad_step || null }, null, 2)}\n`,
    );
    return 0;
  }

  // Plan-exhaustion gate: every plan.stories[] entry is terminal AND the
  // plan was actually curated (stories list is non-empty). Archive the
  // plan and emit a halt asking the user to either re-plan or fall back
  // to sprint-status order. This is distinct from auto-derive: a fresh
  // plan that was just exhausted shouldn't silently slip into picking
  // up other sprint-status stories.
  if (explicitQueue.length === 0) {
    const exhausted = orchSprintPlan.planExhausted({ projectRoot });
    if (exhausted.exhausted) {
      let archived = null;
      try {
        const archiveResult = sprintPlanScript.archive(exhausted.plan_id, { projectRoot });
        archived = archiveResult.archived ? archiveResult.file : null;
      } catch (e) {
        ledger.append(
          { kind: 'plan_archive_failed', detail: { message: e.message } },
          { projectRoot },
        );
      }
      const haltAction = decorateHaltContext(
        {
          type: 'user_prompt',
          phase: persisted.current_bmad_step || null,
          reason: 'plan_exhausted',
          prompt:
            `Sprint plan complete. All ${exhausted.total} planned stories are done ` +
            `(${exhausted.terminal_counts.done} done, ${exhausted.terminal_counts.skipped} skipped, ` +
            `${exhausted.terminal_counts.excluded} excluded). ` +
            'Run /sprintpilot-plan-sprint to build a new plan from remaining sprint-status stories, ' +
            'or run `autopilot start --no-auto-plan` to continue in sprint-status order.',
          plan_id: exhausted.plan_id,
          terminal_counts: exhausted.terminal_counts,
          archived,
        },
        { phase: persisted.current_bmad_step || null, phase_started_at: persisted.phase_started_at || null },
        projectRoot,
      );
      ledger.append(
        { kind: 'plan_exhausted', detail: { ...exhausted, archived } },
        { projectRoot },
      );
      ledger.append(
        { kind: 'action_emitted', phase: persisted.current_bmad_step || null, action: haltAction },
        { projectRoot },
      );
      process.stdout.write(
        `${JSON.stringify({ action: haltAction, phase: persisted.current_bmad_step || null }, null, 2)}\n`,
      );
      return 0;
    }
  }

  // v2.5.1 — corrupt sprint-plan.yaml halt. When the live plan file
  // fails to parse, do NOT auto-rebuild via /sprintpilot-plan-sprint:
  // that destroys the existing curated plan (~150 entries in practice)
  // because of a localized YAML break. Emit a user_prompt with the
  // parser's exact line number and the file path so the user can fix
  // manually OR explicitly opt into the destructive re-derive via
  // `autopilot start --no-auto-plan` + manual /sprintpilot-plan-sprint.
  const corrupt = orchSprintPlan.planCorruptHaltDescriptor({ projectRoot });
  if (corrupt) {
    const haltAction = decorateHaltContext(
      {
        type: 'user_prompt',
        phase: persisted.current_bmad_step || null,
        reason: corrupt.reason,
        prompt:
          `sprint-plan.yaml is corrupt and the autopilot will not auto-rebuild it ` +
          `(doing so would discard the existing curated plan). Parser error:\n\n` +
          `  ${corrupt.message}\n\nFile: ${corrupt.file}\n\n` +
          `Fix the indentation/structure manually, then re-run \`autopilot start\`. ` +
          `If you intend to rebuild from scratch, delete the file and run ` +
          `\`autopilot start\` (greenfield) or run \`/sprintpilot-plan-sprint\` directly.`,
        file: corrupt.file,
        parser_error: corrupt.message,
        parser_error_code: corrupt.error,
      },
      { phase: persisted.current_bmad_step || null, phase_started_at: persisted.phase_started_at || null },
      projectRoot,
    );
    ledger.append(
      { kind: 'action_emitted', phase: persisted.current_bmad_step || null, action: haltAction },
      { projectRoot },
    );
    process.stdout.write(
      `${JSON.stringify({ action: haltAction, phase: persisted.current_bmad_step || null }, null, 2)}\n`,
    );
    return 0;
  }

  // Auto-derive gate: emit an `invoke_skill` action that asks the LLM
  // session to run /sprintpilot-plan-sprint. Only fires when:
  //   - the user opted in via `autopilot.auto_plan_on_start: true` (config), OR
  //   - an existing plan went stale (added_stories / removed_stories).
  // Per user direction the default is OFF for greenfield projects —
  // missing plan falls back to sprint-status execution order.
  const autoDerive = orchSprintPlan.shouldAutoDerive({ projectRoot, profile, opts });
  if (autoDerive.auto_derive) {
    const inviteAction = {
      type: 'invoke_skill',
      skill: 'sprintpilot-plan-sprint',
      template_slots: {
        auto: true,
        reason: autoDerive.reason,
        ...(autoDerive.missing_keys ? { missing_keys: autoDerive.missing_keys } : {}),
        ...(autoDerive.removed_keys ? { removed_keys: autoDerive.removed_keys } : {}),
      },
    };
    ledger.append(
      {
        kind: 'auto_derive_emitted',
        detail: { reason: autoDerive.reason, ...autoDerive },
      },
      { projectRoot },
    );
    ledger.append(
      { kind: 'action_emitted', phase: persisted.current_bmad_step || null, action: inviteAction },
      { projectRoot },
    );
    process.stdout.write(
      `${JSON.stringify({ action: inviteAction, phase: persisted.current_bmad_step || null }, null, 2)}\n`,
    );
    return 0;
  }

  // Persist the new queue BEFORE composing runtime state so the queue
  // head is visible to composeRuntimeState's resolver.
  if (explicitQueue.length > 0) {
    persisted.story_queue = explicitQueue;
    // --force overwrite also clears the prior story identity so the
    // queue head is selected cleanly. Without this, persisted.current_
    // story would short-circuit the queue read.
    if (opts.force) {
      persisted.current_story = null;
      persisted.story_file_path = null;
      persisted.current_epic = null;
      persisted.current_bmad_step = null;
    }
    ledger.append(
      { kind: 'story_queue_set', queue: explicitQueue, force: !!opts.force },
      { projectRoot },
    );
  }

  // Fresh start or clean resume. `composeRuntimeState` applies the
  // profile-aware initial phase when persisted state is empty.
  const runtime = composeRuntimeState(persisted, profile, projectRoot);

  // session_story_limit is per-session — a fresh `autopilot start`
  // resets the counter so the next batch of N stories can run before
  // the next halt. (state-machine.nextAction enforces the cap; adapt.js
  // increments on STORY_DONE → EPIC_BOUNDARY_CHECK.)
  runtime.session_stories_completed = 0;

  const lockResult = lockUserBranchIfNeeded(runtime, profile, projectRoot);
  if (lockResult && lockResult.halt) {
    const halt = decorateHaltContext(lockResult.halt, runtime, projectRoot);
    ledger.append(
      { kind: 'action_emitted', phase: runtime.phase, action: halt },
      { projectRoot },
    );
    process.stdout.write(
      `${JSON.stringify({ action: halt, phase: runtime.phase }, null, 2)}\n`,
    );
    return 0;
  }

  const action = decorateHaltContext(
    decorateReviewDepth(
      decorateTestScope(
        decorateRunScript(
          decorateGitOp(stateMachine.nextAction(runtime, profile), runtime, profile, projectRoot),
          runtime,
          profile,
          projectRoot,
        ),
        runtime,
        profile,
        projectRoot,
      ),
      runtime,
      profile,
      projectRoot,
    ),
    runtime,
    projectRoot,
  );
  ledger.append({ kind: 'action_emitted', phase: runtime.phase, action }, { projectRoot });
  persistRuntimeState(runtime, profile, projectRoot);
  if (profile.coalesce_state_writes) stateStore.flush(profile, { projectRoot, story: runtime.story_key });
  process.stdout.write(`${JSON.stringify({ action, phase: runtime.phase }, null, 2)}\n`);
  return 0;
}

function cmdNext(opts) {
  const projectRoot = resolveProjectRoot(opts);
  const { typed: profile } = resolveProfile(projectRoot, opts.profile);
  const persisted = loadState(projectRoot);
  const runtime = composeRuntimeState(persisted, profile, projectRoot);
  // --test-scope override (one-shot, this emission only). Accepted values
  // match profile.testing_scope. Threaded into the runtime so
  // decorateTestScope picks it up. NOT persisted: each `autopilot next`
  // invocation must repeat the flag if the user wants to force scope.
  if (opts && typeof opts['test-scope'] === 'string') {
    const v = opts['test-scope'];
    if (v === 'affected' || v === 'full') {
      runtime.test_scope_override = v;
    } else {
      log.warn(`--test-scope ignored: invalid value ${JSON.stringify(v)} (expected affected|full)`);
    }
  }

  // The LLM-driven workflow (workflow.orchestrator.md) tells the LLM to
  // call `next` directly without `start` — apply the same branch-reuse
  // enforcement here so a missed `start` doesn't bypass it.
  const lockResult = lockUserBranchIfNeeded(runtime, profile, projectRoot);
  if (lockResult && lockResult.halt) {
    const halt = decorateHaltContext(lockResult.halt, runtime, projectRoot);
    ledger.append(
      { kind: 'action_emitted', phase: runtime.phase, action: halt },
      { projectRoot },
    );
    process.stdout.write(
      `${JSON.stringify({ action: halt, phase: runtime.phase }, null, 2)}\n`,
    );
    return 0;
  }

  const action = decorateHaltContext(
    decorateReviewDepth(
      decorateTestScope(
        decorateRunScript(
          decorateGitOp(stateMachine.nextAction(runtime, profile), runtime, profile, projectRoot),
          runtime,
          profile,
          projectRoot,
        ),
        runtime,
        profile,
        projectRoot,
      ),
      runtime,
      profile,
      projectRoot,
    ),
    runtime,
    projectRoot,
  );
  ledger.append({ kind: 'action_emitted', phase: runtime.phase, action }, { projectRoot });
  // Persist any mutations done by lockUserBranchIfNeeded — without this
  // every cmdNext under reuse_user_branch=true re-detects the branch and
  // emits a redundant `state_transition` ledger entry forever.
  persistRuntimeState(runtime, profile, projectRoot);
  // Skill timing: emit a `skill.<name>` start event when we hand off an
  // invoke_skill action. The matching end event is emitted on `record`
  // when the signal advances the phase. This makes parallelism +
  // duration observable without depending on LLM cooperation.
  if (action.type === 'invoke_skill' && action.skill) {
    logSkillTiming(projectRoot, 'start', runtime.story_key || 'sprint', action.skill, profile);
  }
  process.stdout.write(`${JSON.stringify({ action, phase: runtime.phase }, null, 2)}\n`);
  return 0;
}

function cmdRecord(opts) {
  const projectRoot = resolveProjectRoot(opts);
  const { typed: profile } = resolveProfile(projectRoot, opts.profile);
  const persisted = loadState(projectRoot);
  const runtime = composeRuntimeState(persisted, profile, projectRoot);

  let signalJson;
  if (opts['signal-file']) {
    signalJson = fs.readFileSync(opts['signal-file'], 'utf8');
  } else if (opts.signal) {
    signalJson = String(opts.signal);
  } else {
    signalJson = fs.readFileSync(0, 'utf8');
  }
  let signal;
  try {
    signal = JSON.parse(signalJson);
  } catch (e) {
    log.error(`invalid signal JSON: ${e.message}`);
    return 2;
  }
  ledger.append(
    { kind: 'signal_recorded', phase: runtime.phase, status: signal.status },
    { projectRoot },
  );

  // Verify only on `success` and `verify_override`. Under `git.enabled:
  // false`, git-op phases skip verify entirely — there's no commit_sha/
  // branch to assert and verify would reject every success in a loop.
  // The state machine still routes through these phases so the BMad
  // cycle stays intact; only the bookkeeping check is bypassed. The
  // phase list is centralized in state-machine.js#isGitOpPhase so a
  // future git-op phase automatically gets the bypass.
  const isGitDisabledPhase =
    profile.enabled === false && stateMachine.shouldSkipVerifyWhenGitDisabled(runtime.phase);
  let verifyResult;
  if (signal.status === 'success' && !isGitDisabledPhase) {
    verifyResult = verifyMod.verify(runtime, signal.output, { projectRoot, profile });
    ledger.append(
      { kind: 'verify_result', phase: runtime.phase, ok: verifyResult.ok, issues: verifyResult.issues || [] },
      { projectRoot },
    );
  } else if (signal.status === 'verify_override') {
    verifyResult = verifyMod.verifyWithOverride(
      runtime,
      signal.output || {},
      { projectRoot, profile },
      signal.evidence || {},
    );
    ledger.append(
      { kind: 'verify_result', phase: runtime.phase, ok: verifyResult.ok, issues: verifyResult.issues || [] },
      { projectRoot },
    );
  }

  const result = adapt.interpretSignal(runtime, signal, profile, verifyResult);
  const planFailure = applySideEffects(
    result.sideEffects,
    result.newState,
    result.newProfile,
    projectRoot,
  );
  // v2.3.0 — if a plan_* side-effect failed (DAG violation, validation
  // error, write failure), override the emitted nextAction with a
  // user_prompt halt so the LLM session sees the failure and can
  // remediate. Without this the autopilot silently moves on and the
  // user wonders why their reorder/add/remove "did nothing".
  if (planFailure) {
    const haltAction = decorateHaltContext(
      {
        type: 'user_prompt',
        phase: result.newState.phase,
        reason: planFailure.kind,
        prompt: planFailure.prompt,
        details: planFailure.details || null,
      },
      result.newState,
      projectRoot,
    );
    ledger.append(
      { kind: 'action_emitted', phase: result.newState.phase, action: haltAction },
      { projectRoot },
    );
    process.stdout.write(
      `${JSON.stringify({ action: haltAction, phase: result.newState.phase }, null, 2)}\n`,
    );
    return 0;
  }

  // Skill timing: emit `skill.<name>` end event when an invoke_skill phase
  // advances to a new phase (success path) OR when it pauses with a
  // non-retry verdict (failure/prompted). Match the legacy log-timing
  // bracket semantics so observedParallelism() sees a complete interval.
  const wasInvokeSkill =
    runtime.phase &&
    ['create_story', 'check_readiness', 'dev_red', 'dev_green', 'code_review',
     'patch_apply', 'patch_retest', 'retrospective', 'nano_quick_dev'].includes(runtime.phase);
  if (wasInvokeSkill && result.verdict !== 'retry') {
    const skillFromAction = (() => {
      const a = stateMachine.nextAction(runtime, profile);
      return a && a.type === 'invoke_skill' ? a.skill : null;
    })();
    if (skillFromAction) {
      logSkillTiming(
        projectRoot,
        'end',
        runtime.story_key || 'sprint',
        skillFromAction,
        result.newProfile,
      );
    }
  }

  // Persist new runtime state.
  persistRuntimeState(result.newState, result.newProfile, projectRoot);

  // v2.3.12 — auto-update the portable sprint-tasks.md file so any host
  // coding agent (Claude Code, Gemini CLI, Codex, Cursor, …) can surface
  // a fresh task-list view to the user at every phase transition.
  // Side-effect only; failures are logged but never block.
  writeSprintTasksFile(projectRoot, result.newState);

  // v2.3.0 Phase 4.5 — streaming progress. Emit step-level ledger events
  // on every phase transition so `autopilot progress` can render live
  // status. Mirrors the change to plan.stories[].current_step via
  // markRunning. Both are best-effort — plan-layer failures never wedge
  // cmdRecord. Only fires when the transition involves a story-bound
  // phase (skips sprint-level boundaries like SPRINT_FINALIZE_PENDING).
  emitPhaseTransitionEvents(runtime, result.newState, projectRoot);

  // v2.3.0 — when a story transitions into STORY_DONE, sync the plan's
  // `plan_status` so the queue resolver drops the entry next cmdStart.
  // Best-effort + idempotent: markDone on an already-done story is a
  // no-op, and any plan-layer failure is recorded to the ledger but
  // never blocks the autopilot cycle.
  if (
    result.newState.phase === STATES.STORY_DONE &&
    result.newState.story_key &&
    typeof result.newState.story_key === 'string'
  ) {
    try {
      const planRead = sprintPlanScript.read({ projectRoot });
      // Only update when a plan actually exists; greenfield projects
      // running in sprint-status order don't need plan upkeep.
      if (planRead && !(typeof planRead === 'object' && 'error' in planRead)) {
        sprintPlanScript.markDone(result.newState.story_key, { projectRoot });
        ledger.append(
          { kind: 'plan_story_done', detail: { story_key: result.newState.story_key } },
          { projectRoot },
        );
      }
    } catch (e) {
      ledger.append(
        {
          kind: 'plan_story_done_failed',
          detail: { story_key: result.newState.story_key, message: e.message },
        },
        { projectRoot },
      );
    }
  }

  // v2.4.0 — background full-suite runner.
  //
  // When profile.testing_full_suite_on_story_land === 'background' AND
  // the just-completed phase advanced into STORY_DONE, spawn the full
  // test suite as a detached subprocess. The next session's cmdStart
  // reads the resulting sidecar; non-zero exit halts before the next
  // story. CI users keep 'ci' (default no-op here); 'skip' is no-op
  // too. Closes the v2.3.18 silent caveat for teams without CI.
  if (
    result.newState.phase === STATES.STORY_DONE &&
    result.newProfile.testing_full_suite_on_story_land === 'background'
  ) {
    const storyForRun = result.newState.story_key || runtime.story_key || 'sprint';
    const command = backgroundSuite.resolveFullSuiteCommand(result.newProfile, projectRoot);
    if (!command) {
      log.warn(
        'testing.full_suite_on_story_land=background but no full-suite command resolves. ' +
          'Set testing.commands.full in your profile or install a supported adapter. Skipping spawn.',
      );
      ledger.append(
        {
          kind: 'state_transition',
          detail: {
            background_full_suite: 'no_command',
            story_key: storyForRun,
          },
        },
        { projectRoot },
      );
    } else {
      const spawn = backgroundSuite.spawnBackground({
        command,
        projectRoot,
        storyKey: storyForRun,
      });
      if (spawn && spawn.pid) {
        ledger.append(
          {
            kind: 'state_transition',
            detail: {
              background_full_suite: 'spawned',
              story_key: storyForRun,
              pid: spawn.pid,
              command,
              sidecar_path: spawn.sidecar_path,
              log_path: spawn.log_path,
            },
          },
          { projectRoot },
        );
        log.info(
          `Background full-suite running for ${storyForRun} (pid ${spawn.pid}); ` +
            `result will gate the next session's cmdStart.`,
        );
      } else {
        const errMsg = (spawn && spawn.error) || 'unknown';
        log.warn(`Background full-suite spawn failed: ${errMsg}. Continuing without gate.`);
        ledger.append(
          {
            kind: 'state_transition',
            detail: {
              background_full_suite: 'spawn_failed',
              story_key: storyForRun,
              error: errMsg,
            },
          },
          { projectRoot },
        );
      }
    }
  }

  // Story-boundary or halt → flush coalesce buffer if enabled.
  const isStoryBoundary =
    result.newState.phase === STATES.STORY_DONE ||
    result.newState.phase === STATES.EPIC_BOUNDARY_CHECK ||
    result.newState.phase === STATES.SPRINT_FINALIZE_PENDING ||
    result.verdict === 'halt';
  if (result.newProfile.coalesce_state_writes && isStoryBoundary) {
    stateStore.flush(result.newProfile, { projectRoot, story: result.newState.story_key });
  }

  // v2.5.0 — sprint-health metrics. When the RETROSPECTIVE phase
  // advances successfully (LLM has written the retro file), append a
  // machine-tagged metrics block at the bottom. Idempotent: the
  // sprint-health module replaces the tagged section if already
  // present, so re-runs of the same retro don't duplicate.
  if (
    runtime.phase === STATES.RETROSPECTIVE &&
    result.verdict === 'advanced'
  ) {
    try {
      const epicKey = runtime.current_epic || result.newState.current_epic || null;
      if (epicKey) {
        const retroPath = path.join(
          projectRoot,
          '_bmad-output',
          'retrospectives',
          `${epicKey}.md`,
        );
        const allEntries = ledger.read({ projectRoot });
        const metrics = sprintHealth.computeMetrics(allEntries, { epicKey });
        const writeResult = sprintHealth.appendMetricsSection(retroPath, metrics);
        ledger.append(
          {
            kind: 'state_transition',
            detail: {
              sprint_health_metrics: writeResult.mode,
              epic_key: epicKey,
              stories_completed: metrics.stories_completed,
              total_halts: metrics.total_halts,
            },
          },
          { projectRoot },
        );
      }
    } catch (e) {
      log.warn(`sprint-health metrics append failed: ${e.message}`);
    }
  }

  // On halt: record fingerprint for resume divergence detection.
  if (result.verdict === 'halt' || (result.nextAction && result.nextAction.type === 'halt')) {
    const fp = divergence.fingerprint({ projectRoot });
    ledger.append(
      { kind: 'halt', phase: result.newState.phase, reason: result.nextAction.reason, fingerprint: fp },
      { projectRoot },
    );
  } else {
    ledger.append(
      { kind: 'state_transition', from: runtime.phase, to: result.newState.phase, verdict: result.verdict },
      { projectRoot },
    );
  }

  const payload = {
    action: decorateHaltContext(
      decorateReviewDepth(
        decorateTestScope(
          decorateRunScript(
            decorateGitOp(result.nextAction, result.newState, result.newProfile, projectRoot),
            result.newState,
            result.newProfile,
            projectRoot,
          ),
          result.newState,
          result.newProfile,
          projectRoot,
        ),
        result.newState,
        result.newProfile,
        projectRoot,
      ),
      result.newState,
      projectRoot,
    ),
    verdict: result.verdict,
    phase: result.newState.phase,
    profile: result.newProfile.name,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return 0;
}

function cmdState(opts) {
  const projectRoot = resolveProjectRoot(opts);
  const persisted = loadState(projectRoot);
  process.stdout.write(`${JSON.stringify(persisted, null, 2)}\n`);
  return 0;
}

function cmdReport(opts) {
  const projectRoot = resolveProjectRoot(opts);
  const { typed: profile } = resolveProfile(projectRoot, opts.profile);
  const persisted = loadState(projectRoot);
  const entries = ledger.read({ projectRoot });
  process.stdout.write(`${reportRenderer.render(persisted, entries, profile)}\n`);
  return 0;
}

function cmdValidateConfig(opts) {
  const projectRoot = resolveProjectRoot(opts);
  const { typed, source } = resolveProfile(projectRoot, opts.profile);
  process.stdout.write(`${JSON.stringify({ profile: typed, source }, null, 2)}\n`);
  return 0;
}

// v2.5.0 — `autopilot status` is now structured + observability-grade.
//
// Default output is JSON (machine-readable, scriptable). `--human` (or
// `-h` when not conflicting with --help) renders the same data as a
// compact human-scannable block. The legacy one-line shape lives behind
// `--legacy` for any callers that pinned to it.
//
// Fields:
//   story, story_queue_head, current_phase, profile_name
//   time_in_phase_minutes              (from state.phase_started_at)
//   retry_count_this_phase, verify_reject_count, consecutive_test_failures
//   diagnostic_pending, diagnostic_completed
//   session_stories_completed, session_story_limit
//   halt_active                         (true when ledger tail is a halt)
//   halt_reason                         (when halt_active)
//   recent_events: [{ kind, seq, ts, ... }]   last 3 informative ledger entries
//   background_full_suite: { state, story_key?, exit_code?, age_minutes? }
//   quarantined_test_count
function cmdStatus(opts) {
  const projectRoot = resolveProjectRoot(opts);
  const persisted = loadState(projectRoot);
  if (opts && opts.legacy) {
    const story = persisted.current_story || '-';
    const step = persisted.current_bmad_step || '-';
    process.stdout.write(`story=${story} step=${step}\n`);
    return 0;
  }
  const status = buildRichStatus(projectRoot, persisted, opts);
  if (opts && (opts.human || opts.h)) {
    process.stdout.write(`${renderStatusHuman(status)}\n`);
    return 0;
  }
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  return 0;
}

function buildRichStatus(projectRoot, persisted, opts) {
  const ledgerEntries = ledger.read({ projectRoot });
  const tail = ledgerEntries[ledgerEntries.length - 1] || null;
  const haltActive = !!(tail && tail.kind === 'halt');
  const phase = persisted.current_bmad_step || null;
  const phaseStartedAt = persisted.phase_started_at || null;

  // Time-in-phase: minutes since state.phase_started_at (set on every
  // phase advance by adapt.advanceState). Null when missing — applies
  // pre-v2.4.0 sessions or fresh boots before any advance.
  let timeInPhase = null;
  if (phaseStartedAt) {
    const t = Date.parse(phaseStartedAt);
    if (Number.isFinite(t)) timeInPhase = Math.round(((Date.now() - t) / 60_000) * 10) / 10;
  }

  // Recent events — last 3 informative entries (skip routine state_transitions
  // and decoration entries). The halt-explainer's RECENT_ACTION_TYPES list
  // is the cleanest reusable filter.
  const recent = [];
  for (let i = ledgerEntries.length - 1; i >= 0 && recent.length < 3; i -= 1) {
    const e = ledgerEntries[i];
    if (!e) continue;
    if (e.kind === 'state_transition' && !haltActive) continue;
    if (e.kind === 'test_scope_decision') continue;
    if (e.kind === 'review_depth_decision') continue;
    if (e.kind === 'action_emitted' && e.action) {
      recent.push({
        seq: e.seq,
        ts: e.ts,
        kind: 'action_emitted',
        type: e.action.type,
        skill: e.action.skill || null,
        op: e.action.op || null,
        phase: e.action.phase || e.phase || null,
      });
    } else if (
      e.kind === 'verify_result' || e.kind === 'halt' || e.kind === 'verify_rejected' ||
      e.kind === 'profile_escalated'
    ) {
      recent.push({ seq: e.seq, ts: e.ts, kind: e.kind, phase: e.phase || null });
    }
  }
  recent.reverse();

  // Background-suite sidecar state. Returns null when the knob isn't set
  // to background OR no sidecars exist yet.
  let backgroundFullSuite = null;
  try {
    const sidecar = backgroundSuite.readLatestSidecar(projectRoot);
    if (sidecar) {
      const ageMs = sidecar.completed_at
        ? Date.now() - Date.parse(sidecar.completed_at)
        : Date.now() - Date.parse(sidecar.started_at);
      backgroundFullSuite = {
        state: sidecar.acknowledged
          ? 'acknowledged'
          : typeof sidecar.exit_code === 'number'
            ? sidecar.exit_code === 0
              ? 'green'
              : 'failed'
            : 'running',
        story_key: sidecar.story_key,
        exit_code: typeof sidecar.exit_code === 'number' ? sidecar.exit_code : null,
        age_minutes: Number.isFinite(ageMs) ? Math.round((ageMs / 60_000) * 10) / 10 : null,
      };
    }
  } catch (_e) {
    /* sidecar read is best-effort */
  }

  // Quarantine count.
  let quarantinedCount = 0;
  try {
    const q = flakyQuarantine.read(projectRoot);
    quarantinedCount = (q.quarantined || []).length;
  } catch (_e) {
    quarantinedCount = 0;
  }

  // Profile (resolved fresh so the value matches the next emission).
  let profileName = null;
  try {
    const { typed } = resolveProfile(projectRoot, opts && opts.profile);
    profileName = typed.name;
  } catch (_e) {
    profileName = null;
  }

  return {
    story: persisted.current_story || null,
    story_queue_head: Array.isArray(persisted.story_queue) && persisted.story_queue.length > 0
      ? persisted.story_queue[0]
      : null,
    current_phase: phase,
    profile_name: profileName,
    time_in_phase_minutes: timeInPhase,
    phase_started_at: phaseStartedAt,
    retry_count_this_phase: persisted.retry_count_this_phase || 0,
    verify_reject_count: persisted.verify_reject_count || 0,
    consecutive_test_failures: persisted.consecutive_test_failures || 0,
    diagnostic_pending: persisted.diagnostic_pending === true,
    diagnostic_completed: persisted.diagnostic_completed === true,
    session_stories_completed: persisted.session_stories_completed || 0,
    halt_active: haltActive,
    halt_reason: haltActive ? (tail.reason || null) : null,
    recent_events: recent,
    background_full_suite: backgroundFullSuite,
    quarantined_test_count: quarantinedCount,
  };
}

function renderStatusHuman(s) {
  const lines = [];
  lines.push(`story=${s.story || '-'}  phase=${s.current_phase || '-'}  profile=${s.profile_name || '-'}`);
  if (s.time_in_phase_minutes !== null) {
    lines.push(`time-in-phase: ${s.time_in_phase_minutes}m  (since ${s.phase_started_at || '?'})`);
  }
  const counters = [];
  if (s.retry_count_this_phase) counters.push(`retry=${s.retry_count_this_phase}`);
  if (s.verify_reject_count) counters.push(`verify-reject=${s.verify_reject_count}`);
  if (s.consecutive_test_failures) counters.push(`consec-test-fail=${s.consecutive_test_failures}`);
  if (s.diagnostic_pending) counters.push('diagnostic-pending');
  if (counters.length > 0) lines.push(`counters: ${counters.join('  ')}`);
  if (s.story_queue_head && s.story_queue_head !== s.story) {
    lines.push(`next: ${s.story_queue_head}`);
  }
  if (s.session_stories_completed > 0) {
    lines.push(`session stories done: ${s.session_stories_completed}`);
  }
  if (s.halt_active) {
    lines.push(`HALT: ${s.halt_reason || 'unknown'}`);
  }
  if (s.background_full_suite) {
    const bs = s.background_full_suite;
    lines.push(
      `background suite: ${bs.state}` +
        (bs.story_key ? ` (story=${bs.story_key}` : '') +
        (typeof bs.exit_code === 'number' ? `, exit=${bs.exit_code}` : '') +
        (bs.age_minutes !== null ? `, ${bs.age_minutes}m ago)` : bs.story_key ? ')' : ''),
    );
  }
  if (s.quarantined_test_count > 0) {
    lines.push(`quarantined tests: ${s.quarantined_test_count}`);
  }
  if (s.recent_events.length > 0) {
    lines.push(`recent (oldest → newest):`);
    for (const e of s.recent_events) {
      const tag = e.skill || e.op || e.kind;
      lines.push(`  #${e.seq} ${e.ts} ${e.kind} ${tag} ${e.phase ? `(${e.phase})` : ''}`);
    }
  }
  return lines.join('\n');
}

// v2.3.10 — `autopilot heartbeat --message "<text>"` appends a
// `story_step_progress` ledger entry so external observers (operators,
// `autopilot progress`, ledger tails, monitoring dashboards) can see the
// session is actively making progress inside a long phase rather than
// frozen. Phases like `dev_green` and `code_review` can run 30–60+
// minutes silently between state transitions; without periodic
// heartbeats there is no signal distinguishing "LLM is working" from
// "session crashed." The wrapper skill MUST emit one of these at least
// every 10 minutes during long-running phases (see workflow.orchestrator.md).
// v2.3.12 — derive the canonical task list for a story from persisted
// state + the ledger tail. Status per task:
//   pending     — terminal phase not yet entered
//   in_progress — terminal phase is the current orchestrator phase
//   completed   — current phase has advanced past terminal phase
//   failed      — last signal in this task's phases was failure / blocked
//                 and the autopilot halted (no further advancement)
//
// Pure function — no I/O — for easy testing.
function deriveTasksForStory(currentPhase, recentLedgerEntries, opts = {}) {
  const haltActive = opts.haltActive === true;
  const currentIdx = phaseOrderIndex(currentPhase);
  // Map phase → latest signal status from ledger (only relevant entries).
  const lastSignalByPhase = new Map();
  for (const e of recentLedgerEntries) {
    if (e && e.kind === 'signal_recorded' && typeof e.phase === 'string' && typeof e.status === 'string') {
      lastSignalByPhase.set(e.phase, e.status);
    }
  }
  return STORY_TASK_DEFINITIONS.map((def) => {
    const terminalPhase = def.phases[def.phases.length - 1];
    const terminalIdx = phaseOrderIndex(terminalPhase);
    let status = 'pending';
    // Past all phases of this task?
    if (currentIdx > terminalIdx) {
      status = 'completed';
    } else if (def.phases.includes(currentPhase)) {
      status = 'in_progress';
      // If we're halted on this phase with a non-success last signal,
      // surface as failed so the operator notices.
      if (haltActive) {
        const sig = lastSignalByPhase.get(currentPhase);
        if (sig && sig !== 'success' && sig !== 'user_input') status = 'failed';
      }
    }
    return { id: def.id, label: def.label, phases: def.phases.slice(), status };
  });
}

function tasksToMarkdown(story, tasks, opts = {}) {
  const heading = opts.heading || 'Sprintpilot — current story';
  const queueHead = opts.queueHead || null;
  const remainingInQueue = typeof opts.remainingInQueue === 'number' ? opts.remainingInQueue : 0;
  const storyTitle = opts.storyTitle || null;
  const lines = [];
  lines.push(`# ${heading}`);
  lines.push('');
  // v2.5.1 — prefer the human-readable story title (from the story
  // file's H1) over the slug-key — the key encodes epic + slug so
  // surfacing both is redundant noise on the board. When the title is
  // unavailable (queued story whose spec file doesn't exist yet) we
  // fall back to the key. Epic is implicit in the key/title and is
  // not rendered as a separate row.
  if (story) {
    lines.push(`**Story:** ${storyTitle ? storyTitle : `\`${story}\``}`);
  } else if (queueHead) {
    const detail = remainingInQueue > 1 ? ` (queue: ${remainingInQueue} stories)` : '';
    const label = storyTitle ? storyTitle : `\`${queueHead}\``;
    lines.push(`**Story:** ${label} (queued; spec not yet authored)${detail}`);
  } else {
    lines.push('**Story:** (none — between stories or idle)');
  }
  lines.push('');
  for (const t of tasks) {
    let glyph = '[ ]';
    let suffix = '';
    if (t.status === 'completed') glyph = '[x]';
    else if (t.status === 'in_progress') {
      glyph = '[ ]';
      suffix = ' ← in progress';
    } else if (t.status === 'failed') {
      glyph = '[ ]';
      suffix = ' ⚠ failed';
    }
    lines.push(`- ${glyph} ${t.label}${suffix}`);
  }
  lines.push('');
  lines.push(`_Updated: ${new Date().toISOString()}_`);
  lines.push('');
  return lines.join('\n');
}

// v2.5.1 — extract the human-readable title from a BMad story file's
// first H1. BMad's bmad-create-story emits files like
// `_bmad-output/implementation-artifacts/<story-key>.md` with a
// `# Story <id>: <Title>` H1. We pull just the H1 text (after the
// first `# `) so the task board can name the story without the user
// translating its slug.
//
// Returns null when the file is absent, unreadable, or has no H1 —
// callers render key-only in that case.
function readStoryTitleFromFile(projectRoot, storyKey, persisted) {
  if (!storyKey) return null;
  try {
    const artDir =
      (persisted && persisted.implementation_artifacts) ||
      path.join(projectRoot, '_bmad-output', 'implementation-artifacts');
    // persisted.story_file_path is stored relative to projectRoot
    // (e.g. `_bmad-output/implementation-artifacts/15-4-foo.md`), so
    // we join when the path isn't absolute. Same treatment for the
    // implementation_artifacts override if a caller passed a relative
    // string there.
    const rawPath = (persisted && persisted.story_file_path) || path.join(artDir, `${storyKey}.md`);
    const storyFile = path.isAbsolute(rawPath) ? rawPath : path.join(projectRoot, rawPath);
    const text = fs.readFileSync(storyFile, 'utf8');
    // First H1 wins. Skip frontmatter (--- … ---) if present.
    let body = text;
    if (body.startsWith('---')) {
      const end = body.indexOf('\n---', 3);
      if (end !== -1) body = body.slice(end + 4);
    }
    const m = body.match(/^#\s+(.+?)\s*$/m);
    return m ? m[1] : null;
  } catch (_e) {
    return null;
  }
}

function tasksFilePath(projectRoot, persisted) {
  // Honour output_folder via implementation_artifacts (resolved at boot).
  const baseDir =
    (persisted && persisted.implementation_artifacts) ||
    path.join(projectRoot, '_bmad-output', 'implementation-artifacts');
  return path.join(baseDir, 'sprint-tasks.md');
}

// Auto-update the portable task file. Called from cmdRecord after every
// state advancement so the file is always fresh. Best-effort: a write
// failure logs a warning but never aborts the orchestrator.
function writeSprintTasksFile(projectRoot, persisted) {
  try {
    const currentPhase = persisted && persisted.current_bmad_step ? String(persisted.current_bmad_step) : null;
    const story = persisted && persisted.current_story ? String(persisted.current_story) : null;
    const recent = ledger.read({ projectRoot }, { limit: 30 });
    // Detect halt — most recent halt entry is at the tail and we haven't
    // resumed since.
    const tail = recent[recent.length - 1] || null;
    const haltActive = !!(tail && tail.kind === 'halt');
    const tasks = deriveTasksForStory(currentPhase, recent, { haltActive });
    const queueHead = !story && Array.isArray(persisted && persisted.story_queue) && persisted.story_queue.length > 0
      ? persisted.story_queue[0]
      : null;
    const remainingInQueue = Array.isArray(persisted && persisted.story_queue) ? persisted.story_queue.length : 0;
    const storyTitle = readStoryTitleFromFile(projectRoot, story || queueHead, persisted);
    const body = tasksToMarkdown(story, tasks, { queueHead, remainingInQueue, storyTitle });
    const file = tasksFilePath(projectRoot, persisted);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, 'utf8');
  } catch (e) {
    // Never crash the orchestrator on a docs side-effect.
    if (process.env.SPRINTPILOT_DEBUG) {
      log.warn(`writeSprintTasksFile: ${e.message || e}`);
    }
  }
}

// v2.3.12 — `autopilot tasks` CLI subcommand. Renders the canonical
// per-story task list as JSON (default) or Markdown.
//
// The host coding agent's wrapper skill calls this on every phase
// transition, reads the result, and:
//   1. Mirrors the task list into its native task tool when one exists
//      (Claude Code's TaskCreate, Gemini's TODO panel, etc.)
//   2. Falls back to printing the markdown rendering to chat for hosts
//      without a native task tool.
//
// See workflow.orchestrator.md for the agent-side contract.
function cmdTasks(opts) {
  const projectRoot = resolveProjectRoot(opts);
  const persisted = loadState(projectRoot);
  const currentPhase = persisted.current_bmad_step ? String(persisted.current_bmad_step) : null;
  const story = persisted.current_story ? String(persisted.current_story) : null;
  const recent = ledger.read({ projectRoot }, { limit: 30 });
  const tail = recent[recent.length - 1] || null;
  const haltActive = !!(tail && tail.kind === 'halt');
  const tasks = deriveTasksForStory(currentPhase, recent, { haltActive });
  // v2.5.1 — surface the queue head + epic so the board doesn't claim
  // "idle" while it's actually about to author a story spec.
  const queueHead = !story && Array.isArray(persisted.story_queue) && persisted.story_queue.length > 0
    ? persisted.story_queue[0]
    : null;
  const remainingInQueue = Array.isArray(persisted.story_queue) ? persisted.story_queue.length : 0;
  const epicKey = persisted.current_epic ? String(persisted.current_epic) : null;
  const storyTitle = readStoryTitleFromFile(projectRoot, story || queueHead, persisted);
  if (opts.markdown || opts.md) {
    process.stdout.write(tasksToMarkdown(story, tasks, { queueHead, remainingInQueue, storyTitle }));
    return 0;
  }
  // JSON output keeps `epic` for machine consumers — the human-readable
  // markdown drops the epic row (it's already encoded in the story key
  // / title), but scripts and dashboards may still want the bare
  // identifier separately.
  process.stdout.write(
    `${JSON.stringify(
      {
        story,
        story_title: storyTitle,
        story_queue_head: queueHead,
        story_queue_length: remainingInQueue,
        epic: epicKey,
        current_phase: currentPhase,
        halt_active: haltActive,
        tasks,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

// v2.5.0 — `autopilot watch`: live timeline TUI. Tails the ledger
// via action-ledger.tail() and re-renders a status block + recent
// events on every new entry. In TTY mode (default), each render
// clears the screen and redraws. With `--no-tui` (or when stdout
// isn't a TTY), each new event prints as a single appended line —
// works cleanly piped into a file or `tee`.
//
// Flags:
//   --once         render the current state once and exit (no tail)
//   --no-tui       disable ANSI repainting; print event-per-line
//
// Exits cleanly on SIGINT; the tail iterator's AbortController is
// wired to the signal so the loop terminates immediately.
function cmdWatch(opts) {
  const projectRoot = resolveProjectRoot(opts);
  const persisted = loadState(projectRoot);
  const useTty = !opts['no-tui'] && process.stdout.isTTY === true;

  // First render is always full-state.
  const initialStatus = buildRichStatus(projectRoot, persisted, opts);
  const initialEntries = ledger.read({ projectRoot }, { limit: 20 });
  if (useTty) {
    process.stdout.write('\x1b[2J\x1b[H'); // clear + home
  }
  renderWatchFrame(initialStatus, initialEntries, { tty: useTty });

  if (opts.once) return 0;

  // Tail loop. node:async iterators play well with sync code; we use
  // a small adapter that runs the async generator and exits on SIGINT.
  const abortCtrl = new AbortController();
  const onSigint = () => {
    abortCtrl.abort();
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigint);

  return tailLoop(projectRoot, abortCtrl.signal, useTty, opts)
    .then(() => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigint);
      return 0;
    })
    .catch((e) => {
      log.error(`autopilot watch: ${e.message}`);
      return 1;
    });
}

async function tailLoop(projectRoot, signal, useTty, opts) {
  for await (const event of ledger.tail({ projectRoot, signal, pollIntervalMs: 500 })) {
    if (signal.aborted) break;
    if (useTty) {
      // Re-render the whole frame on each new event. Cheap enough at
      // ledger cadence (1-5 events/min in practice).
      const persisted = loadState(projectRoot);
      const status = buildRichStatus(projectRoot, persisted, opts);
      const entries = ledger.read({ projectRoot }, { limit: 20 });
      process.stdout.write('\x1b[2J\x1b[H');
      renderWatchFrame(status, entries, { tty: true });
    } else {
      // Plain mode: append a one-line digest per event.
      process.stdout.write(`${formatWatchEventLine(event)}\n`);
    }
  }
}

function renderWatchFrame(status, entries, { tty }) {
  const c = tty ? colorize : (_color, text) => text;
  const out = [];
  out.push(c('bold', `Sprintpilot — autopilot watch`));
  out.push(c('dim', `  story=${status.story || '-'}  phase=${status.current_phase || '-'}  profile=${status.profile_name || '-'}`));
  if (status.time_in_phase_minutes !== null) {
    out.push(c('dim', `  time-in-phase: ${status.time_in_phase_minutes}m`));
  }
  const counters = [];
  if (status.retry_count_this_phase) counters.push(`retry=${status.retry_count_this_phase}`);
  if (status.verify_reject_count) counters.push(`verify-reject=${status.verify_reject_count}`);
  if (status.consecutive_test_failures) counters.push(`consec-test-fail=${status.consecutive_test_failures}`);
  if (status.diagnostic_pending) counters.push(c('yellow', 'diagnostic-pending'));
  if (counters.length > 0) out.push(`  ${counters.join('  ')}`);
  if (status.halt_active) {
    out.push(c('red', `  HALT: ${status.halt_reason || 'unknown'}`));
  }
  if (status.background_full_suite) {
    const bs = status.background_full_suite;
    const stateColor = bs.state === 'green' ? 'green' : bs.state === 'failed' ? 'red' : 'dim';
    out.push(`  background suite: ${c(stateColor, bs.state)}${bs.story_key ? ` (${bs.story_key})` : ''}`);
  }
  if (status.quarantined_test_count > 0) {
    out.push(`  quarantined tests: ${status.quarantined_test_count}`);
  }
  out.push('');
  out.push(c('bold', `Recent ledger events (newest last):`));
  for (const e of entries) {
    out.push(`  ${formatWatchEventLine(e, { tty })}`);
  }
  if (tty) {
    out.push('');
    out.push(c('dim', `Press Ctrl-C to exit.`));
  }
  process.stdout.write(`${out.join('\n')}\n`);
}

function formatWatchEventLine(e, { tty = false } = {}) {
  if (!e) return '';
  const c = tty ? colorize : (_color, text) => text;
  const ts = (e.ts || '').slice(11, 19); // HH:MM:SS
  const seq = e.seq != null ? `#${e.seq}` : '';
  const phase = e.phase || (e.action && e.action.phase) || '';
  let kindColor = 'dim';
  let extra = '';
  switch (e.kind) {
    case 'halt':
      kindColor = 'red';
      extra = e.reason ? ` reason=${e.reason}` : '';
      break;
    case 'verify_rejected':
      kindColor = 'yellow';
      break;
    case 'action_emitted':
      kindColor = e.action && e.action.type === 'user_prompt' ? 'yellow' : 'cyan';
      extra = e.action ? ` ${e.action.skill || e.action.op || e.action.type}` : '';
      break;
    case 'state_transition':
      kindColor = 'green';
      if (e.from && e.to) extra = ` ${e.from}→${e.to}${e.verdict ? ` (${e.verdict})` : ''}`;
      break;
    case 'test_scope_decision':
      kindColor = 'dim';
      extra = e.detail ? ` ${e.detail.scope || ''} ${e.detail.adapter || ''}` : '';
      break;
    case 'review_depth_decision':
      kindColor = 'dim';
      extra = e.detail ? ` ${e.detail.size || ''} reviewers=${e.detail.reviewer_count || ''}` : '';
      break;
    default:
      break;
  }
  return `${ts} ${seq} ${c(kindColor, e.kind)}${phase ? ` [${phase}]` : ''}${extra}`;
}

// Tiny ANSI colorizer — keeps the dependency footprint at zero. Only
// used in TTY rendering; the plain-mode path bypasses it entirely.
function colorize(color, text) {
  const codes = {
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
  };
  const reset = '\x1b[0m';
  return `${codes[color] || ''}${text}${reset}`;
}

// v2.4.0 — flaky-quarantine inspection / manual edits.
//
// Subcommands:
//   autopilot quarantine list         — print quarantined tests + flip counters
//   autopilot quarantine add <id>     — manually quarantine a test
//   autopilot quarantine eject <id>   — manually remove from quarantine
//
// The auto-quarantine path (signal.output.flaky_tests → record_flaky_tests
// side-effect) is the primary entry point; this CLI is for review and
// manual overrides.
function cmdQuarantine(opts, args) {
  const projectRoot = resolveProjectRoot(opts);
  const action = (args && args[0]) || 'list';
  if (action === 'list') {
    const state = flakyQuarantine.read(projectRoot);
    const payload = {
      quarantined: flakyQuarantine.listQuarantined(state),
      quarantined_detail: state.quarantined || [],
      flips: flakyQuarantine.listFlips(state),
      flip_threshold: flakyQuarantine.DEFAULT_FLIP_THRESHOLD,
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  if (action === 'add' || action === 'eject') {
    const testId = args && args[1];
    if (!testId) {
      log.error(`autopilot quarantine ${action}: missing <test_id>`);
      return 2;
    }
    let state = flakyQuarantine.read(projectRoot);
    if (action === 'add') {
      state = flakyQuarantine.quarantineManually(state, { testId });
    } else {
      state = flakyQuarantine.ejectFromQuarantine(state, { testId });
    }
    flakyQuarantine.write(projectRoot, state);
    ledger.append(
      {
        kind: 'state_transition',
        detail: {
          quarantine_action: action,
          test_id: testId,
        },
      },
      { projectRoot },
    );
    process.stdout.write(`${JSON.stringify({ ok: true, action, test_id: testId }, null, 2)}\n`);
    return 0;
  }
  log.error(`autopilot quarantine: unknown action '${action}' (expected list|add|eject)`);
  return 2;
}

function cmdHeartbeat(opts) {
  const projectRoot = resolveProjectRoot(opts);
  const message = opts.message || opts.m || '';
  if (!message || typeof message !== 'string') {
    log.error('heartbeat: --message "<text>" required (1 sentence describing current work)');
    return 2;
  }
  const persisted = loadState(projectRoot);
  const story = persisted.current_story || null;
  const step = persisted.current_bmad_step || null;
  ledger.append(
    {
      kind: 'story_step_progress',
      detail: {
        story_key: story,
        step_name: step,
        message: String(message).slice(0, 500),
        ts: new Date().toISOString(),
      },
    },
    { projectRoot },
  );
  process.stdout.write(
    `${JSON.stringify({ ok: true, story, step, message: String(message).slice(0, 500) })}\n`,
  );
  return 0;
}

// v2.3.0 Phase 4.5 — `autopilot progress` CLI subcommand. Reads
// sprint-plan.yaml + the recent ledger tail to produce a snapshot of
// "what's running right now and what's done". Modes:
//   (default --once)  Human-readable one-shot snapshot.
//   --json            Machine-readable JSON for IDE extensions.
//   --story <key>     Narrow to a single story.
// Full --watch (ANSI cursor control / live redraw) is intentionally
// deferred — terminals vary too widely to do right in this scope;
// `watch -n 1 'autopilot progress'` covers the use case adequately.
function cmdProgress(opts) {
  const projectRoot = resolveProjectRoot(opts);
  const persisted = loadState(projectRoot);
  const planResult = sprintPlanScript.read({ projectRoot });
  const plan =
    planResult && !(typeof planResult === 'object' && 'error' in planResult) ? planResult : null;

  // Recent ledger events (last 50) for context. Includes step events
  // when Phase 4.5 emission is active.
  const recentEvents = ledger.read({ projectRoot }, { limit: 50 });
  const stepEvents = recentEvents.filter(
    (e) =>
      e.kind === 'story_step_started' ||
      e.kind === 'story_step_progress' ||
      e.kind === 'story_step_completed',
  );

  // v2.3.10 — "last activity" detector. The most recent step event's
  // timestamp tells operators whether the session is making progress
  // inside a long phase or has gone silent. Surfaced as a relative-age
  // string + raw ISO; consumers (UI, monitors) can decide what to render.
  const lastActivityEntry = stepEvents.length > 0 ? stepEvents[stepEvents.length - 1] : null;
  const lastActivityTs = lastActivityEntry ? lastActivityEntry.ts : null;
  let lastActivityAgeSec = null;
  let lastActivityStale = false;
  if (lastActivityTs) {
    const ageMs = Date.now() - new Date(lastActivityTs).getTime();
    if (Number.isFinite(ageMs)) {
      lastActivityAgeSec = Math.max(0, Math.round(ageMs / 1000));
      // Stale threshold: 15 minutes. Heartbeats are required every 10
      // minutes per workflow.orchestrator.md; 15 gives a margin before
      // raising the "session may be stuck" flag.
      lastActivityStale = lastActivityAgeSec > 15 * 60;
    }
  }
  const lastActivityMessage =
    lastActivityEntry && lastActivityEntry.detail && lastActivityEntry.detail.message
      ? String(lastActivityEntry.detail.message)
      : null;

  // Build a story_key → issue_id lookup once so we can enrich every
  // reference (current story, recent events, etc.) without re-scanning
  // plan.stories each time.
  const issueIdByKey = new Map();
  if (plan && Array.isArray(plan.stories)) {
    for (const s of plan.stories) {
      if (s && typeof s.key === 'string' && typeof s.issue_id === 'string' && s.issue_id) {
        issueIdByKey.set(s.key, s.issue_id);
      }
    }
  }

  // Compute progress stats from plan when available, fall back to
  // sprint-status if not.
  const stats = computeProgressStats(plan, persisted);
  // Issue-tracking coverage: how many stories in the plan have an
  // issue_id linked. Surfaced only when an issue_tracker is configured —
  // otherwise the field is meaningless noise.
  const issueTracking = computeIssueTracking(plan);
  const filterStory = opts.story || persisted.current_story || null;
  const currentIssueId = filterStory ? issueIdByKey.get(filterStory) || null : null;

  // current_step falls back to the plan's per-story `current_step` field
  // (set by markRunning during cmdRecord) when no autopilot session is
  // running. Lets `autopilot progress --story X` show the last-known
  // phase even between sessions.
  let currentStep = persisted.current_bmad_step || null;
  if (!currentStep && filterStory && plan && Array.isArray(plan.stories)) {
    const entry = plan.stories.find((s) => s && s.key === filterStory);
    if (entry && typeof entry.current_step === 'string' && entry.current_step) {
      currentStep = entry.current_step;
    }
  }

  const out = {
    project_root: projectRoot,
    plan_present: plan !== null,
    plan_id: plan ? plan.plan_id : null,
    issue_tracker: plan ? plan.issue_tracker || null : null,
    current_story: filterStory,
    current_step: currentStep,
    current_issue_id: currentIssueId,
    sprint_progress: stats,
    issue_tracking: issueTracking,
    last_activity: lastActivityTs
      ? {
          ts: lastActivityTs,
          age_seconds: lastActivityAgeSec,
          stale: lastActivityStale,
          message: lastActivityMessage,
        }
      : null,
    recent_events: stepEvents.slice(-3).map((e) => {
      const storyKey = e.detail?.story_key || null;
      return {
        seq: e.seq,
        ts: e.ts,
        kind: e.kind,
        story_key: storyKey,
        step_name: e.detail?.step_name || null,
        outcome: e.detail?.outcome || null,
        // v2.3.0 — enrich with issue_id when the plan tracks one for
        // this story. Null when no plan or no issue_id set.
        issue_id: storyKey ? issueIdByKey.get(storyKey) || null : null,
      };
    }),
  };

  // If --story is set, also surface that story's plan entry.
  if (filterStory && plan && Array.isArray(plan.stories)) {
    const entry = plan.stories.find((s) => s && s.key === filterStory);
    if (entry) {
      out.story = {
        key: entry.key,
        epic: entry.epic,
        plan_status: entry.plan_status,
        current_step: entry.current_step || null,
        priority: entry.priority,
        bmad_status: entry.bmad_status,
        issue_id: entry.issue_id || null,
        completed_at: entry.completed_at || null,
      };
    }
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  }

  // Human-readable rendering (line-append, CI-safe — no ANSI codes).
  const lines = [];
  if (!out.plan_present) {
    lines.push('Sprint plan: (none) — running in sprint-status order');
  } else {
    lines.push(`Sprint plan: plan_id=${out.plan_id}`);
    lines.push(
      `Progress: ${stats.done}/${stats.total} done` +
        (stats.skipped > 0 ? ` (${stats.skipped} skipped)` : '') +
        (stats.excluded > 0 ? `, ${stats.excluded} excluded` : '') +
        `, ${stats.pending} pending`,
    );
    lines.push(`Bar: ${renderProgressBar(stats.done, stats.total)}`);
    if (issueTracking && issueTracking.provider) {
      lines.push(
        `Issue tracking: ${issueTracking.linked}/${issueTracking.total} stories linked to ${issueTracking.provider}` +
          (issueTracking.project_key ? ` (${issueTracking.project_key})` : ''),
      );
    }
  }
  if (out.current_story) {
    const issueBracket = out.current_issue_id ? ` [${out.current_issue_id}]` : '';
    lines.push(
      `Current story: ${out.current_story}${issueBracket}` +
        (out.current_step ? ` (step: ${out.current_step})` : ''),
    );
  } else {
    lines.push('Current story: (none — between stories or idle)');
  }
  // v2.3.10 — visibility: surface "last activity" so operators can tell
  // a live long-phase from a hung session at a glance.
  if (out.last_activity) {
    const ageSec = out.last_activity.age_seconds;
    let ageLabel = '?';
    if (typeof ageSec === 'number') {
      if (ageSec < 90) ageLabel = `${ageSec}s ago`;
      else if (ageSec < 3600) ageLabel = `${Math.round(ageSec / 60)}m ago`;
      else ageLabel = `${(ageSec / 3600).toFixed(1)}h ago`;
    }
    const staleFlag = out.last_activity.stale ? ' ⚠ STALE — exceeds 15-min heartbeat threshold' : '';
    lines.push(`Last activity: ${ageLabel}${staleFlag}`);
    if (out.last_activity.message) {
      lines.push(`  "${out.last_activity.message}"`);
    }
  }
  if (out.recent_events.length > 0) {
    lines.push('Recent step events:');
    for (const e of out.recent_events) {
      const storyLabel = e.story_key
        ? e.issue_id
          ? `${e.story_key} [${e.issue_id}]`
          : e.story_key
        : '-';
      lines.push(
        `  [${e.seq}] ${e.ts.slice(11, 19)} ${e.kind.replace(/^story_/, '')} — ${storyLabel} / ${e.step_name || '-'}` +
          (e.outcome ? ` (${e.outcome})` : ''),
      );
    }
  }
  if (out.story) {
    lines.push('Story detail:');
    lines.push(`  Key:           ${out.story.key}`);
    lines.push(`  Epic:          ${out.story.epic ?? '-'}`);
    lines.push(`  Plan status:   ${out.story.plan_status ?? '-'}`);
    lines.push(`  Bmad status:   ${out.story.bmad_status ?? '-'}`);
    lines.push(`  Priority:      ${out.story.priority ?? '-'}`);
    if (out.story.current_step) {
      lines.push(`  Current step:  ${out.story.current_step}`);
    }
    lines.push(`  Issue ID:      ${out.story.issue_id || '(not set)'}`);
    if (out.story.completed_at) {
      lines.push(`  Completed at:  ${out.story.completed_at}`);
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

// Compute issue-tracking coverage: how many of plan.stories[] have a
// non-empty issue_id field. Returns null when no plan or no
// issue_tracker is configured (irrelevant signal — skip the line entirely
// in human output rather than spam zeros).
function computeIssueTracking(plan) {
  if (!plan || !Array.isArray(plan.stories) || plan.stories.length === 0) return null;
  const tracker = plan.issue_tracker;
  if (!tracker || typeof tracker !== 'object' || !tracker.provider) return null;
  let linked = 0;
  for (const s of plan.stories) {
    if (s && typeof s.issue_id === 'string' && s.issue_id) linked += 1;
  }
  return {
    provider: tracker.provider,
    project_key: tracker.project_key || null,
    base_url: tracker.base_url || null,
    total: plan.stories.length,
    linked,
    coverage: plan.stories.length > 0 ? Math.round((linked / plan.stories.length) * 100) : 0,
  };
}

// Compute aggregate sprint progress from the plan (preferred) or fall
// back to sprint-status counts. Returns counts keyed by plan_status.
function computeProgressStats(plan, persisted) {
  if (plan && Array.isArray(plan.stories) && plan.stories.length > 0) {
    let done = 0;
    let pending = 0;
    let skipped = 0;
    let excluded = 0;
    for (const s of plan.stories) {
      if (!s) continue;
      if (s.plan_status === 'done') done += 1;
      else if (s.plan_status === 'skipped') skipped += 1;
      else if (s.plan_status === 'excluded') excluded += 1;
      else pending += 1;
    }
    return {
      total: plan.stories.length,
      done,
      pending,
      skipped,
      excluded,
      source: 'plan',
    };
  }
  // Fallback: sprint-status. We already have persisted.story_queue length
  // as a soft proxy for pending; sprint-status itself drives the count.
  return {
    total: null,
    done: null,
    pending: Array.isArray(persisted.story_queue) ? persisted.story_queue.length : null,
    skipped: null,
    excluded: null,
    source: 'sprint-status',
  };
}

function renderProgressBar(done, total) {
  if (!total || total <= 0) return '(no plan stories)';
  const width = 30;
  const filled = Math.min(width, Math.max(0, Math.round((done / total) * width)));
  return `[${'='.repeat(filled)}${' '.repeat(width - filled)}] ${Math.round((done / total) * 100)}%`;
}

// ------------------------------------------------------------ main

function main(argv) {
  const { opts, positional } = parseArgs(argv, {
    booleanFlags: [
      'help',
      'force',
      'accept-divergence',
      'no-auto-plan',
      'json',
      'once',
      // v2.4.0 — skip the background_full_suite_failed halt and ack
      // the latest sidecar. Used after the user has investigated the
      // failure and decided to proceed anyway.
      'ack-background-suite',
      // v2.5.0 observability — status formatter selectors + watch.
      'human',
      'legacy',
      // watch flag: --no-tui drops ANSI repainting. (--once is already
      // declared above for cmdNext.)
      'no-tui',
    ],
  });
  if (opts.help) {
    help();
    return 0;
  }
  // First positional = subcommand.
  const sub = positional[0];
  if (!sub) {
    help();
    return 1;
  }
  if (!SUBCOMMANDS.includes(sub)) {
    log.error(`unknown subcommand: ${sub}`);
    help();
    return 2;
  }
  try {
    switch (sub) {
      case 'start':
        return cmdStart(opts);
      case 'next':
        return cmdNext(opts);
      case 'record':
        return cmdRecord(opts);
      case 'state':
        return cmdState(opts);
      case 'report':
        return cmdReport(opts);
      case 'validate-config':
        return cmdValidateConfig(opts);
      case 'status':
        return cmdStatus(opts);
      case 'progress':
        return cmdProgress(opts);
      case 'heartbeat':
        return cmdHeartbeat(opts);
      case 'tasks':
        return cmdTasks(opts);
      case 'quarantine':
        return cmdQuarantine(opts, positional.slice(1));
      case 'watch':
        return cmdWatch(opts);
      default:
        return 2;
    }
  } catch (e) {
    log.error(`autopilot ${sub}: ${e.message}`);
    return 1;
  }
}

if (require.main === module) {
  const result = main(process.argv.slice(2));
  // v2.5.0 — `autopilot watch` returns a Promise<number> because it
  // tails the ledger via an async iterator. Other subcommands stay
  // synchronous and return a number directly. Handle both shapes.
  if (result && typeof result.then === 'function') {
    Promise.resolve(result)
      .then((code) => process.exit(typeof code === 'number' ? code : 0))
      .catch((e) => {
        log.error(`autopilot: ${e.message}`);
        process.exit(1);
      });
  } else {
    process.exit(typeof result === 'number' ? result : 0);
  }
}

module.exports = {
  main,
  SUBCOMMANDS,
  decorateGitOp,
  decorateRunScript,
  composeRuntimeState,
  acquireAutopilotLock,
  runWorktreeHealthCheck,
  // v2.5.0 observability helpers (exposed for unit tests).
  buildRichStatus,
  renderStatusHuman,
  formatWatchEventLine,
  // v2.3.12 — task list helpers exposed for unit tests
  STORY_TASK_DEFINITIONS,
  STORY_PHASE_ORDER,
  deriveTasksForStory,
  tasksToMarkdown,
  // v2.3.13 — boot-time sprint-status reconciliation helper
  reconcileWithSprintStatus,
};
