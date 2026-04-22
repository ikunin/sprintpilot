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
const VALID_ACTIONS = ['start', 'end', 'once'];

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
  const phase = validatePhase(opts.phase);
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
  VALID_ACTIONS,
  validateStory,
  validatePhase,
  validateAction,
  validateMeta,
  timingsDir,
  readPhaseTimingSetting,
  isEnabled,
  appendLine,
  buildEntry,
};

if (require.main === module) {
  main();
}
