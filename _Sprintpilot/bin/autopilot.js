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
const decisionLog = require('../lib/orchestrator/decision-log');
const userCommands = require('../lib/orchestrator/user-commands');
const divergence = require('../lib/orchestrator/divergence');
const reportRenderer = require('../lib/orchestrator/report');
const gitPlan = require('../lib/orchestrator/git-plan');
const land = require('../lib/orchestrator/land');
const {
  parseStatuses: parseSprintStatuses,
  remainingFrom: remainingStoriesFrom,
} = require('../scripts/list-remaining-stories');

const { STATES } = stateMachine;

const SUBCOMMANDS = ['start', 'next', 'record', 'state', 'report', 'validate-config', 'status'];

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
    // Filter them out so we don't ask the orchestrator to branch on an
    // epic identifier (the v2.1.4 hotfix shipped without this filter and
    // a user reported branch: story/epic-4 instead of story/4-8-...).
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
//   - `epic-N` shape (epic-rollup header) — the v2.1.3/v2.1.4 poison
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
    return 'matches epic-rollup header shape (epic-N or bare N) — v2.1.3/v2.1.4 poisoned state';
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
  return null;
}

// Catch only the documented poisoned shapes that pre-v2.1.5 orchestrator
// versions could write to persisted.current_story:
//   - `epic-N` with no further hyphen-separated segments (epic rollup
//     header — composeRuntimeState in v2.1.3/v2.1.4 picked this as the
//     first non-done entry before the looksLikeStoryKey filter shipped).
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
// Reject (2) and (3). The v2.1.4 hotfix shipped without this filter and
// the user reported `branch: story/epic-4` instead of the real next
// pending story. The v2.1.5 hotfix extends the filter to retrospectives
// after a follow-up report.
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

// Resolve all non-done story keys for the given epic id, in
// sprint-status.yaml insertion order. Used by `autopilot start
// --epic <id>` to expand into an explicit queue. Returns [] when:
//   - sprint-status doesn't exist or fails to parse
//   - no stories match the epic
//   - all matching stories are already done
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
    if (status === 'done') continue;
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
  // trusting it. Older orchestrator versions (v2.1.3 / v2.1.4) could
  // poison this field with an epic-rollup header (e.g. `epic-4`) when
  // resolveNextStoryKey scanned sprint-status without filtering. The
  // v2.1.5 hotfix added looksLikeStoryKey but only at resolution time —
  // already-persisted poisoned values ride forward through every
  // upgrade, producing emissions like `branch: story/epic-4` on every
  // session boot.
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
      // enforces it). Pre-2.2.9 fix: any "done" rejection nulled
      // story_key mid-record, producing branch "story/unknown" on
      // commit_and_push_story.
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
            'This typically means state was poisoned by an older orchestrator version (v2.1.3 / v2.1.4 pre-filter); ' +
            'next emission will clean it up.\n',
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

  // Count non-done stories in the current epic. state-machine.js's
  // EPIC_BOUNDARY_CHECK reads this to decide between RETROSPECTIVE (end
  // of epic, count === 0) and next-story-start (count > 0). Pre-2.2.2
  // this field was passthrough-only — never written by the orchestrator
  // — so the count stayed at 0 and EVERY story triggered a
  // retrospective. Now: recompute from sprint-status.yaml each emission
  // when current_epic is known.
  //
  // Count semantics: excludes done stories AND non-story entries (epic
  // rollup headers, -retrospective entries) via the same looksLikeStoryKey
  // filter resolveNextStoryKey uses.
  let remainingStoriesInEpic = persisted.remaining_stories_in_epic || 0;
  if (resolvedEpic && projectRoot) {
    const epicStories = resolveStoriesForEpic(projectRoot, resolvedEpic);
    remainingStoriesInEpic = epicStories.length;
  }

  // Catch-all guard: if state.phase REQUIRES a story_key to emit a
  // coherent action AND we still don't have one after every resolution
  // path (queue / validator / sprint-status), reset phase to flowStart.
  //
  // Real-world scenario: a previous orchestrator version nulled
  // current_story (e.g., v2.2.4's overzealous rejection) but didn't
  // reset state.phase. Persisted state ends up with current_story: null
  // at story_done. v2.2.9's reset only fires inside the rejection branch,
  // so a NULL story_key doesn't trigger it (no rejection to fire). This
  // guard catches that case + any future bug class where story_key
  // ends up null at a story-bound phase.
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

