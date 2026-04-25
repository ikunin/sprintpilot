#!/usr/bin/env node

// mark-done-stories-tasks.js — final pass that replaces `- [ ]` with `- [x]`
// in every story file whose status is "done" in sprint-status.yaml.
//
// Usage:
//   mark-done-stories-tasks.js --status-file <path> [--project-root <path>]
//                              [--output-folder <path>]
//
// Rationale: bmad-dev-story is supposed to check off its Tasks/Subtasks as
// it implements each story, and workflow.md's step 7 has an explicit
// "Mark all task checkboxes complete" action. Both are LLM-executed
// instructions that the autopilot sometimes skips in long sessions. This
// helper is the final deterministic safety net — it runs from step 10's
// critical path and brings the filesystem state in line with sprint-status.
//
// Story file lookup: honors BMad's `output_folder` config
// (_bmad/bmm/config.yaml). Resolves in this order:
//   <output-folder>/stories/story-<key>.md
//   <output-folder>/implementation-artifacts/story-<key>.md
//   <output-folder>/stories/<key>.md
//   <output-folder>/implementation-artifacts/<key>.md
//
// Checkbox replacement is fenced-code-aware: `- [ ]` inside triple-backtick
// or triple-tilde blocks is NOT rewritten, because story templates commonly
// show example task lists that must round-trip verbatim.
//
// Writes are durable-atomic: write to tmp, fsync tmp, rename, fsync parent
// directory. A crash between rename and flush cannot leave a zero-byte
// story file.

const fs = require('node:fs');
const path = require('node:path');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');
const { parseStatuses, isDone } = require('./list-remaining-stories.js');

function help() {
  log.out(
    [
      'Usage:',
      '  mark-done-stories-tasks.js --status-file <path> [--project-root <path>]',
      '                             [--output-folder <path>]',
      '',
      'For every story with status="done" (case-insensitive), replaces every',
      '`- [ ]` with `- [x]` in its story markdown file. Fenced code blocks',
      'are preserved verbatim. Emits JSON summary to stdout.',
    ].join('\n'),
  );
}

// Read BMad's output_folder from _bmad/bmm/config.yaml if present. Returns
// the folder name (relative to projectRoot) or null if not configurable.
function readOutputFolder(projectRoot) {
  const cfg = path.join(projectRoot, '_bmad', 'bmm', 'config.yaml');
  if (!fs.existsSync(cfg)) return null;
  try {
    const body = fs.readFileSync(cfg, 'utf8');
    const m = body.match(/^output_folder\s*:\s*(\S+)/m);
    if (!m) return null;
    return m[1].replace(/^["']|["']$/g, '').trim();
  } catch {
    return null;
  }
}

function findStoryFile(projectRoot, storyKey, outputFolder) {
  const folder = outputFolder || readOutputFolder(projectRoot) || '_bmad-output';
  const candidates = [
    path.join(projectRoot, folder, 'stories', `story-${storyKey}.md`),
    path.join(projectRoot, folder, 'implementation-artifacts', `story-${storyKey}.md`),
    path.join(projectRoot, folder, 'stories', `${storyKey}.md`),
    path.join(projectRoot, folder, 'implementation-artifacts', `${storyKey}.md`),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// Line-by-line replacement that tracks fenced code blocks. Inside ``` or
// ~~~ blocks the original line is emitted verbatim. Outside, `- [ ]` (or
// `* [ ]`) at any indent is rewritten to `- [x]`.
//
// Fence detection: a line whose first non-whitespace characters are ```
// or ~~~ toggles the fenced state. Info strings after the opener (e.g.
// ```ts) are allowed. Only the fence character is significant.
function markAllTasksChecked(body) {
  const lines = String(body).split('\n');
  const out = new Array(lines.length);
  let inFence = false;
  let fenceChar = null;
  const fenceOpenRe = /^\s*(`{3,}|~{3,})/;
  const taskRe = /^(\s*[-*]\s*)\[ \](\s*)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(fenceOpenRe);
    if (fence) {
      const ch = fence[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
      } else if (fenceChar === ch) {
        inFence = false;
        fenceChar = null;
      }
      out[i] = line;
      continue;
    }
    if (inFence) {
      out[i] = line;
      continue;
    }
    out[i] = line.replace(taskRe, (_m, pre, post) => `${pre}[x]${post}`);
  }
  return out.join('\n');
}

// Durable-atomic write: tmp → fsync(tmp) → rename → fsync(parent dir).
// Preserves file mode of the existing target if possible.
function atomicWrite(file, body) {
  const dir = path.dirname(file);
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.tmp.${process.pid}.${process.hrtime.bigint().toString(36)}`,
  );
  let mode;
  try {
    mode = fs.statSync(file).mode;
  } catch {
    /* new file — leave mode unset */
  }

  const fd = fs.openSync(tmp, 'w', mode ?? 0o644);
  try {
    fs.writeFileSync(fd, body);
    try {
      fs.fsyncSync(fd);
    } catch {
      /* fsync not supported on this fs — best-effort */
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  // Best-effort directory fsync so the rename itself is durable. Skipped on
  // Windows where fs.openSync(<dir>, 'r') throws EISDIR/EPERM — there's no
  // documented way to fsync a directory handle. The rename itself is still
  // atomic on NTFS, just not flushed to disk on power loss the way fsync
  // would guarantee on POSIX.
  if (process.platform !== 'win32') {
    try {
      const dfd = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(dfd);
      } finally {
        fs.closeSync(dfd);
      }
    } catch {
      /* directory fsync unsupported on some filesystems — ignore */
    }
  }
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
  const outputFolder = opts['output-folder'] || null;

  let raw;
  try {
    raw = fs.readFileSync(statusFile, 'utf8');
  } catch (e) {
    log.error(`cannot read ${statusFile}: ${e.message}`);
    process.exit(1);
  }

  const stories = parseStatuses(raw);
  const doneKeys = Object.keys(stories).filter((k) => isDone(stories[k].status));

  const summary = {
    done_stories: doneKeys.length,
    marked: [],
    missing_files: [],
    unchanged: [],
  };

  for (const key of doneKeys) {
    const file = findStoryFile(projectRoot, key, outputFolder);
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
  readOutputFolder,
};

if (require.main === module) {
  main();
}
