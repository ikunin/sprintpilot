#!/usr/bin/env node

// sprint-plan.js — read/write Sprintpilot's unified sprint plan file.
//
// The plan file at _bmad-output/implementation-artifacts/sprint-plan.yaml
// is Sprintpilot-owned and holds:
//   - dependency graph (per-epic + cross-epic edges)
//   - story execution plan (priorities, plan_status, issue_ids)
//   - per-entity bmad_status CACHE (refreshed from sprint-status.yaml on read)
//   - auto-derive lifecycle status block
//   - free-form user notes from the planning skill
//
// All writes are atomic (tmp+rename). Callers that hold cross-operation
// invariants (skill curation, autopilot markDone-then-render) should
// acquire `.sprintpilot/plan.lock` via lock.js around their session.
//
// Phase 0 minimum: read + write + emptyPlan + validatePlan. The richer
// primitives (markDone, addStories, reorder, refreshBmadStatus, etc.)
// land in Phase 2.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');

const LOCK_SCRIPT_PATH = path.join(__dirname, 'lock.js');

const SCHEMA_VERSION = 1;
const PLAN_FILE_REL = path.join('_bmad-output', 'implementation-artifacts', 'sprint-plan.yaml');
const LOCK_FILE_REL = path.join('.sprintpilot', 'plan.lock');
const LOCK_STALE_MINUTES = 5;

const VALID_COMMANDS = ['read', 'write', 'validate', 'empty'];
const VALID_SOURCES = ['skill', 'auto', 'cli', 'migrated'];

function planPath(projectRoot) {
  return path.join(projectRoot, PLAN_FILE_REL);
}

function lockPath(projectRoot) {
  return path.join(projectRoot, LOCK_FILE_REL);
}

// Build a valid empty plan suitable as a starting point for skill / migrate /
// bootstrap flows. status.last_run_outcome reflects the bootstrap intent.
function emptyPlan({ source = 'skill' } = {}) {
  if (!VALID_SOURCES.includes(source)) {
    throw new Error(
      `invalid source ${JSON.stringify(source)}; expected one of ${VALID_SOURCES.join(', ')}`,
    );
  }
  const now = new Date().toISOString();
  return {
    schema_version: SCHEMA_VERSION,
    generated: now,
    source,
    plan_id: crypto.randomUUID(),
    deps_inferred_at: null,
    status: {
      last_run_outcome: 'success',
      last_run_at: now,
      last_error: null,
    },
    issue_tracker: null,
    epics: [],
    stories: [],
    dependencies: {
      version: 1,
      auto_inferred_at: null,
      stories: {},
    },
    cross_epic_deps: [],
    overrides: [],
    notes: '',
  };
}

// Schema validation. Returns null when valid, else { code, message, ...details }.
// All errors are recoverable — callers never see a thrown exception from here.
function validatePlan(plan) {
  if (plan === null || plan === undefined || typeof plan !== 'object' || Array.isArray(plan)) {
    return { code: 'invalid_root', message: 'plan must be a YAML mapping' };
  }
  if (plan.schema_version === undefined || plan.schema_version === null) {
    return { code: 'missing_schema_version', message: 'plan is missing schema_version' };
  }
  if (plan.schema_version !== SCHEMA_VERSION) {
    return {
      code: 'unsupported_version',
      message: `expected schema_version=${SCHEMA_VERSION}, got ${JSON.stringify(plan.schema_version)} — upgrade Sprintpilot`,
    };
  }
  const required = ['status', 'epics', 'stories', 'dependencies', 'cross_epic_deps', 'overrides'];
  const missing = required.filter((k) => !(k in plan));
  if (missing.length > 0) {
    return {
      code: 'incomplete_schema',
      message: `missing required top-level keys: ${missing.join(', ')}`,
      missing_keys: missing,
    };
  }
  if (!plan.status || typeof plan.status !== 'object' || Array.isArray(plan.status)) {
    return { code: 'invalid_status', message: 'status must be a mapping' };
  }
  if (!Array.isArray(plan.epics)) {
    return { code: 'invalid_epics', message: 'epics must be a list' };
  }
  if (!Array.isArray(plan.stories)) {
    return { code: 'invalid_stories', message: 'stories must be a list' };
  }
  if (
    !plan.dependencies ||
    typeof plan.dependencies !== 'object' ||
    Array.isArray(plan.dependencies)
  ) {
    return { code: 'invalid_dependencies', message: 'dependencies must be a mapping' };
  }
  if (
    !plan.dependencies.stories ||
    typeof plan.dependencies.stories !== 'object' ||
    Array.isArray(plan.dependencies.stories)
  ) {
    return {
      code: 'invalid_dependencies_stories',
      message: 'dependencies.stories must be a mapping',
    };
  }
  if (!Array.isArray(plan.cross_epic_deps)) {
    return { code: 'invalid_cross_epic_deps', message: 'cross_epic_deps must be a list' };
  }
  if (!Array.isArray(plan.overrides)) {
    return { code: 'invalid_overrides', message: 'overrides must be a list' };
  }
  return null;
}

