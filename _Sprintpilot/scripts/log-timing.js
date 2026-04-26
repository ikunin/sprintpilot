#!/usr/bin/env node

// log-timing.js — append a timing event to a per-story JSONL shard.
//
// Usage:
//   log-timing.js <action> --story <key> --phase <name> [--meta <json>]
//
// Actions:
//   start   Emit {event:"start", story, phase, ts:<iso8601>}
//   end     Emit {event:"end",   story, phase, ts:<iso8601>}
//   once    Emit a single-event marker (for things like health-check-run)
//   mark    Single-call replacement for start/end pairs. Reads a tiny
//           marker file (.timings/.mark.json), computes the duration
//           since the previous mark, emits one duration record for the
//           PREVIOUS phase, and writes a new marker for the current
//           phase. Designed for LLM-driven workflows where the agent
//           may forget to call `end` after a long skill — `mark` only
//           needs to be called ONCE per phase transition.
//
// Output path:
//   <project-root>/_bmad-output/implementation-artifacts/.timings/<story>.jsonl
//   Append-only, one writer per story-key = one sub-agent in the autopilot
//   model. Each line is JSON, < LINE_MAX_BYTES so a single write() is
//   atomic on POSIX (PIPE_BUF >= 4096 on every supported platform).
//
// No-op contract:
//   If the resolved profile has autopilot.phase_timings !== true, the
//   script silently returns without creating files. This is the
//   rollback path for PR 2 and the permanent behavior for the `legacy`
//   profile.

const fs = require('node:fs');
const path = require('node:path');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');

// Path-traversal guard: a story key is part of the filename, so it must
// not contain slashes, dots, or other shell-significant characters.
const STORY_RE = /^[a-z0-9][a-z0-9-]*$/;
// Phase names follow a dotted-namespace convention (skill.bmad-dev-story).
const PHASE_RE = /^[a-z][a-z0-9-.]*$/;
const META_MAX_BYTES = 2048;
const LINE_MAX_BYTES = 4096; // POSIX PIPE_BUF floor — single write() is atomic
const VALID_ACTIONS = ['start', 'end', 'once', 'mark'];
// MARKER_FILE: per-story marker file template. The actual file is
// `.mark.<story>.json` so concurrent writers for different stories never
// race on the same path. Pre-2.0.5 used a single global `.mark.json`
// which corrupted timing data when sub-agents in the same project root
// marked phases concurrently (e.g. parallel story dispatch). Kept as
// `.mark.json` only as a back-compat constant; runtime always uses the
// per-story path via `markerPath(root, story)`.
const MARKER_FILE = '.mark.json';

function help() {
  log.out(
    [
      'Usage:',
      '  log-timing.js <action> --story <key> --phase <name> [--meta <json>]',
      '',
      'Actions: start | end | once',
      '',
      'Options:',
      '  --project-root <path>   Defaults to cwd',
      '  --story <key>           Matches /^[a-z0-9][a-z0-9-]*$/',
      '  --phase <name>          Matches /^[a-z][a-z0-9-.]*$/',
      '  --meta <json>           Inline JSON, serialized < 2KB',
    ].join('\n'),
  );
}

function validateStory(s) {
  if (s === undefined || s === null || s === '') {
    return { ok: false, error: '--story is required' };
  }
  if (!STORY_RE.test(s)) {
    return { ok: false, error: `invalid --story '${s}': must match ${STORY_RE}` };
  }
  return { ok: true, value: s };
}

function validatePhase(s) {
  if (s === undefined || s === null || s === '') {
    return { ok: false, error: '--phase is required' };
  }
  if (!PHASE_RE.test(s)) {
    return { ok: false, error: `invalid --phase '${s}': must match ${PHASE_RE}` };
  }
  return { ok: true, value: s };
}

function validateAction(a) {
  if (!VALID_ACTIONS.includes(a)) {
    return { ok: false, error: `invalid action '${a}': must be one of ${VALID_ACTIONS.join(', ')}` };
  }
  return { ok: true, value: a };
}

function validateMeta(metaJson) {
  if (metaJson === undefined) return { ok: true, value: undefined };
  let parsed;
  try {
    parsed = JSON.parse(metaJson);
  } catch (e) {
    return { ok: false, error: `--meta is not valid JSON: ${e.message}` };
  }
  const serialized = JSON.stringify(parsed);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > META_MAX_BYTES) {
    return {
      ok: false,
      error: `--meta exceeds ${META_MAX_BYTES} bytes after serialization (got ${bytes})`,
    };
  }
  return { ok: true, value: parsed };
}

function timingsDir(projectRoot) {
  return path.join(projectRoot, '_bmad-output', 'implementation-artifacts', '.timings');
}

