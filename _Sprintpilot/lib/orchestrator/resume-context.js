// resume-context.js — v2.6.0 resume mid-skill.
//
// On every `autopilot start` the CLI edge asks this module two
// questions:
//
//   1. detect(state, ledger) — did the previous session interrupt a
//      skill mid-execution? Answer is a small object describing whether
//      we're resuming, which phase, and the trail of evidence
//      (last action_emitted, last signal_recorded, last
//      skill_checkpoint) that drove the decision.
//
//   2. build(detection, world) — given the detection result and a
//      `world` bundle of observable facts (git diff names, story file
//      checkboxes, last test result, patch_commits), produce a
//      structured `resume_hint` the CLI threads into the next
//      invoke_skill action's template_slots.
//
// The module is pure: no fs/git/network I/O. The CLI edge gathers
// world data via spawnSync git + fs reads then hands it in. This keeps
// the detection logic unit-testable without setting up a full project
// tree, and matches the layering of state-machine.js / adapt.js.
//
// Phases:
//   - DEV_RED / DEV_GREEN / PATCH_APPLY / PATCH_RETEST / NANO_QUICK_DEV
//     get the rich hint (git diff + AC checkboxes + tests + patches).
//   - CODE_REVIEW / RETROSPECTIVE get a minimal hint (phase was
//     already running; here's the elapsed time + checkpoint if any).
//   - CREATE_STORY / CHECK_READINESS get a stub hint (phase was
//     interrupted; story file may already exist on disk).
//
// Skills that don't know about resume_hint ignore it (it's just an
// extra slot). Skills that do can use it to skip already-done work.

'use strict';

const { STATES } = require('./state-machine');

// Phases for which `detect()` is meaningful. Only invoke_skill phases —
// git_op / run_script / noop phases re-execute idempotently on restart
// and don't need a hint. (PREPARE_STORY_BRANCH degrades `git switch -c`
// to `git switch` automatically when the branch already exists; STORY_
// DONE / MERGE_EPIC / STORY_LAND retry their own argv steps.)
const RESUMABLE_PHASES = new Set([
  STATES.CREATE_STORY,
  STATES.CHECK_READINESS,
  STATES.DEV_RED,
  STATES.DEV_GREEN,
  STATES.CODE_REVIEW,
  STATES.PATCH_APPLY,
  STATES.PATCH_RETEST,
  STATES.RETROSPECTIVE,
  STATES.NANO_QUICK_DEV,
]);

// Rich-hint phases get the full evidence bundle. Other resumable
// phases get only the minimal stub.
const RICH_HINT_PHASES = new Set([
  STATES.DEV_RED,
  STATES.DEV_GREEN,
  STATES.PATCH_APPLY,
  STATES.PATCH_RETEST,
  STATES.NANO_QUICK_DEV,
]);

// Ledger entry kinds that signal the phase has reached a terminal /
// observable boundary AFTER the action was emitted. Seeing any of these
// for the same phase after `action_emitted` means we are NOT mid-skill.
//
// `signal_recorded` is the canonical terminal — the skill returned a
// signal which adapt.js then interpreted (success → next phase, failure
// → retry, etc.). `halt` and `phase_resumed` are also terminal: a
// previous boot already detected and serviced this interruption.
const TERMINAL_KINDS = new Set(['signal_recorded', 'halt', 'phase_resumed']);