// Read plan from disk.
// Returns:
//   null                      — file does not exist (caller may bootstrap)
//   { error, path, message }  — file exists but parse / schema failed
//   plan object               — valid plan loaded
function read({ projectRoot }) {
  const file = planPath(projectRoot);
  if (!fs.existsSync(file)) return null;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { error: 'read_failed', path: file, message: e.message };
  }
  let plan;
  try {
    plan = yaml.load(raw);
  } catch (e) {
    return { error: 'parse_error', path: file, message: e.message };
  }
  const err = validatePlan(plan);
  if (err) {
    return {
      error: err.code,
      path: file,
      message: err.message,
      ...(err.missing_keys ? { missing_keys: err.missing_keys } : {}),
    };
  }
  return plan;
}

// Atomic write. Caller is responsible for serialization (plan.lock) when
// concurrent writers may interleave (skill rewrite vs autopilot markDone).
// Single-write callers can rely on tmp+rename atomicity alone.
function writeAtomic(file, body) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.tmp.${process.pid}.${process.hrtime.bigint().toString(36)}`,
  );
  const fd = fs.openSync(tmp, 'w', 0o644);
  try {
    fs.writeFileSync(fd, body);
    try {
      fs.fsyncSync(fd);
    } catch {
      /* fsync unsupported on some filesystems */
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  if (process.platform !== 'win32') {
    try {
      const dfd = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(dfd);
      } finally {
        fs.closeSync(dfd);
      }
    } catch {
      /* directory fsync unsupported on some filesystems */
    }
  }
}

// Write plan. Validates schema, stamps `generated`, serializes via js-yaml,
// atomic tmp+rename. Throws (with a descriptive message) on validation
// failure — write() is for callers that know they have a valid plan; for
// LLM-produced or user-edited content, validate via validatePlan() first.
function write(plan, { projectRoot }) {
  const err = validatePlan(plan);
  if (err) {
    throw new Error(`invalid plan: ${err.message}`);
  }
  // Stamp generated timestamp on every successful write — provides a
  // monotonic "last written at" for staleness detection.
  const stamped = { ...plan, generated: new Date().toISOString() };
  const file = planPath(projectRoot);
  const body = yaml.dump(stamped, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
    quotingType: '"',
  });
  writeAtomic(file, body);
  return file;
}

// ---------------------------------------------------------------
// Mutators (Phase 2)
// ---------------------------------------------------------------

// Parse the epic prefix from a story key. Duplicated from resolve-dag.js
// (kept here to avoid a circular import — resolve-dag.js requires
// sprint-plan.js).
function parseEpicFromKey(storyKey) {
  const s = String(storyKey);
  if (!s) return null;
  const m = s.match(/^([A-Za-z0-9]+)(?:-|$)/);
  return m ? m[1] : null;
}

// BMad statuses that should eagerly transition a story to plan_status=done.
// Mirrors TERMINAL_STATUSES in autopilot.js (kept in sync via tests).
const TERMINAL_BMAD_STATUSES = new Set([
  'done',
  'skipped',
  'wont_do',
  "won't_do",
  'cancelled',
  'canceled',
  'deferred',
  'abandoned',
]);

function findStoryIdx(plan, key) {
  if (!plan || !Array.isArray(plan.stories)) return -1;
  return plan.stories.findIndex((s) => s && s.key === key);
}

function findEpicIdx(plan, id) {
  if (!plan || !Array.isArray(plan.epics)) return -1;
  return plan.epics.findIndex((e) => e && String(e.id) === String(id));
}

// v2.3.0 — acquire .sprintpilot/plan.lock for the duration of a
// read-modify-write cycle. Mutual exclusion between:
//   - concurrent autopilot sessions calling markDone after STORY_DONE
//   - the /sprintpilot-plan-sprint skill doing a full plan rewrite
//   - any CLI invocation of `sprint-plan.js write` (skill shell-out)
//
// Implementation shells out to lock.js (same primitive used by
// preflight-merge.js and submodule-lock.js). 30s timeout, 200ms retry
// interval. Throws when contention exceeds the timeout so the caller
// can surface a clear "another session is rewriting the plan" error.
function acquirePlanLock(projectRoot, timeoutSec = 30) {
  const lockFile = path.join(projectRoot, LOCK_FILE_REL);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + Math.max(1, timeoutSec) * 1000;
  while (Date.now() < deadline) {
    const res = spawnSync(
      process.execPath,
      [
        LOCK_SCRIPT_PATH,
        'acquire',
        '--file',
        lockFile,
        '--stale-minutes',
        String(LOCK_STALE_MINUTES),
      ],
      { encoding: 'utf8' },
    );
    const stdout = (res.stdout || '').trim();
    if (res.status === 0 && stdout.startsWith('ACQUIRED')) {
      return lockFile;
    }
    // Brief pause before retrying — keeps the busy-loop friendly.
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>process.exit(0), 200)'], {
      stdio: 'ignore',
    });
  }
  const err = new Error(
    `sprint-plan.yaml lock not acquired within ${timeoutSec}s — another session is mutating the plan`,
  );
  err.code = 'lock_timeout';
  throw err;
}

function releasePlanLock(lockFile) {
  if (!lockFile) return;
  spawnSync(process.execPath, [LOCK_SCRIPT_PATH, 'release', '--file', lockFile], {
    encoding: 'utf8',
    stdio: 'ignore',
  });
}

// Read-modify-write helper used by every mutator. The mutator function
// receives a structuredClone of the plan and returns the mutated plan;
// validatePlan + atomic write are handled here. Throws cleanly on:
//   - missing plan file (cannot mutate what does not exist)
//   - corrupt plan file
//   - schema-invalid mutator output
//
// v2.3.0 — acquires .sprintpilot/plan.lock for the full read→fn→write
// cycle so concurrent mutators (skill rewrite vs autopilot markDone)
// can't lose each other's updates.
function mutate(projectRoot, fn) {
  const lockFile = acquirePlanLock(projectRoot);
  try {
    const result = read({ projectRoot });
    if (result === null) {
      const err = new Error(
        `no sprint-plan.yaml at ${planPath(projectRoot)} — bootstrap via sprint-plan.js write or the planning skill first`,
      );
      err.code = 'no_plan';
      throw err;
    }
    if (result && typeof result === 'object' && 'error' in result) {
      const err = new Error(`cannot mutate corrupt plan: ${result.message}`);
      err.code = result.error;
      throw err;
    }
    const clone = JSON.parse(JSON.stringify(result));
    const next = fn(clone);
    return write(next, { projectRoot });
  } finally {
    releasePlanLock(lockFile);
  }
}

// Ensure a story entry exists in plan.stories[]. If the story is absent,
// adds a minimal entry with sensible defaults (this is a no-op for callers
// that already created the entry via the skill curation flow).
function ensureStoryEntry(plan, story_key, { added_by = 'auto' } = {}) {
  const idx = findStoryIdx(plan, story_key);
  if (idx !== -1) return idx;
  plan.stories.push({
    key: story_key,
    epic: parseEpicFromKey(story_key),
    title: null,
    bmad_status: null,
    plan_status: 'pending',
    issue_id: null,
    priority: plan.stories.length + 1,
    upstream: [],
    cross_epic_upstream: [],
    rationale: null,
    added_by,
    added_at: new Date().toISOString(),
    completed_at: null,
  });
  return plan.stories.length - 1;
}

// Mark a story done. Sets plan_status=done + completed_at + clears
// current_step (a streaming-progress field set by markRunning).
function markDone(story_key, { projectRoot }) {
  return mutate(projectRoot, (plan) => {
    const idx = ensureStoryEntry(plan, story_key, { added_by: 'auto' });
    plan.stories[idx] = {
      ...plan.stories[idx],
      plan_status: 'done',
      completed_at: new Date().toISOString(),
      current_step: null,
    };
    return plan;
  });
}

// Mark a story skipped. The `reason` is recorded in a new top-level
// `skip_reason` field on the story entry; it's free-text user input
// (e.g., "blocked on external service" or "dropped from sprint").
function markSkipped(story_key, reason, { projectRoot }) {
  return mutate(projectRoot, (plan) => {
    const idx = ensureStoryEntry(plan, story_key, { added_by: 'auto' });
    plan.stories[idx] = {
      ...plan.stories[idx],
      plan_status: 'skipped',
      skip_reason: typeof reason === 'string' ? reason : null,
      current_step: null,
    };
    return plan;
  });
}

// Mark several stories excluded (not in the active plan scope but kept
// for context — e.g., upstream stories already done in sprint-status).
function markExcluded(story_keys, { projectRoot }) {
  if (!Array.isArray(story_keys)) {
    throw new Error('markExcluded expects an array of story keys');
  }
  return mutate(projectRoot, (plan) => {
    for (const key of story_keys) {
      const idx = ensureStoryEntry(plan, key, { added_by: 'auto' });
      plan.stories[idx] = {
        ...plan.stories[idx],
        plan_status: 'excluded',
        current_step: null,
      };
    }
    return plan;
  });
}

// Mark a story "running step_name" — transient streaming-progress signal
// consumed by `autopilot progress` (Phase 4.5). step_name=null clears the
// field. Cleared automatically by markDone/markSkipped.
function markRunning(story_key, step_name, { projectRoot }) {
  return mutate(projectRoot, (plan) => {
    const idx = ensureStoryEntry(plan, story_key, { added_by: 'auto' });
    plan.stories[idx] = {
      ...plan.stories[idx],
      current_step: step_name || null,
    };
    return plan;
  });
}

// Determine an insertion index from a position spec:
//   'end'            → after the last existing entry
//   'after:<key>'    → immediately after the entry with key=<key>; appends if missing
//   <integer>        → 0-based index (negative = from end; clamped)
function resolveInsertIdx(stories, position) {
  if (position === undefined || position === null || position === 'end') {
    return stories.length;
  }
  if (typeof position === 'number' && Number.isFinite(position)) {
    const i = Math.trunc(position);
    if (i < 0) return Math.max(0, stories.length + i + 1);
    return Math.min(stories.length, i);
  }
  if (typeof position === 'string' && position.startsWith('after:')) {
    const key = position.slice('after:'.length);
    const idx = stories.findIndex((s) => s && s.key === key);
    return idx === -1 ? stories.length : idx + 1;
  }
  throw new Error(`unknown position spec: ${JSON.stringify(position)}`);
}

// Rewrite priority field for all stories to match their list-index order.
// 1-indexed per the schema (smaller = runs first).
function reassignPriorities(stories) {
  for (let i = 0; i < stories.length; i++) {
    if (stories[i]) stories[i].priority = i + 1;
  }
}

// Add story entries to the plan.
//   entries: array of partial story objects ({key, title?, epic?, ...}).
//            `key` is required. Other fields default to sensible empties.
//   position: 'end' | 'after:<key>' | integer (see resolveInsertIdx).
// Throws if any key is missing, already present in stories[], or position
// is malformed. Re-assigns priorities across the entire list.
function addStories(entries, { projectRoot, position = 'end' }) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('addStories requires a non-empty array of entries');
  }
  return mutate(projectRoot, (plan) => {
    const seenKeys = new Set(plan.stories.map((s) => s && s.key));
    const now = new Date().toISOString();
    const newEntries = [];
    for (const raw of entries) {
      if (!raw || typeof raw !== 'object' || typeof raw.key !== 'string' || raw.key === '') {
        throw new Error('each entry must be an object with a non-empty `key`');
      }
      if (seenKeys.has(raw.key)) {
        throw new Error(`story ${raw.key} is already in the plan`);
      }
      seenKeys.add(raw.key);
      newEntries.push({
        key: raw.key,
        epic: raw.epic ?? parseEpicFromKey(raw.key),
        title: raw.title ?? null,
        bmad_status: raw.bmad_status ?? null,
        plan_status: raw.plan_status ?? 'pending',
        issue_id: raw.issue_id ?? null,
        priority: null,
        upstream: Array.isArray(raw.upstream) ? raw.upstream.slice() : [],
        cross_epic_upstream: Array.isArray(raw.cross_epic_upstream)
          ? raw.cross_epic_upstream.slice()
          : [],
        rationale: raw.rationale ?? null,
        added_by: raw.added_by ?? 'user',
        added_at: raw.added_at ?? now,
        completed_at: null,
      });
    }
    const insertAt = resolveInsertIdx(plan.stories, position);
    plan.stories = [
      ...plan.stories.slice(0, insertAt),
      ...newEntries,
      ...plan.stories.slice(insertAt),
    ];
    reassignPriorities(plan.stories);
    return plan;
  });
}

// Remove (status-mark) several stories in one shot.
//   keys: array of story_keys to mark
//   status: 'skipped' | 'deferred' — the plan_status to apply
// Note: this does NOT physically remove entries — it sets plan_status so
// the queue resolver skips them. Physical removal is left to the user
// editing sprint-plan.yaml directly.
function removeStories(keys, { projectRoot, status = 'skipped' }) {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('removeStories requires a non-empty array of keys');
  }
  if (status !== 'skipped' && status !== 'deferred') {
    throw new Error(
      `removeStories status must be 'skipped' or 'deferred' (got ${JSON.stringify(status)})`,
    );
  }
  return mutate(projectRoot, (plan) => {
    const missing = [];
    for (const key of keys) {
      const idx = findStoryIdx(plan, key);
      if (idx === -1) {
        missing.push(key);
        continue;
      }
      plan.stories[idx] = {
        ...plan.stories[idx],
        plan_status: status,
        current_step: null,
      };
    }
    if (missing.length > 0) {
      const err = new Error(`stories not in plan: ${missing.join(', ')}`);
      err.code = 'missing_keys';
      err.missing_keys = missing;
      throw err;
    }
    return plan;
  });
}

// Characters that break mermaid label parsing (and graphviz label
// quoting) when concatenated into a node label by composeStoryLabel /
// composeEpicLabel. Reject at capture time so the plan never holds
// values that would corrupt the rendered DAG. Mirrors the defensive
// escape in resolve-dag.js#mermaidEscapeLabel — we want the validation
// at the data boundary rather than relying solely on escape-at-render.
//
// Round 2: expanded to match the renderer's escape set:
//   - mermaid bracket-syntax: [ ] ( ) < >
//   - mermaid link-label syntax: |
//   - statement separator: ;
//   - HTML-entity start: &
//   - newlines, carriage returns, ASCII control chars
//   - Unicode RTL/LTR override marks (visual-reorder attack)
// Tracker IDs from Jira/Linear/GitHub/GitLab don't legitimately use
// any of these.
const ISSUE_ID_REJECT_CHARS = /[[\]<>|;&\n\r\x00-\x1f\x7f‪-‮⁦-⁩؜]/;

// Set issue_id on either an epic or a story entity. Looks up the entity
// by key/id (epic first since epic ids are typically shorter strings).
// Creates a story entry if missing (the issue_id is preserved even when
// the story isn't yet curated into the plan). Returns the entity-kind +
// index so callers can confirm what was updated.
function setIssueId(entity_key, issue_id, { projectRoot }) {
  if (typeof entity_key !== 'string' || entity_key === '') {
    throw new Error('setIssueId requires a non-empty entity_key');
  }
  if (issue_id !== null && typeof issue_id !== 'string') {
    throw new Error('setIssueId requires issue_id to be a string or null');
  }
  // v2.3.0 — reject characters that would corrupt rendered DAG labels
  // even if the renderer escapes them. Defense in depth: bad data
  // doesn't reach the plan file. Tracker IDs like Jira/Linear/GitHub
  // don't legitimately contain these characters.
  if (typeof issue_id === 'string' && ISSUE_ID_REJECT_CHARS.test(issue_id)) {
    throw new Error(
      `setIssueId rejected issue_id ${JSON.stringify(issue_id)}: contains forbidden character ` +
        `([ ] < > newline). Tracker IDs (Jira/Linear/GitHub/GitLab) don't legitimately contain these.`,
    );
  }
  // Also reject length over 200 — same cap as cross-epic rationale,
  // chosen to prevent runaway labels from making the DAG render unreadable.
  if (typeof issue_id === 'string' && issue_id.length > 200) {
    throw new Error(`setIssueId rejected issue_id of length ${issue_id.length}: max is 200 chars`);
  }
  let result = null;
  mutate(projectRoot, (plan) => {
    const epicIdx = findEpicIdx(plan, entity_key);
    if (epicIdx !== -1) {
      plan.epics[epicIdx] = { ...plan.epics[epicIdx], issue_id };
      result = { kind: 'epic', index: epicIdx };
      return plan;
    }
    const storyIdx = ensureStoryEntry(plan, entity_key, { added_by: 'auto' });
    plan.stories[storyIdx] = { ...plan.stories[storyIdx], issue_id };
    result = { kind: 'story', index: storyIdx };
    return plan;
  });
  return result;
}