// run_script actions for op=land_story carry only metadata (helper,
// land_when, squash_on_merge, ...) — the state machine's comment
// promises "The CLI edge composes the actual argv via land.js#planLand"
// but that wiring was missing pre-v2.2.12. Without it, LLMs driving
// land_as_you_go got a metadata-only action and had to improvise.
// Symmetric to decorateGitOp: call land.planLand(state, profile,
// options), inline the resulting `steps[]` onto the action.
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
      const planned = land.planLand(state, profile, {
        scriptsDir,
        snapshotPath,
        branch,
        platform,
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

function applySideEffects(sideEffects, runtime, profile, projectRoot) {
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
      default:
        // Unknown side-effect kinds are recorded but otherwise ignored.
        ledger.append({ kind: 'state_transition', detail: eff }, { projectRoot });
    }
  }
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
  const lastHalt = ledger.last({ projectRoot }, 'halt');
  if (lastHalt && lastHalt.fingerprint) {
    const d = divergence.detect({ projectRoot }, lastHalt.fingerprint);
    if (!d.identical) {
      const result = {
        kind: 'resume_divergence',
        differences: d.differences,
        last_phase: persisted.current_bmad_step || null,
      };
      ledger.append({ kind: 'resume', divergence: result }, { projectRoot });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
  }

  // .autopilot.lock — acquire before any state mutation. If another
  // session holds the lock (and it isn't ours and isn't stale), bail out
  // with a user_prompt action so the LLM/user knows to either wait or
  // run `sprint-autopilot-off` in the other session.
  const lockOutcome = acquireAutopilotLock(persisted, profile, projectRoot);
  if (!lockOutcome.acquired) {
    const haltAction = {
      type: 'user_prompt',
      reason: 'autopilot_lock_held',
      prompt:
        `Another autopilot session holds .autopilot.lock (session ${lockOutcome.holder}, age ${lockOutcome.ageMin}m). ` +
        `Wait for it to finish, run \`/sprint-autopilot-off\` in the other session, or delete .autopilot.lock if you're sure the holder crashed.`,
      holder: lockOutcome.holder,
      age_minutes: lockOutcome.ageMin,
    };
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

  // parallel_stories: surface honestly that the documented flag is not
  // yet wired through the BMad state machine. The supporting pieces
  // (planBatch, dispatch-layer.js, agent-adapter.js, merge-shards.js)
  // exist as building blocks but nextAction never emits a parallel_batch
  // action — every story still flows through the 7-phase cycle one at a
  // time. A user who sets `ma.parallel_stories: true` and doesn't see
  // this notice would assume parallelism is happening when it isn't.
  if (profile.parallel_stories) {
    ledger.append(
      {
        kind: 'state_transition',
        detail: {
          parallel_stories_experimental_warning:
            'ma.parallel_stories=true is honored by the planBatch / dispatch-layer.js building blocks but the BMad state machine still emits one story at a time. Full intra-epic parallel dispatch is tracked for v2.3.0+. Stories continue sequentially in this session.',
        },
      },
      { projectRoot },
    );
    process.stderr.write(
      '[autopilot] WARN ma.parallel_stories=true but the state machine is not yet wired for parallel dispatch (planned for v2.3.0). Stories will run sequentially this session.\n',
    );
  }
  if (profile.lint_enabled) {
    // Same honesty pattern as parallel_stories. Config is parsed; no
    // state-machine integration yet. Users on lint_enabled=true would
    // otherwise assume lint runs post-DEV_GREEN — it doesn't.
    ledger.append(
      {
        kind: 'state_transition',
        detail: {
          lint_experimental_warning:
            'git.lint.enabled=true: config is read into the typed Profile but the state machine has no LINT_CHECK phase yet. Lint enforcement (per-language linters, blocking/non-blocking gate, output_limit) is tracked for v2.3.0+. Until then, bake lint into your test command (bmad-dev-story GREEN phase will catch failures).',
        },
      },
      { projectRoot },
    );
    process.stderr.write(
      '[autopilot] WARN git.lint.enabled=true but no LINT_CHECK phase exists yet (planned for v2.3.0). Bake lint into your test command for now.\n',
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
    const haltAction = {
      type: 'user_prompt',
      reason: 'worktree_orphans_detected',
      prompt: healthOutcome.prompt,
      orphans: healthOutcome.orphans,
      summary: healthOutcome.summary,
    };
    ledger.append(
      { kind: 'action_emitted', phase: persisted.current_bmad_step || null, action: haltAction },
      { projectRoot },
    );
    process.stdout.write(
      `${JSON.stringify({ action: haltAction, phase: persisted.current_bmad_step || null }, null, 2)}\n`,
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
    ledger.append(
      { kind: 'action_emitted', phase: runtime.phase, action: lockResult.halt },
      { projectRoot },
    );
    process.stdout.write(
      `${JSON.stringify({ action: lockResult.halt, phase: runtime.phase }, null, 2)}\n`,
    );
    return 0;
  }

  const action = decorateRunScript(
    decorateGitOp(stateMachine.nextAction(runtime, profile), runtime, profile, projectRoot),
    runtime,
    profile,
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

  // The LLM-driven workflow (workflow.orchestrator.md) tells the LLM to
  // call `next` directly without `start` — apply the same branch-reuse
  // enforcement here so a missed `start` doesn't bypass it.
  const lockResult = lockUserBranchIfNeeded(runtime, profile, projectRoot);
  if (lockResult && lockResult.halt) {
    ledger.append(
      { kind: 'action_emitted', phase: runtime.phase, action: lockResult.halt },
      { projectRoot },
    );
    process.stdout.write(
      `${JSON.stringify({ action: lockResult.halt, phase: runtime.phase }, null, 2)}\n`,
    );
    return 0;
  }

  const action = decorateRunScript(
    decorateGitOp(stateMachine.nextAction(runtime, profile), runtime, profile, projectRoot),
    runtime,
    profile,
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
    verifyResult = verifyMod.verify(runtime, signal.output, { projectRoot });
    ledger.append(
      { kind: 'verify_result', phase: runtime.phase, ok: verifyResult.ok, issues: verifyResult.issues || [] },
      { projectRoot },
    );
  } else if (signal.status === 'verify_override') {
    verifyResult = verifyMod.verifyWithOverride(
      runtime,
      signal.output || {},
      { projectRoot },
      signal.evidence || {},
    );
    ledger.append(
      { kind: 'verify_result', phase: runtime.phase, ok: verifyResult.ok, issues: verifyResult.issues || [] },
      { projectRoot },
    );
  }

  const result = adapt.interpretSignal(runtime, signal, profile, verifyResult);
  applySideEffects(result.sideEffects, result.newState, result.newProfile, projectRoot);

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

  // Story-boundary or halt → flush coalesce buffer if enabled.
  const isStoryBoundary =
    result.newState.phase === STATES.STORY_DONE ||
    result.newState.phase === STATES.EPIC_BOUNDARY_CHECK ||
    result.newState.phase === STATES.SPRINT_FINALIZE_PENDING ||
    result.verdict === 'halt';
  if (result.newProfile.coalesce_state_writes && isStoryBoundary) {
    stateStore.flush(result.newProfile, { projectRoot, story: result.newState.story_key });
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
    action: decorateRunScript(
      decorateGitOp(result.nextAction, result.newState, result.newProfile, projectRoot),
      result.newState,
      result.newProfile,
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

function cmdStatus(opts) {
  const projectRoot = resolveProjectRoot(opts);
  const persisted = loadState(projectRoot);
  const story = persisted.current_story || '-';
  const step = persisted.current_bmad_step || '-';
  process.stdout.write(`story=${story} step=${step}\n`);
  return 0;
}

// ------------------------------------------------------------ main

function main(argv) {
  const { opts, positional } = parseArgs(argv, { booleanFlags: ['help', 'force'] });
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
      default:
        return 2;
    }
  } catch (e) {
    log.error(`autopilot ${sub}: ${e.message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  main,
  SUBCOMMANDS,
  decorateGitOp,
  decorateRunScript,
  composeRuntimeState,
  acquireAutopilotLock,
  runWorktreeHealthCheck,
};