function readPhaseTimingSetting(projectRoot) {
  const profilesDir = path.join(projectRoot, '_Sprintpilot', 'modules', 'autopilot', 'profiles');
  if (!fs.existsSync(profilesDir)) return false;
  const pick = (raw) => {
    const m = raw.match(/^[ \t]*phase_timings:[ \t]*(true|false)[ \t]*(?:#.*)?$/m);
    return m ? m[1] === 'true' : null;
  };

  const cfgPath = path.join(projectRoot, '_Sprintpilot', 'modules', 'autopilot', 'config.yaml');
  if (fs.existsSync(cfgPath)) {
    const override = pick(fs.readFileSync(cfgPath, 'utf8'));
    if (override !== null) return override;
  }

  let profileName = 'medium';
  if (fs.existsSync(cfgPath)) {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const m = raw.match(/^[ \t]*complexity_profile:[ \t]*["']?([a-zA-Z_-]+)["']?[ \t]*(?:#.*)?$/m);
    if (m) profileName = m[1];
  }

  const profileFile = path.join(profilesDir, `${profileName}.yaml`);
  if (fs.existsSync(profileFile)) {
    const val = pick(fs.readFileSync(profileFile, 'utf8'));
    if (val !== null) return val;
  }

  // Non-legacy profiles inherit from _base. Legacy stands alone — if its
  // own file didn't declare the key (shouldn't happen), we fall through
  // to `false` (fail-safe — never write silently).
  if (profileName !== 'legacy') {
    const baseFile = path.join(profilesDir, '_base.yaml');
    if (fs.existsSync(baseFile)) {
      const val = pick(fs.readFileSync(baseFile, 'utf8'));
      if (val !== null) return val;
    }
  }

  return false;
}

function isEnabled(projectRoot) {
  try {
    return readPhaseTimingSetting(projectRoot) === true;
  } catch {
    return false;
  }
}

function appendLine(projectRoot, story, entry) {
  const dir = timingsDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify(entry);
  const bytes = Buffer.byteLength(`${line}\n`, 'utf8');
  if (bytes > LINE_MAX_BYTES) {
    throw new Error(
      `timing line exceeds ${LINE_MAX_BYTES} bytes (${bytes}); refusing to write a non-atomic record`,
    );
  }
  const file = path.join(dir, `${story}.jsonl`);
  fs.appendFileSync(file, `${line}\n`);
  return file;
}

function buildEntry(action, story, phase, meta) {
  const entry = {
    event: action,
    story,
    phase,
    ts: new Date().toISOString(),
  };
  if (meta !== undefined) entry.meta = meta;
  return entry;
}

// ---------------------------------------------------------------
// `mark` — single-call timing
// ---------------------------------------------------------------

function markerPath(projectRoot, story) {
  if (!story) throw new Error('markerPath requires a story key');
  return path.join(timingsDir(projectRoot), `.mark.${story}.json`);
}

function readMarker(projectRoot, story) {
  const file = markerPath(projectRoot, story);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    // EACCES / EISDIR / other I/O — surface to stderr so silent corruption
    // doesn't masquerade as "first mark of session".
    log.error(`timing marker read failed (${file}): ${e.message}`);
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.story === 'string' &&
      typeof parsed.phase === 'string' &&
      typeof parsed.ts === 'string'
    ) {
      return parsed;
    }
  } catch (e) {
    log.error(`timing marker corrupt (${file}): ${e.message} — treating as absent`);
  }
  return null;
}

function writeMarker(projectRoot, story, marker) {
  const dir = timingsDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  const file = markerPath(projectRoot, story);
  // Atomic-ish: write tmp + rename. Marker is small, single-line JSON.
  // Tmp filename includes story + pid + random suffix to avoid collisions
  // between concurrent same-process writers (rare in normal use, common in
  // parallel test runs) and PID-reuse.
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(marker));
    fs.renameSync(tmp, file);
  } catch (e) {
    // Clean up tmp on rename failure so we don't leak orphan files.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore — tmp may not exist */
    }
    throw e;
  }
}