// Write the top-level issue_tracker block. Accepts a partial config; null
// fields clear the tracker entirely. Returns the file path.
function setIssueTracker(config, { projectRoot }) {
  if (config !== null && (typeof config !== 'object' || Array.isArray(config))) {
    throw new Error('setIssueTracker requires an object or null');
  }
  return mutate(projectRoot, (plan) => {
    if (config === null) {
      plan.issue_tracker = null;
    } else {
      plan.issue_tracker = {
        provider: config.provider ?? null,
        base_url: config.base_url ?? null,
        project_key: config.project_key ?? null,
      };
    }
    return plan;
  });
}

// Read story keys + their bmad status from sprint-status.yaml. Mirrors the
// pull logic in resolve-dag.js#readStoriesFromStatus but keeps this module
// independent (so sprint-plan.js doesn't depend on resolve-dag.js — that
// import direction would create a cycle). Returns Map<key, status>.
function readBmadStatuses(projectRoot) {
  const ssFile = path.join(
    projectRoot,
    '_bmad-output',
    'implementation-artifacts',
    'sprint-status.yaml',
  );
  const out = new Map();
  if (!fs.existsSync(ssFile)) return out;
  const raw = fs.readFileSync(ssFile, 'utf8');
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
    out.set(m[2], status);
  }
  return out;
}