// detect(state, ledger) → { resuming, phase, story_key, reason, evidence }
//
//   state    — persisted runtime state (autopilot-state.yaml shape)
//   ledger   — array of ledger entries, oldest first (the shape produced
//              by action-ledger.read())
//
// Returns:
//   { resuming: false }                — nothing to resume
//   { resuming: true, phase, story_key, reason, evidence }
//
// `reason` is one of:
//   - 'skill_interrupted'    — action_emitted (invoke_skill) without a
//                              subsequent terminal entry
//   - 'manual_resume'        — called via `autopilot resume` regardless
//                              of detection; caller passes
//                              `{ force: true }`
function detect(state, ledger, options) {
  if (!state || typeof state !== 'object') return { resuming: false };
  const phase = state.current_bmad_step || state.phase || null;
  if (!phase || !RESUMABLE_PHASES.has(phase)) return { resuming: false };

  // Walk backwards over the ledger. We want the most recent
  // action_emitted whose action.phase matches the current phase, then
  // check whether anything terminal (signal_recorded / halt /
  // phase_resumed) was logged after it for the same phase.
  //
  // We compare action.phase rather than entry.phase because the
  // action_emitted entry's top-level `phase` was added in v2.3.x; older
  // ledgers may not have it. action.phase is set by state-machine.js
  // for every invoke_skill action and is the source of truth.
  const entries = Array.isArray(ledger) ? ledger : [];
  let lastInvoke = null;
  let lastInvokeIdx = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (!e || e.kind !== 'action_emitted') continue;
    const action = e.action || {};
    if (action.type !== 'invoke_skill') continue;
    const actionPhase = action.phase || e.phase || null;
    if (actionPhase !== phase) continue;
    lastInvoke = e;
    lastInvokeIdx = i;
    break;
  }
  if (lastInvoke === null) {
    // No invoke_skill was emitted for this phase yet — either we
    // haven't reached it, or only git_op / noop phases preceded it.
    // Honour an explicit force flag from `autopilot resume`.
    if (options && options.force) {
      return {
        resuming: true,
        phase,
        story_key: state.current_story || state.story_key || null,
        reason: 'manual_resume',
        evidence: {
          last_action_emitted_at: null,
          last_signal_at: null,
          last_checkpoint: null,
        },
      };
    }
    return { resuming: false };
  }

  // Scan forwards from lastInvokeIdx+1 for a terminal entry tied to
  // this phase. signal_recorded carries its own `phase` field; halt
  // entries carry `phase` on the action; phase_resumed (v2.6.0) tags
  // the phase it serviced.
  let terminal = null;
  let lastCheckpoint = null;
  let lastSignalAt = null;
  for (let i = lastInvokeIdx + 1; i < entries.length; i += 1) {
    const e = entries[i];
    if (!e) continue;
    if (e.kind === 'skill_checkpoint') {
      const cpPhase = e.phase || (e.checkpoint && e.checkpoint.phase) || null;
      if (cpPhase === phase || cpPhase === null) {
        lastCheckpoint = e;
      }
      continue;
    }
    if (!TERMINAL_KINDS.has(e.kind)) continue;
    const entryPhase = e.phase || (e.action && e.action.phase) || null;
    if (entryPhase && entryPhase !== phase) continue;
    terminal = e;
    if (e.kind === 'signal_recorded') lastSignalAt = e.ts || null;
    break;
  }

  if (terminal) {
    // Phase reached a terminal entry — nothing to resume. Honour
    // explicit force the same way as the no-invoke path: a manual
    // resume should always re-emit the hint so the user can recover
    // from "skill said success but I crashed before writing the
    // signal" type ambiguity.
    if (options && options.force) {
      return {
        resuming: true,
        phase,
        story_key: state.current_story || state.story_key || null,
        reason: 'manual_resume',
        evidence: {
          last_action_emitted_at: lastInvoke.ts || null,
          last_signal_at: lastSignalAt,
          last_checkpoint: lastCheckpoint || null,
        },
      };
    }
    return { resuming: false };
  }

  return {
    resuming: true,
    phase,
    story_key: state.current_story || state.story_key || null,
    reason: 'skill_interrupted',
    evidence: {
      last_action_emitted_at: lastInvoke.ts || null,
      last_signal_at: lastSignalAt,
      last_checkpoint: lastCheckpoint || null,
    },
  };
}

