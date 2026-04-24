#!/usr/bin/env node

// list-remaining-stories.js — deterministic compute of stories_remaining.
//
// Usage:
//   list-remaining-stories.js --status-file <path> [--format json|csv|lines|envelope]
//
// Reads BMad's sprint-status.yaml and returns the set of story keys whose
// status is NOT "done" (case-insensitive). Handles every BMad-observed
// shape: dict form, inline form, block form, list form, quoted keys,
// 2/4/tab indent.
//
// Formats:
//   json (default) — `["1-1-a","1-2-b"]`. Legacy form; always a bare array.
//   csv            — `1-1-a,1-2-b`
//   lines          — `1-1-a\n1-2-b`
//   envelope       — `{"remaining":[...],"state":"sprint-in-progress"}`
//                    state is one of: pre-planning | sprint-in-progress |
//                    sprint-complete | parse-error. This is the shape the
//                    autopilot workflow consumes because exit codes alone
//                    cannot disambiguate "all done" vs "not planned yet".
//
// Exit codes (still emitted for backward compatibility with shell callers):
//   0 — sprint-in-progress or sprint-complete
//   1 — parse error (invalid YAML-like content)
//   2 — pre-planning (status file missing)
//
// On every exit path — including errors — a well-formed value is printed
// on stdout in the requested format. Callers never need to consult stderr
// or exit-code shell probes to get a usable value.

const fs = require('node:fs');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');

const VALID_FORMATS = ['json', 'csv', 'lines', 'envelope'];

function help() {
  log.out(
    [
      'Usage:',
      '  list-remaining-stories.js --status-file <path> [--format json|csv|lines|envelope]',
      '',
      'Emits story keys whose status is NOT "done" (case-insensitive).',
      'Any status other than the literal token `done` — including null,',
      'backlog, ready-for-dev, in-progress, review, draft, or typos — is',
      'treated as "not done".',
      '',
      'Exits: 0 on success (sprint-in-progress or sprint-complete); 1 on',
      'parse failure; 2 when the status file is missing. On every exit',
      'path a well-formed value is still written to stdout.',
    ].join('\n'),
  );
}

// Normalize a scalar value: strip surrounding quotes, trim inner whitespace.
function stripQuotes(v) {
  if (v == null) return v;
  let s = String(v).trim();
  if (s.length >= 2) {
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      s = s.slice(1, -1);
    }
  }
  return s.trim();
}

// Status comparison is case-insensitive and whitespace-insensitive so
// `Done`, `"done "`, and `done` all collapse to the same class. Anything
// other than the literal token `done` is classified as not-done.
function isDone(status) {
  if (status == null) return false;
  return String(status).trim().toLowerCase() === 'done';
}

function leadingIndent(line) {
  const m = line.match(/^[ \t]*/);
  return m ? m[0].length : 0;
}