// Refresh cached bmad_status fields on every plan entry from
// sprint-status.yaml. For stories whose bmad_status is in
// TERMINAL_BMAD_STATUSES, eagerly transition plan_status to 'done' so
// the queue resolver doesn't pick them up.
//
// Skips the disk write when nothing changed (mitigates Risk #23 disk
// thrashing). Returns { wrote, changed: { stories, epics, transitions } }.
//
// v2.3.0 Round 2 — acquires plan.lock for the full read→diff→write
// cycle. Two concurrent autopilot sessions calling refreshBmadStatus
// (e.g., during cmdStart) would otherwise race on the read+write,
// losing each other's bmad_status updates. The lock matches the one
// used by mutate() + archive().
function refreshBmadStatus({ projectRoot }) {
  const bmad = readBmadStatuses(projectRoot);
  let storyChanges = 0;
  let epicChanges = 0;
  let transitions = 0;

  // Read-only fast path before acquiring the lock — if the plan
  // doesn't exist or is corrupt, we don't need exclusive access.
  // Avoids unnecessary lock acquisition on greenfield projects.
  const probe = read({ projectRoot });
  if (probe === null) {
    return { wrote: false, changed: { stories: 0, epics: 0, transitions: 0 }, reason: 'no_plan' };
  }
  if (probe && typeof probe === 'object' && 'error' in probe) {
    return {
      wrote: false,
      changed: { stories: 0, epics: 0, transitions: 0 },
      reason: probe.error,
      message: probe.message,
    };
  }

  const lockFile = acquirePlanLock(projectRoot);
  try {
    // Re-read inside the lock — the plan might have changed between
    // the unlocked probe and lock acquisition. Without this we'd diff
    // against stale data.
    const result = read({ projectRoot });
    if (result === null) {
      return { wrote: false, changed: { stories: 0, epics: 0, transitions: 0 }, reason: 'no_plan' };
    }
    if (result && typeof result === 'object' && 'error' in result) {
      return {
        wrote: false,
        changed: { stories: 0, epics: 0, transitions: 0 },
        reason: result.error,
        message: result.message,
      };
    }
    const next = JSON.parse(JSON.stringify(result));

    // Stories
    for (let i = 0; i < next.stories.length; i++) {
      const entry = next.stories[i];
      if (!entry || !entry.key) continue;
      const observed = bmad.has(entry.key) ? bmad.get(entry.key) : null;
      if (observed !== entry.bmad_status) {
        entry.bmad_status = observed;
        storyChanges += 1;
      }
      if (
        observed !== null &&
        TERMINAL_BMAD_STATUSES.has(observed) &&
        entry.plan_status !== 'done' &&
        entry.plan_status !== 'skipped' &&
        entry.plan_status !== 'excluded'
      ) {
        entry.plan_status = 'done';
        entry.completed_at = entry.completed_at || new Date().toISOString();
        entry.current_step = null;
        transitions += 1;
      }
    }

    // Epics: aggregate bmad_status from contained stories. backlog if any
    // story is non-terminal; done if every story is terminal; in-progress
    // otherwise. This is a heuristic; users can override via direct YAML edit.
    for (let i = 0; i < next.epics.length; i++) {
      const epic = next.epics[i];
      if (!epic || !epic.id) continue;
      const epicStories = next.stories.filter(
        (s) => s && (s.epic === epic.id || String(s.epic) === String(epic.id)),
      );
      let aggregate = null;
      if (epicStories.length === 0) {
        aggregate = epic.bmad_status; // preserve whatever was set
      } else {
        const allTerminal = epicStories.every(
          (s) => s.bmad_status && TERMINAL_BMAD_STATUSES.has(s.bmad_status),
        );
        const anyTerminal = epicStories.some(
          (s) => s.bmad_status && TERMINAL_BMAD_STATUSES.has(s.bmad_status),
        );
        aggregate = allTerminal ? 'done' : anyTerminal ? 'in-progress' : 'backlog';
      }
      if (aggregate !== epic.bmad_status) {
        epic.bmad_status = aggregate;
        epicChanges += 1;
      }
    }

    const noOp = storyChanges === 0 && epicChanges === 0 && transitions === 0;
    if (noOp) {
      return { wrote: false, changed: { stories: 0, epics: 0, transitions: 0 } };
    }
    const file = write(next, { projectRoot });
    return {
      wrote: true,
      file,
      changed: { stories: storyChanges, epics: epicChanges, transitions },
    };
  } finally {
    releasePlanLock(lockFile);
  }
}