function clearMarker(projectRoot, story) {
  const file = markerPath(projectRoot, story);
  try {
    fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

/**
 * mark: single-call timing API.
 *
 * Emits a duration record for THIS story's PREVIOUS phase (if any),
 * covering the interval since the previous mark for the same story key,
 * then writes a new marker for the current phase. The very first mark
 * for a given story emits no duration record — there's no "previous
 * phase" yet for that story.
 *
 * Pre-2.0.5 used a single global marker file shared across stories,
 * which under parallel dispatch (sub-agents marking different stories
 * concurrently against the same project root) raced on a single file —
 * one rename clobbered the other and durations were attributed to the
 * wrong (story, phase). Per-story markers eliminate the race entirely:
 * each story has its own marker file `.mark.<story>.json`.
 *
 * Use phase = "_end" to close THIS story's last open phase without
 * starting a new one (e.g. at sprint-complete time, or per-story
 * cleanup). `_end` only touches the marker for the named story; other
 * stories' markers are untouched.
 *
 * Order of operations is interrupt-safe: the new marker is written
 * BEFORE the duration record is appended. If the process is killed
 * between the marker rename and the duration append, we lose one
 * duration record but the next mark will read the new marker (not the
 * stale prev) and won't double-count.
 *
 * Wall-clock skew: durations are clamped at 0 with a `clock_skew: true`
 * flag in the entry so aggregators don't get poisoned by NTP backsteps
 * or DST transitions.
 *
 * Returns { duration_ms, prev_phase } so callers can log/inspect.
 */
function markPhase(projectRoot, story, phase, meta) {
  const now = new Date();
  const prev = readMarker(projectRoot, story);

  // Build the duration entry from prev (if any) before mutating marker
  // state. We append AFTER writing the new marker, so an interrupt
  // between the two yields one missed record (acceptable) rather than a
  // stale marker that would double-count on the next call.
  let durationEntry = null;
  let durationMs = null;
  let prevPhase = null;
  if (prev) {
    const prevTs = Date.parse(prev.ts);
    if (!Number.isNaN(prevTs)) {
      const rawDelta = now.getTime() - prevTs;
      durationMs = Math.max(0, rawDelta);
      prevPhase = prev.phase;
      durationEntry = {
        event: 'duration',
        story: prev.story,
        phase: prev.phase,
        started: prev.ts,
        ended: now.toISOString(),
        duration_ms: durationMs,
      };
      if (rawDelta < 0) durationEntry.clock_skew = true;
      if (prev.meta !== undefined) durationEntry.meta = prev.meta;
    }
  }

  // 1. Commit the marker state transition first.
  if (phase === '_end') {
    clearMarker(projectRoot, story);
  } else {
    const marker = { story, phase, ts: now.toISOString() };
    if (meta !== undefined) marker.meta = meta;
    writeMarker(projectRoot, story, marker);
  }

  // 2. Append the duration record after the marker is committed. If
  //    this throws, the marker is already correct for the next mark.
  if (durationEntry !== null) {
    appendLine(projectRoot, prev.story, durationEntry);
  }

  return { duration_ms: durationMs, prev_phase: prevPhase };
}

function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));
  if (opts.help || positional.length === 0) {
    help();
    process.exit(opts.help ? 0 : 1);
  }

  const action = validateAction(positional[0]);
  if (!action.ok) {
    log.error(action.error);
    process.exit(1);
  }
  const story = validateStory(opts.story);
  if (!story.ok) {
    log.error(story.error);
    process.exit(1);
  }
  // `mark _end` is a sentinel that closes the last open phase without
  // starting a new one. Skip the regex check for it; everything else
  // must match PHASE_RE.
  const phase =
    action.value === 'mark' && opts.phase === '_end'
      ? { ok: true, value: '_end' }
      : validatePhase(opts.phase);
  if (!phase.ok) {
    log.error(phase.error);
    process.exit(1);
  }
  const meta = validateMeta(opts.meta);
  if (!meta.ok) {
    log.error(meta.error);
    process.exit(1);
  }

  const projectRoot = opts['project-root'] || process.cwd();
  if (!isEnabled(projectRoot)) return;

  try {
    if (action.value === 'mark') {
      const r = markPhase(projectRoot, story.value, phase.value, meta.value);
      // Emit a brief JSON line so callers can log the duration if useful.
      // Stdout is intentionally separate from the per-story shard.
      process.stdout.write(`${JSON.stringify({ marked: phase.value, prev_phase: r.prev_phase, duration_ms: r.duration_ms })}\n`);
      return;
    }
    appendLine(projectRoot, story.value, buildEntry(action.value, story.value, phase.value, meta.value));
  } catch (e) {
    log.error(`timing write failed: ${e.message}`);
    process.exit(1);
  }
}

module.exports = {
  STORY_RE,
  PHASE_RE,
  META_MAX_BYTES,
  LINE_MAX_BYTES,
  MARKER_FILE,
  VALID_ACTIONS,
  validateStory,
  validatePhase,
  validateAction,
  validateMeta,
  timingsDir,
  markerPath,
  readMarker,
  writeMarker,
  clearMarker,
  markPhase,
  readPhaseTimingSetting,
  isEnabled,
  appendLine,
  buildEntry,
};

if (require.main === module) {
  main();
}