// build(detection, world) → resume_hint | null
//
// Returns null when detection.resuming is false. Otherwise a
// structured hint suitable for the template_slots:
//
//   {
//     phase,                  // resumable phase
//     story_key,
//     reason,                 // 'skill_interrupted' | 'manual_resume'
//     interrupted_at,         // ISO ts of the last action_emitted
//     phase_started_at,       // ISO ts when the phase first entered
//     elapsed_minutes,        // wall-clock minutes from phase entry → now
//     checkpoint,             // last skill_checkpoint payload or null
//     changed_files,          // array of file paths (rich-hint phases only)
//     ac_completed,           // array of AC titles checked-off in story file
//     ac_total,               // total ACs found
//     last_test_result,       // { ok, summary } or null
//     patches_landed,         // patch_commits from state (PATCH_RETEST only)
//     summary,                // one-line human-readable description
//   }
//
// `world` shape:
//   {
//     now:               ISO string,
//     phase_started_at:  ISO string or null,
//     changed_files:     string[],
//     ac_completed:      string[],
//     ac_total:          number,
//     last_test_result:  { ok, summary } | null,
//     patches_landed:    array | null,
//   }
function build(detection, world) {
  if (!detection || !detection.resuming) return null;
  const w = world || {};
  const phase = detection.phase;
  const isRich = RICH_HINT_PHASES.has(phase);

  const elapsed = elapsedMinutes(w.phase_started_at, w.now);
  const checkpoint = detection.evidence && detection.evidence.last_checkpoint
    ? extractCheckpointPayload(detection.evidence.last_checkpoint)
    : null;

  const hint = {
    phase,
    story_key: detection.story_key || null,
    reason: detection.reason,
    interrupted_at: (detection.evidence && detection.evidence.last_action_emitted_at) || null,
    phase_started_at: w.phase_started_at || null,
    elapsed_minutes: elapsed,
    checkpoint,
  };

  if (isRich) {
    hint.changed_files = Array.isArray(w.changed_files) ? w.changed_files.slice(0, 50) : [];
    hint.ac_completed = Array.isArray(w.ac_completed) ? w.ac_completed.slice(0, 50) : [];
    hint.ac_total =
      typeof w.ac_total === 'number' && w.ac_total >= 0 ? w.ac_total : hint.ac_completed.length;
    hint.last_test_result = isTestResult(w.last_test_result) ? w.last_test_result : null;
    hint.patches_landed =
      phase === STATES.PATCH_RETEST || phase === STATES.PATCH_APPLY
        ? Array.isArray(w.patches_landed)
          ? w.patches_landed.slice()
          : []
        : null;
  } else {
    hint.changed_files = null;
    hint.ac_completed = null;
    hint.ac_total = null;
    hint.last_test_result = null;
    hint.patches_landed = null;
  }

  hint.summary = renderSummary(hint);
  return hint;
}

function elapsedMinutes(startedAt, nowIso) {
  if (typeof startedAt !== 'string' || !startedAt) return null;
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return null;
  const nowParsed = typeof nowIso === 'string' ? Date.parse(nowIso) : Number(nowIso);
  const now = Number.isFinite(nowParsed) ? nowParsed : Date.now();
  const min = (now - started) / 60_000;
  return Math.round(min * 10) / 10;
}