// Archive the current sprint-plan.yaml to .archive/sprint-plan-<plan_id>.yaml
// then delete the live file. Idempotent if already archived (no-op when the
// live file doesn't exist). Returns the archive path.
// v2.3.0 — wrapped in plan.lock so a concurrent skill/markDone can't
// write to sprint-plan.yaml between our copyFile + unlink. Same lock
// as mutate() — serializes against all sprint-plan.js writers.
function archive(plan_id, { projectRoot }) {
  const lockFile = acquirePlanLock(projectRoot);
  try {
    const livePath = planPath(projectRoot);
    if (!fs.existsSync(livePath)) {
      return { archived: false, reason: 'no_live_plan' };
    }
    const id =
      typeof plan_id === 'string' && plan_id !== ''
        ? plan_id
        : `unknown-${Date.now().toString(36)}`;
    const archiveDir = path.join(projectRoot, '.archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    let archivePath = path.join(archiveDir, `sprint-plan-${id}.yaml`);
    let counter = 1;
    while (fs.existsSync(archivePath)) {
      archivePath = path.join(archiveDir, `sprint-plan-${id}.${counter}.yaml`);
      counter += 1;
    }
    fs.copyFileSync(livePath, archivePath);
    fs.unlinkSync(livePath);
    return { archived: true, file: archivePath };
  } finally {
    releasePlanLock(lockFile);
  }
}

// Reorder stories according to newOrder (an array of story_keys). The
// resulting list contains exactly the stories in newOrder (any plan
// stories NOT mentioned are appended at the end in their original
// relative order, so the caller can omit excluded/deferred entries
// without losing them). Priorities are rewritten 1-indexed.
//
// Caller is responsible for DAG validation (sprint-plan.js doesn't know
// about dependencies semantics — that lives in the orchestrator-side
// helper in Phase 5).
function reorder(newOrder, { projectRoot }) {
  // M2 (v2.3.0) — empty input rejected for consistency with addStories
  // and removeStories. Previously was a silent no-op which masked
  // upstream bugs (caller computed an empty list and didn't notice).
  if (!Array.isArray(newOrder) || newOrder.length === 0) {
    throw new Error('reorder requires a non-empty array of story keys');
  }
  return mutate(projectRoot, (plan) => {
    const byKey = new Map();
    for (const s of plan.stories) if (s && s.key) byKey.set(s.key, s);
    const unknown = [];
    // M1 (v2.3.0) — keys whose plan_status is terminal (done / skipped /
    // excluded) are rejected upfront. Reordering them is a UX trap: the
    // user thinks their reorder placed the story but composePlanQueue
    // filters non-pending entries out anyway, so the request silently
    // does nothing. Surface it as an explicit error.
    const terminalStatuses = new Set(['done', 'skipped', 'excluded']);
    const terminal = [];
    const seen = new Set();
    const ordered = [];
    for (const key of newOrder) {
      if (seen.has(key)) continue; // dedupe silently
      seen.add(key);
      const entry = byKey.get(key);
      if (!entry) {
        unknown.push(key);
        continue;
      }
      if (terminalStatuses.has(entry.plan_status)) {
        terminal.push({ key, plan_status: entry.plan_status });
        continue;
      }
      ordered.push(entry);
    }
    if (unknown.length > 0) {
      const err = new Error(`reorder references stories not in plan: ${unknown.join(', ')}`);
      err.code = 'unknown_keys';
      err.unknown_keys = unknown;
      throw err;
    }
    if (terminal.length > 0) {
      const labelled = terminal.map((t) => `${t.key} (${t.plan_status})`).join(', ');
      const err = new Error(
        `reorder includes stories whose plan_status is terminal: ${labelled} — ` +
          `terminal stories are not in the queue and can't be reordered`,
      );
      err.code = 'terminal_keys';
      err.terminal_keys = terminal;
      throw err;
    }
    // Append any plan entries the caller omitted, preserving relative order.
    const appended = plan.stories.filter((s) => s && s.key && !seen.has(s.key));
    plan.stories = [...ordered, ...appended];
    reassignPriorities(plan.stories);
    return plan;
  });
}

// ---------------------------------------------------------------
// CLI
// ---------------------------------------------------------------

function help() {
  log.out(
    [
      'Usage:',
      '  sprint-plan.js read [--project-root <path>]',
      '  sprint-plan.js write [--project-root <path>]      (plan via stdin as YAML or JSON)',
      '  sprint-plan.js validate [--project-root <path>]   (plan via stdin)',
      '  sprint-plan.js empty [--source <skill|auto|cli|migrated>]',
      '',
      'Phase-0 primitive: read + write + validate + empty. Richer mutators',
      '(markDone, addStories, reorder, refreshBmadStatus) land in Phase 2.',
    ].join('\n'),
  );
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      buf += c;
    });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