// Parse a `key: value` line where key may be quoted. Returns
// {key, value} or null. Handles trailing `# comment`.
function parseKV(content) {
  const m = content.match(
    /^["']?([A-Za-z0-9][A-Za-z0-9_.\-]*)["']?\s*:\s*(\S[^#]*?)?(?:\s*#.*)?\s*$/,
  );
  if (!m) return null;
  return { key: m[1], value: m[2] ? stripQuotes(m[2].trim()) : '' };
}

// parseStatuses — indent-agnostic, shape-tolerant scanner for BMad's
// sprint-status.yaml.
//
// Recognized block headers at any indent:
//   development_status:
//   stories:
//
// Inside a block, children are detected by indent strictly greater than
// the block header's indent. The indent of the first child fixes the
// "item indent" for the block; deeper-indented lines are treated as
// fields of the current story.
//
// Supported per-item shapes:
//   <key>: <status>              — dict inline
//   "<key>": <status>            — dict inline (quoted)
//   <key>:                       — dict block (status: on next line)
//     status: <value>
//   - <key>: <status>            — list inline
//   - id: <key>                  — list block (id|key|name as the story id field)
//     status: <value>
//
// Returns {storyKey: {status: string|null}}.
function parseStatuses(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const stories = {};

  let inBlock = false;
  let blockIndent = -1;
  let itemIndent = -1;
  let isListBlock = false;
  let currentKey = null;
  let currentKeyIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i].replace(/\s+$/, '');
    if (!rawLine.trim()) continue;
    if (/^\s*#/.test(rawLine)) continue;

    const indent = leadingIndent(rawLine);
    const content = rawLine.slice(indent);

    // Exit the stories block when we return to its indent or shallower.
    if (inBlock && indent <= blockIndent) {
      inBlock = false;
      itemIndent = -1;
      isListBlock = false;
      currentKey = null;
      currentKeyIndent = -1;
    }

    if (!inBlock) {
      const h = content.match(/^(development_status|stories)\s*:\s*$/);
      if (h) {
        inBlock = true;
        blockIndent = indent;
        itemIndent = -1;
        isListBlock = false;
        currentKey = null;
        currentKeyIndent = -1;
      }
      continue;
    }

    // Lazily fix the direct-child indent and the block flavor on the first
    // non-blank child line.
    if (itemIndent < 0) {
      itemIndent = indent;
      isListBlock = content.startsWith('- ') || content === '-';
    }

    if (indent === itemIndent) {
      if (isListBlock) {
        // `- key: value` | `- id: key` | `- key: value # comment`
        const listM = content.match(/^-\s+(.+)$/);
        if (!listM) {
          // bare `-` with children below; rare but tolerate.
          currentKey = null;
          currentKeyIndent = indent;
          continue;
        }
        const kv = parseKV(listM[1]);
        if (!kv) continue;
        // If the first field inside the list item is an id-like field, the
        // story key is its value; otherwise the field name IS the story key
        // and the field value is its inline status.
        if (kv.key === 'id' || kv.key === 'key' || kv.key === 'name') {
          currentKey = kv.value || null;
          if (currentKey) stories[currentKey] = stories[currentKey] ?? { status: null };
        } else {
          currentKey = kv.key;
          stories[currentKey] = { status: kv.value || null };
        }
        currentKeyIndent = indent;
      } else {
        const kv = parseKV(content);
        if (!kv) continue;
        currentKey = kv.key;
        stories[currentKey] = { status: kv.value || null };
        currentKeyIndent = indent;
      }
      continue;
    }

    // Deeper than itemIndent → a field of the current list/dict item.
    if (currentKey != null && indent > currentKeyIndent) {
      const kv = parseKV(content);
      if (kv && kv.key === 'status') {
        stories[currentKey].status = kv.value || null;
      }
    }
  }

  return stories;
}

function remainingFrom(stories) {
  const out = [];
  for (const key of Object.keys(stories)) {
    if (isDone(stories[key].status)) continue;
    out.push(key);
  }
  return out;
}

function emit(list, format, state) {
  if (format === 'envelope') {
    process.stdout.write(`${JSON.stringify({ remaining: list, state })}\n`);
    return;
  }
  if (format === 'csv') {
    process.stdout.write(list.join(',') + (list.length ? '\n' : ''));
    return;
  }
  if (format === 'lines') {
    if (list.length === 0) return;
    process.stdout.write(list.join('\n') + '\n');
    return;
  }
  // json (default)
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
    emit([], opts.format || 'json', 'parse-error');
    process.exit(1);
  }
  const format = opts.format || 'json';
  if (!VALID_FORMATS.includes(format)) {
    log.error(`invalid --format '${format}'. Valid: ${VALID_FORMATS.join(', ')}`);
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    // Pre-planning — status file not yet created.
    emit([], format, 'pre-planning');
    process.exit(2);
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    log.error(`failed to read ${file}: ${e.message}`);
    emit([], format, 'parse-error');
    process.exit(1);
  }
  let stories;
  try {
    stories = parseStatuses(raw);
  } catch (e) {
    log.error(`failed to parse ${file}: ${e.message}`);
    emit([], format, 'parse-error');
    process.exit(1);
  }
  const remaining = remainingFrom(stories);
  const storyCount = Object.keys(stories).length;
  let state;
  if (storyCount === 0) {
    state = 'pre-planning';
  } else if (remaining.length === 0) {
    state = 'sprint-complete';
  } else {
    state = 'sprint-in-progress';
  }
  emit(remaining, format, state);
}

module.exports = {
  VALID_FORMATS,
  parseStatuses,
  remainingFrom,
  stripQuotes,
  isDone,
};

if (require.main === module) {
  main();
}