function isTestResult(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

// Pull a checkpoint payload out of a ledger entry. The skill emits
// `signal.output.checkpoint` and cmdRecord persists the whole payload
// under `entry.checkpoint`. We expose only the documented fields so a
// rogue skill can't smuggle arbitrary data into the template.
function extractCheckpointPayload(entry) {
  if (!entry || !entry.checkpoint || typeof entry.checkpoint !== 'object') return null;
  const cp = entry.checkpoint;
  return {
    ts: entry.ts || null,
    summary: typeof cp.summary === 'string' ? cp.summary : null,
    ac_done: Array.isArray(cp.ac_done)
      ? cp.ac_done.filter((s) => typeof s === 'string').slice(0, 50)
      : [],
    tests_passing: Array.isArray(cp.tests_passing)
      ? cp.tests_passing.filter((s) => typeof s === 'string').slice(0, 50)
      : [],
    tests_failing: Array.isArray(cp.tests_failing)
      ? cp.tests_failing.filter((s) => typeof s === 'string').slice(0, 50)
      : [],
    files_touched: Array.isArray(cp.files_touched)
      ? cp.files_touched.filter((s) => typeof s === 'string').slice(0, 50)
      : [],
    next_step: typeof cp.next_step === 'string' ? cp.next_step : null,
  };
}

function renderSummary(hint) {
  const bits = [];
  bits.push(`phase ${hint.phase} was interrupted`);
  if (hint.elapsed_minutes !== null) {
    bits.push(`(${hint.elapsed_minutes}m elapsed)`);
  }
  if (hint.ac_completed && hint.ac_completed.length > 0) {
    bits.push(`— ${hint.ac_completed.length}/${hint.ac_total} AC already checked off`);
  }
  if (hint.changed_files && hint.changed_files.length > 0) {
    bits.push(`; ${hint.changed_files.length} file(s) modified since phase start`);
  }
  if (hint.checkpoint && hint.checkpoint.summary) {
    bits.push(`; last checkpoint: ${hint.checkpoint.summary}`);
  }
  if (hint.last_test_result) {
    const r = hint.last_test_result;
    if (r.summary) bits.push(`; last test run: ${r.summary}`);
    else if (typeof r.ok === 'boolean') bits.push(`; last test run: ${r.ok ? 'pass' : 'fail'}`);
  }
  return bits.join(' ');
}

// Validate that a payload received via signal.output.checkpoint
// matches the documented contract. Returns the normalised payload or
// null if the input is unusable. Called from cmdRecord before
// appending the `skill_checkpoint` ledger entry.
function normaliseCheckpoint(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {
    summary: typeof raw.summary === 'string' ? raw.summary.slice(0, 500) : null,
    ac_done: Array.isArray(raw.ac_done)
      ? raw.ac_done.filter((s) => typeof s === 'string' && s.length > 0).slice(0, 50)
      : [],
    tests_passing: Array.isArray(raw.tests_passing)
      ? raw.tests_passing.filter((s) => typeof s === 'string' && s.length > 0).slice(0, 50)
      : [],
    tests_failing: Array.isArray(raw.tests_failing)
      ? raw.tests_failing.filter((s) => typeof s === 'string' && s.length > 0).slice(0, 50)
      : [],
    files_touched: Array.isArray(raw.files_touched)
      ? raw.files_touched.filter((s) => typeof s === 'string' && s.length > 0).slice(0, 50)
      : [],
    next_step: typeof raw.next_step === 'string' ? raw.next_step.slice(0, 500) : null,
  };
  // Reject the payload if every field is empty — nothing to persist.
  const hasContent =
    out.summary ||
    out.ac_done.length > 0 ||
    out.tests_passing.length > 0 ||
    out.tests_failing.length > 0 ||
    out.files_touched.length > 0 ||
    out.next_step;
  if (!hasContent) return null;
  return out;
}

// Parse the markdown ## Acceptance Criteria section of a story file
// and return the AC titles plus which are checked off (`- [x]` vs
// `- [ ]`). Defensive: returns `{ completed: [], total: 0 }` on any
// parse failure so the caller can degrade to a hint with no AC data.
//
// Heuristic — the BMad story template puts ACs as a markdown list
// under an `## Acceptance Criteria` heading. Each item starts with
// `- [ ]` or `- [x]`. We collect them in order, splitting completion
// from the title text.
function parseAcceptanceCriteria(storyMarkdown) {
  if (typeof storyMarkdown !== 'string' || !storyMarkdown) {
    return { completed: [], total: 0 };
  }
  const lines = storyMarkdown.split(/\r?\n/);
  let inSection = false;
  let inFence = false;
  const completed = [];
  let total = 0;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const text = heading[2].trim().toLowerCase();
      // Enter the section on a heading that mentions "acceptance".
      // Exit when we hit any subsequent same-or-higher heading that
      // doesn't mention acceptance.
      if (/acceptance/.test(text)) {
        inSection = true;
        continue;
      }
      if (inSection) {
        // Leaving the section.
        inSection = false;
      }
      continue;
    }
    if (!inSection) continue;
    const item = line.match(/^\s*-\s+\[([ xX])\]\s+(.+)$/);
    if (!item) continue;
    total += 1;
    if (item[1].toLowerCase() === 'x') {
      completed.push(item[2].trim());
    }
  }
  return { completed, total };
}

// Find the most recent verify_result entry and translate it into the
// hint shape `{ ok, summary }`. Returns null if no verify result has
// been recorded for the current phase.
function lastTestResultFromLedger(ledger, phase) {
  if (!Array.isArray(ledger) || !phase) return null;
  for (let i = ledger.length - 1; i >= 0; i -= 1) {
    const e = ledger[i];
    if (!e || e.kind !== 'verify_result') continue;
    if (e.phase && e.phase !== phase) continue;
    return {
      ok: e.ok === true,
      summary: Array.isArray(e.issues) && e.issues.length > 0
        ? `${e.ok ? 'ok' : 'failed'}: ${e.issues.slice(0, 3).join('; ')}`
        : e.ok
          ? 'verify_ok'
          : 'verify_failed',
    };
  }
  return null;
}

module.exports = {
  RESUMABLE_PHASES,
  RICH_HINT_PHASES,
  TERMINAL_KINDS,
  detect,
  build,
  normaliseCheckpoint,
  parseAcceptanceCriteria,
  lastTestResultFromLedger,
  // Exposed for tests + the autopilot CLI's world-bundle assembler.
  elapsedMinutes,
};
