#!/usr/bin/env node

// list-remaining-stories.js — deterministic compute of stories_remaining.
//
// Usage:
//   list-remaining-stories.js --status-file <path> [--format json|csv|lines]
//
// Reads the BMAD-owned sprint-status.yaml, extracts every story key under
// `development_status:` or `stories:` whose `status` field is NOT the
// literal string `done`, and emits the list. A pre-planning file (no
// stories yet) prints `[]` / nothing and exits 0.
//
// Exits:
//   0 — emitted a list (possibly empty if pre-planning OR everything done)
//   1 — bad input / malformed YAML
//   2 — status file does not exist (signal to caller)
//
// Rationale: PR-follow-up for the greenfield e2e. The workflow used to
// instruct the LLM to "compute stories_remaining from sprint-status"
// as natural language; the LLM routinely produced [] by filtering on
// status=ready-for-dev instead of status != done. Moving to a coded
// helper makes this deterministic.

const fs = require('node:fs');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');

const VALID_FORMATS = ['json', 'csv', 'lines'];

function help() {
  log.out(
    [
      'Usage:',
      '  list-remaining-stories.js --status-file <path> [--format json|csv|lines]',
      '',
      'Emits story keys whose status is NOT "done" (backlog, ready-for-dev,',
      'in-progress, review, draft, missing, null all qualify).',
      '',
      'Exits: 0 on success (even when the list is empty). 2 if the status',
      'file is missing — signals "pre-sprint" to the caller.',
    ].join('\n'),
  );
}

// Parse the shape we care about. Extremely narrow YAML parser — sprint-
// status.yaml is BMad-owned so its shape can drift; we tolerate minor
// variations and only look for lines matching:
//   `development_status:` OR `stories:` at column 0
//   `  <story-key>:` at column 2 under that block
//   `    status: <value>` at column 4 under that story key
//
// Top-level keys like `sprint:`, `epics:`, `retrospectives:` are not
// candidates. This sidesteps the need for a full YAML parser while
// handling every real shape we've seen in the e2e fixtures.
function parseStatuses(raw) {
  const lines = raw.split(/\r?\n/);
  const stories = {};
  let inStoriesBlock = false;
  let currentKey = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;
    // Top-level comment: skip.
    if (/^\s*#/.test(line)) continue;
    // Top-level key (column 0) — enter/exit the stories block.
    const topKey = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:/);
    if (topKey && line[0] !== ' ' && line[0] !== '\t') {
      inStoriesBlock = topKey[1] === 'development_status' || topKey[1] === 'stories';
      currentKey = null;
      continue;
    }
    if (!inStoriesBlock) continue;
    // Story key line (exactly two-space indent: `  1-2-foo:`).
    const storyKey = line.match(/^  ([A-Za-z0-9][A-Za-z0-9_-]*)\s*:\s*(\S[^#]*)?(?:#.*)?$/);
    if (storyKey && line[2] !== ' ') {
      currentKey = storyKey[1];
      const inlineValue = storyKey[2] ? storyKey[2].trim() : '';
      if (inlineValue) {
        // Inline form: `  1-2-foo: done`
        stories[currentKey] = { status: stripQuotes(inlineValue) };
      } else {
        stories[currentKey] = { status: null };
      }
      continue;
    }
    // Status line (four-space indent under a story).
    if (currentKey) {
      const statusLine = line.match(/^    status\s*:\s*(\S[^#]*?)(?:\s*#.*)?$/);
      if (statusLine) {
        stories[currentKey].status = stripQuotes(statusLine[1].trim());
      }
    }
  }
  return stories;
}

function stripQuotes(v) {
  if (!v) return v;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function remainingFrom(stories) {
  const out = [];
  for (const key of Object.keys(stories)) {
    const status = stories[key].status;
    if (status === 'done') continue;
    out.push(key);
  }
  return out;
}

function emit(list, format) {
  if (format === 'csv') {
    process.stdout.write(list.join(',') + (list.length ? '\n' : ''));
    return;
  }
  if (format === 'lines') {
    if (list.length === 0) return;
    process.stdout.write(list.join('\n') + '\n');
    return;
  }
  process.stdout.write(`${JSON.stringify(list)}\n`);
}

function main() {
  const { opts } = parseArgs(process.argv.slice(2));
  if (opts.help) {
    help();
    process.exit(0);
  }
  const file = opts['status-file'];
  if (!file) {
    log.error('--status-file is required');
    process.exit(1);
  }
  const format = opts.format || 'json';
  if (!VALID_FORMATS.includes(format)) {
    log.error(`invalid --format '${format}'. Valid: ${VALID_FORMATS.join(', ')}`);
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    // Not an error — just tells the caller "pre-sprint".
    emit([], format);
    process.exit(2);
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    log.error(`failed to read ${file}: ${e.message}`);
    process.exit(1);
  }
  let stories;
  try {
    stories = parseStatuses(raw);
  } catch (e) {
    log.error(`failed to parse ${file}: ${e.message}`);
    process.exit(1);
  }
  emit(remainingFrom(stories), format);
}

module.exports = {
  VALID_FORMATS,
  parseStatuses,
  remainingFrom,
  stripQuotes,
};

if (require.main === module) {
  main();
}
