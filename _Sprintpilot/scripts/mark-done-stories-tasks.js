#!/usr/bin/env node

// mark-done-stories-tasks.js — final pass that replaces `- [ ]` with `- [x]`
// in every story file whose status is "done" in sprint-status.yaml.
//
// Usage:
//   mark-done-stories-tasks.js --status-file <path> [--project-root <path>]
//
// Rationale: bmad-dev-story is supposed to check off its Tasks/Subtasks as
// it implements each story, and workflow.md's step 7 has an explicit
// "Mark all task checkboxes complete" action. Both are LLM-executed
// instructions that the autopilot sometimes skips in long sessions. This
// helper is the final deterministic safety net — it runs from step 10's
// critical path and brings the filesystem state in line with the sprint-
// status truth.
//
// Story file lookup: try every plausible BMad location:
//   _bmad-output/stories/story-<key>.md
//   _bmad-output/implementation-artifacts/story-<key>.md
//   _bmad-output/stories/<key>.md
//   _bmad-output/implementation-artifacts/<key>.md
//
// Only overwrites when a story's status == "done". All other stories are
// untouched. Writes are atomic (tmp + rename) so a failure mid-write
// never truncates a story file.

const fs = require('node:fs');
const path = require('node:path');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');
const { parseStatuses } = require('./list-remaining-stories.js');

function help() {
  log.out(
    [
      'Usage:',
      '  mark-done-stories-tasks.js --status-file <path> [--project-root <path>]',
      '',
      'For every story with status="done", replaces every `- [ ]` with',
      '`- [x]` in its story markdown file. Emits JSON summary to stdout.',
    ].join('\n'),
  );
}

function findStoryFile(projectRoot, storyKey) {
  const candidates = [
    path.join(projectRoot, '_bmad-output', 'stories', `story-${storyKey}.md`),
    path.join(projectRoot, '_bmad-output', 'implementation-artifacts', `story-${storyKey}.md`),
    path.join(projectRoot, '_bmad-output', 'stories', `${storyKey}.md`),
    path.join(projectRoot, '_bmad-output', 'implementation-artifacts', `${storyKey}.md`),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function markAllTasksChecked(body) {
  // Only replace top-level list items that start with `- [ ]` (possibly
  // indented). Nested bullet items that happen to be `[ ]` inside a
  // non-checklist context are untouched because they don't look like
  // list items at the regex level.
  const re = /^(\s*[-*]\s*)\[ \](\s*)/gm;
  const out = body.replace(re, (_m, prefix, suffix) => `${prefix}[x]${suffix}`);
  return out;
}

function atomicWrite(file, body) {
  const tmp = `${file}.tmp.${process.pid}.${process.hrtime.bigint().toString(36)}`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

function main() {
  const { opts } = parseArgs(process.argv.slice(2));
  if (opts.help) {
    help();
    process.exit(0);
  }
  const statusFile = opts['status-file'];
  if (!statusFile) {
    log.error('--status-file is required');
    process.exit(1);
  }
  if (!fs.existsSync(statusFile)) {
    log.error(`status file missing: ${statusFile}`);
    process.exit(2);
  }
  const projectRoot = opts['project-root'] || process.cwd();

  let raw;
  try {
    raw = fs.readFileSync(statusFile, 'utf8');
  } catch (e) {
    log.error(`cannot read ${statusFile}: ${e.message}`);
    process.exit(1);
  }

  const stories = parseStatuses(raw);
  const doneKeys = Object.keys(stories).filter((k) => stories[k].status === 'done');

  const summary = {
    done_stories: doneKeys.length,
    marked: [],
    missing_files: [],
    unchanged: [],
  };

  for (const key of doneKeys) {
    const file = findStoryFile(projectRoot, key);
    if (!file) {
      summary.missing_files.push(key);
      continue;
    }
    const body = fs.readFileSync(file, 'utf8');
    const marked = markAllTasksChecked(body);
    if (marked === body) {
      summary.unchanged.push(key);
      continue;
    }
    try {
      atomicWrite(file, marked);
      summary.marked.push({ key, file });
    } catch (e) {
      log.warn(`failed to mark ${file}: ${e.message}`);
    }
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

module.exports = {
  findStoryFile,
  markAllTasksChecked,
  atomicWrite,
};

if (require.main === module) {
  main();
}