function parseStdinPlan(text) {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { ok: false, error: 'empty stdin' };
  }
  // Try JSON first (LLM envelopes often arrive as JSON); fall back to YAML.
  try {
    return { ok: true, plan: JSON.parse(trimmed) };
  } catch {
    /* fall through to YAML */
  }
  try {
    return { ok: true, plan: yaml.load(trimmed) };
  } catch (e) {
    return { ok: false, error: `parse failed: ${e.message}` };
  }
}

async function runRead(projectRoot) {
  const result = read({ projectRoot });
  if (result === null) {
    process.stdout.write(JSON.stringify({ exists: false, plan: null }) + '\n');
    return 0;
  }
  if (result && result.error) {
    process.stdout.write(JSON.stringify({ exists: true, plan: null, ...result }) + '\n');
    return 1;
  }
  process.stdout.write(JSON.stringify({ exists: true, plan: result }) + '\n');
  return 0;
}

async function runValidate(projectRoot) {
  const stdin = await readStdin();
  const parsed = parseStdinPlan(stdin);
  if (!parsed.ok) {
    process.stdout.write(JSON.stringify({ valid: false, error: parsed.error }) + '\n');
    return 1;
  }
  const err = validatePlan(parsed.plan);
  if (err) {
    process.stdout.write(JSON.stringify({ valid: false, ...err }) + '\n');
    return 1;
  }
  process.stdout.write(JSON.stringify({ valid: true }) + '\n');
  return 0;
}

