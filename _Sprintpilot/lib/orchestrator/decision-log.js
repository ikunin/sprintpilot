// decision-log.js — validate + append Decision[] entries to decision-log.yaml.
//
// Schema (from workflow.md:107–112 + the plan):
//   - id: auto-generated DEC-<seq>
//   - timestamp: ISO 8601, orchestrator-generated
//   - story: required (current story key) — orchestrator-injected
//   - phase: '<skill>:<sub_phase>'  e.g. 'dev-story:RED'
//   - category: enum (8 values)
//   - decision: non-empty string
//   - rationale: non-empty string
//   - impact: enum 'low' | 'medium' | 'high'
//
// LLM emits Decision via the optional decisions[] field on any signal.
// Orchestrator validates each entry, auto-assigns id + timestamp + story,
// then appends to decision-log.yaml.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VALID_CATEGORIES = [
  'architecture',
  'test-strategy',
  'dependency',
  'review-triage',
  'review-accept',
  'halt-recovery',
  'scope',
  'workaround',
];

const VALID_IMPACTS = ['low', 'medium', 'high'];

const PHASE_RE = /^[a-zA-Z][a-zA-Z0-9_-]*:[a-zA-Z][a-zA-Z0-9_-]*$/;

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// Validate a Decision object as emitted by the LLM. Returns
//   { ok: true, decision } | { ok: false, errors: string[] }
// `story` and `id` and `timestamp` are NOT required from the LLM — the
// orchestrator stamps them at append time.
function validateOne(d) {
  const errors = [];
  if (!isPlainObject(d)) return { ok: false, errors: ['decision is not an object'] };

  if (!nonEmptyString(d.category)) errors.push('category required');
  else if (!VALID_CATEGORIES.includes(d.category))
    errors.push(`category must be one of: ${VALID_CATEGORIES.join(',')}`);

  if (!nonEmptyString(d.impact)) errors.push('impact required');
  else if (!VALID_IMPACTS.includes(d.impact))
    errors.push(`impact must be one of: ${VALID_IMPACTS.join(',')}`);

  if (!nonEmptyString(d.phase)) errors.push('phase required');
  else if (!PHASE_RE.test(d.phase)) errors.push('phase must match <skill>:<sub_phase>');

  if (!nonEmptyString(d.decision)) errors.push('decision required');
  if (!nonEmptyString(d.rationale)) errors.push('rationale required');

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, decision: d };
}

function validateMany(decisions) {
  const list = Array.isArray(decisions) ? decisions : [];
  const valid = [];
  const errors = [];
  for (let i = 0; i < list.length; i += 1) {
    const r = validateOne(list[i]);
    if (r.ok) valid.push(r.decision);
    else errors.push({ index: i, errors: r.errors });
  }
  if (errors.length > 0) return { ok: false, errors, valid };
  return { ok: true, decisions: valid };
}

// Render one decision as YAML lines (matching workflow.md schema).
function renderDecision(d) {
  const yamlEscape = (s) => {
    const str = String(s);
    // Single-line, no embedded special chars → bare; else double-quote.
    // YAML bare-scalar rules. Quote if any of:
    //   - matches a reserved literal (true/false/null/~)
    //   - looks like a number
    //   - contains `: ` (key-value ambiguity)
    //   - contains a YAML comment intro `#`
    //   - contains chars outside the bare-safe set (allow `:` w/o space, `.`, `/`, `-`)
    const reserved = /^(true|false|null|~)$/i.test(str);
    const numeric = /^-?\d/.test(str);
    const ambiguousColon = /:\s/.test(str);
    const hasHash = /#/.test(str);
    const bareSafe = /^[A-Za-z0-9_.:/\- ]+$/.test(str);
    if (!reserved && !numeric && !ambiguousColon && !hasHash && bareSafe) return str;
    return JSON.stringify(str);
  };
  return [
    `  - id: ${d.id}`,
    `    timestamp: ${yamlEscape(d.timestamp)}`,
    `    story: ${yamlEscape(d.story)}`,
    `    phase: ${yamlEscape(d.phase)}`,
    `    category: ${d.category}`,
    `    impact: ${d.impact}`,
    `    decision: ${yamlEscape(d.decision)}`,
    `    rationale: ${yamlEscape(d.rationale)}`,
  ].join('\n');
}

// Read existing decision-log.yaml and return the next sequence number.
// We deliberately parse with a regex rather than a full YAML parser so this
// works in install-time contexts without js-yaml available.
function nextSeq(existingText) {
  if (!existingText) return 1;
  let max = 0;
  const re = /^\s*- id:\s*DEC-(\d+)\b/gm;
  let m;
  while ((m = re.exec(existingText))) {
    const n = Number.parseInt(m[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

// append(logPath, decisions, context, options?)
//   logPath: absolute path to decision-log.yaml
//   decisions: validated Decision[] from validateMany
//   context: { story: string, now: () => Date }  — orchestrator-injected
//   options: { fs? }                              — for testing
// Returns { appended: number, ids: string[] }
function append(logPath, decisions, context, options) {
  const fsImpl = (options && options.fs) || fs;
  const story = context && context.story ? String(context.story) : 'sprint';
  const nowFn = (context && context.now) || (() => new Date());

  let existing = '';
  try {
    existing = fsImpl.readFileSync(logPath, 'utf8');
  } catch (_e) {
    existing = '';
  }

  const isFresh = !existing.trim();
  let seq = nextSeq(existing);
  const ids = [];
  const renderedBlocks = [];

  for (const d of decisions) {
    const stamped = {
      id: `DEC-${String(seq).padStart(3, '0')}`,
      timestamp: nowFn().toISOString(),
      story,
      phase: d.phase,
      category: d.category,
      impact: d.impact,
      decision: d.decision,
      rationale: d.rationale,
    };
    ids.push(stamped.id);
    renderedBlocks.push(renderDecision(stamped));
    seq += 1;
  }

  const header = isFresh
    ? [
        `generated: ${nowFn().toISOString().slice(0, 10)}`,
        `last_updated: ${nowFn().toISOString()}`,
        'decisions:',
      ].join('\n')
    : updateLastUpdated(existing, nowFn().toISOString());

  const body = renderedBlocks.join('\n');
  const finalText = isFresh ? `${header}\n${body}\n` : `${header}${body}\n`;

  fsImpl.mkdirSync(path.dirname(logPath), { recursive: true });
  fsImpl.writeFileSync(logPath, finalText, 'utf8');

  return { appended: decisions.length, ids };
}

// Replace or insert the `last_updated:` line; leave everything else intact.
// Returns a string ending with the existing content (no trailing newline
// trim) so renderedBlocks can be appended directly.
function updateLastUpdated(existing, isoNow) {
  const lines = existing.split(/\r?\n/);
  let touched = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^last_updated:/.test(lines[i])) {
      lines[i] = `last_updated: ${isoNow}`;
      touched = true;
      break;
    }
  }
  if (!touched) {
    // Insert after `generated:` if present, else at top.
    let insertAt = 0;
    for (let i = 0; i < lines.length; i += 1) {
      if (/^generated:/.test(lines[i])) {
        insertAt = i + 1;
        break;
      }
    }
    lines.splice(insertAt, 0, `last_updated: ${isoNow}`);
  }
  // Strip trailing empty lines so we can append the new block(s) directly.
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

module.exports = {
  VALID_CATEGORIES,
  VALID_IMPACTS,
  validateOne,
  validateMany,
  append,
  renderDecision,
  // exported for tests
  nextSeq,
};
