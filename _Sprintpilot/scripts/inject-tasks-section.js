#!/usr/bin/env node

// inject-tasks-section.js — deterministic fallback for bmad-create-story
// when it emits a story file without a `## Tasks` / `## Subtasks` section.
//
// Usage:
//   inject-tasks-section.js --story-file <path> [--ac-section "Acceptance Criteria"]
//
// Behavior (idempotent):
//   1. If the story file already has a `## Tasks` or `## Subtasks` section
//      with at least one `- [ ]` checkbox, do nothing. Exit 0.
//   2. Otherwise, locate the `## Acceptance Criteria` section. Extract
//      every AC entry — numbered list item (`1. foo`), bullet (`- foo`),
//      or `**AC-N:** foo` — ONLY within that section (bounded by the next
//      `##` heading or EOF).
//   3. Append a new `## Tasks / Subtasks` section to the story file with
//      one `- [ ] <AC summary>` bullet per AC entry.
//
// Exits:
//   0 — section already present or appended successfully
//   1 — story file missing or AC section cannot be located (nothing to do)
//
// Why this exists: the previous LLM-prose instruction in workflow.md was
// under-specified — it told the agent to "read every `N. ...` line" with
// no section boundary, which regularly scraped lines from Dev Notes or
// body prose. This script pins the scan exactly to the AC section.

const fs = require('node:fs');
const path = require('node:path');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');
const { atomicWrite } = require('./mark-done-stories-tasks.js');

function help() {
  log.out(
    [
      'Usage:',
      '  inject-tasks-section.js --story-file <path> [--ac-section "Acceptance Criteria"]',
      '',
      'Ensures the story file has a `## Tasks / Subtasks` section with at',
      'least one `- [ ]` checkbox. If the section is missing, appends one',
      'derived 1:1 from the `## Acceptance Criteria` section. Idempotent.',
    ].join('\n'),
  );
}

// Locate `## Tasks` or `## Subtasks` (case-insensitive, any depth >= 2)
// and check whether the section contains at least one `- [ ]` checkbox.
// Returns { found: boolean, hasCheckbox: boolean }.
function inspectTasksSection(body) {
  const lines = body.split('\n');
  const headerRe = /^(#{2,})\s+(tasks|subtasks)(\s*\/\s*(tasks|subtasks))?\s*$/i;
  let inSection = false;
  let headerLevel = 0;
  let found = false;
  let hasCheckbox = false;

  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+.*$/);
    if (h) {
      if (inSection && h[1].length <= headerLevel) {
        // left the section
        break;
      }
      const match = line.match(headerRe);
      if (match) {
        inSection = true;
        found = true;
        headerLevel = match[1].length;
        continue;
      }
    }
    if (inSection && /^\s*[-*]\s*\[ \]/.test(line)) {
      hasCheckbox = true;
    }
  }

  return { found, hasCheckbox };
}

// Extract AC entries from the `## Acceptance Criteria` section.
// An entry is one of:
//   1. <text>
//   - <text>
//   * <text>
//   **AC-N:** <text>
// Scanning is strictly bounded to within the AC section.
function extractAcceptanceCriteria(body, sectionName) {
  const lines = body.split('\n');
  const headerRe = new RegExp(
    `^(#{2,})\\s+${sectionName.replace(/[.*+?^${}()|[\\\]]/g, '\\$&')}\\s*$`,
    'i',
  );
  let inSection = false;
  let sectionHeaderLevel = 0;
  const entries = [];

  const acEntryRes = [
    /^\s*\d+\.\s+(.+?)\s*$/, // 1. foo
    /^\s*[-*]\s+(?:\*\*AC-\d+:?\*\*\s*)?(.+?)\s*$/, // - foo  or  - **AC-1:** foo
    /^\s*\*\*AC-\d+:?\*\*\s*(.+?)\s*$/, // **AC-1:** foo
  ];

  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+.*$/);
    if (h) {
      if (inSection && h[1].length <= sectionHeaderLevel) {
        // closing header — exit the AC section
        inSection = false;
        break;
      }
      const match = line.match(headerRe);
      if (match) {
        inSection = true;
        sectionHeaderLevel = match[1].length;
        continue;
      }
    }
    if (!inSection) continue;
    if (/^\s*$/.test(line)) continue; // blank
    for (const re of acEntryRes) {
      const m = line.match(re);
      if (m && m[1]) {
        // Collapse whitespace and trim.
        const text = m[1].replace(/\s+/g, ' ').trim();
        if (text) entries.push(text);
        break;
      }
    }
  }

  return entries;
}

function buildTasksSection(entries) {
  const lines = ['', '## Tasks / Subtasks', ''];
  if (entries.length === 0) {
    lines.push('- [ ] Implement story per Acceptance Criteria');
  } else {
    for (const e of entries) {
      lines.push(`- [ ] ${e}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function main() {
  const { opts } = parseArgs(process.argv.slice(2));
  if (opts.help) {
    help();
    process.exit(0);
  }
  const storyFile = opts['story-file'];
  if (!storyFile) {
    log.error('--story-file is required');
    process.exit(1);
  }
  if (!fs.existsSync(storyFile)) {
    log.error(`story file missing: ${storyFile}`);
    process.exit(1);
  }
  const acSectionName = opts['ac-section'] || 'Acceptance Criteria';

  const body = fs.readFileSync(storyFile, 'utf8');
  const info = inspectTasksSection(body);
  if (info.found && info.hasCheckbox) {
    process.stdout.write(
      `${JSON.stringify({ action: 'skip', reason: 'tasks-section-present' })}\n`,
    );
    process.exit(0);
  }

  const entries = extractAcceptanceCriteria(body, acSectionName);
  const section = buildTasksSection(entries);

  let newBody;
  if (info.found && !info.hasCheckbox) {
    // Section exists but has no checkboxes — append checkboxes inside it
    // by inserting after the header line.
    const lines = body.split('\n');
    const headerRe = /^(#{2,})\s+(tasks|subtasks)(\s*\/\s*(tasks|subtasks))?\s*$/i;
    for (let i = 0; i < lines.length; i++) {
      if (headerRe.test(lines[i])) {
        const injection = entries.length === 0
          ? ['', '- [ ] Implement story per Acceptance Criteria', '']
          : ['', ...entries.map((e) => `- [ ] ${e}`), ''];
        lines.splice(i + 1, 0, ...injection);
        break;
      }
    }
    newBody = lines.join('\n');
  } else {
    newBody = body.replace(/\s*$/, '') + '\n' + section;
  }

  atomicWrite(path.resolve(storyFile), newBody);
  process.stdout.write(
    `${JSON.stringify({
      action: info.found ? 'checkboxes-added' : 'section-appended',
      entries: entries.length,
    })}\n`,
  );
}

module.exports = {
  inspectTasksSection,
  extractAcceptanceCriteria,
  buildTasksSection,
};

if (require.main === module) {
  main();
}