async function runWrite(projectRoot) {
  const stdin = await readStdin();
  const parsed = parseStdinPlan(stdin);
  if (!parsed.ok) {
    process.stdout.write(JSON.stringify({ wrote: false, error: parsed.error }) + '\n');
    return 1;
  }
  const err = validatePlan(parsed.plan);
  if (err) {
    process.stdout.write(JSON.stringify({ wrote: false, ...err }) + '\n');
    return 1;
  }
  const file = write(parsed.plan, { projectRoot });
  process.stdout.write(JSON.stringify({ wrote: true, file }) + '\n');
  return 0;
}

async function runEmpty(source) {
  let plan;
  try {
    plan = emptyPlan({ source });
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n');
    return 1;
  }
  process.stdout.write(yaml.dump(plan, { lineWidth: 120, noRefs: true, sortKeys: false }));
  return 0;
}

async function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));
  if (opts.help || positional.length === 0) {
    help();
    process.exit(opts.help ? 0 : 1);
  }
  const command = positional[0];
  if (!VALID_COMMANDS.includes(command)) {
    log.error(`unknown command '${command}'. Valid: ${VALID_COMMANDS.join(', ')}`);
    process.exit(1);
  }
  const projectRoot = opts['project-root'] || process.cwd();

  try {
    if (command === 'read') process.exit(await runRead(projectRoot));
    if (command === 'write') process.exit(await runWrite(projectRoot));
    if (command === 'validate') process.exit(await runValidate(projectRoot));
    if (command === 'empty') {
      const source = opts.source || 'skill';
      process.exit(await runEmpty(source));
    }
  } catch (e) {
    log.error(`unexpected error: ${e.stack || e.message}`);
    process.exit(1);
  }
}

module.exports = {
  SCHEMA_VERSION,
  PLAN_FILE_REL,
  LOCK_FILE_REL,
  LOCK_STALE_MINUTES,
  VALID_SOURCES,
  TERMINAL_BMAD_STATUSES,
  planPath,
  lockPath,
  emptyPlan,
  validatePlan,
  read,
  write,
  writeAtomic,
  parseEpicFromKey,
  findStoryIdx,
  findEpicIdx,
  ensureStoryEntry,
  acquirePlanLock,
  releasePlanLock,
  mutate,
  markDone,
  markSkipped,
  markExcluded,
  markRunning,
  resolveInsertIdx,
  reassignPriorities,
  addStories,
  removeStories,
  reorder,
  setIssueId,
  setIssueTracker,
  readBmadStatuses,
  refreshBmadStatus,
  archive,
};

if (require.main === module) {
  main();
}
