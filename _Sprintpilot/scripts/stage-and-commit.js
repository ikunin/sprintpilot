#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { parseArgs } = require('../lib/runtime/args');
const { tryGit, tryGitStdout, gitStdout } = require('../lib/runtime/git');
const {
  parseAllowlist,
  isAllowlisted,
  scanLinesForSecrets,
  isBinaryFile,
} = require('../lib/runtime/secrets');
const log = require('../lib/runtime/log');

function help() {
  log.out("Usage: stage-and-commit.js --message 'msg' [--allowlist path] [--max-size-mb 1] [--file-list path] [--dry-run]");
}

function splitOut(out) {
  return (out || '').split(/\r?\n/).filter(Boolean);
}

function dedupeSorted(arr) {
  return Array.from(new Set(arr)).sort();
}

async function collectChanges() {
  const modified = await tryGitStdout(['diff', '--name-only', 'HEAD']);
  const untracked = await tryGitStdout(['ls-files', '--others', '--exclude-standard']);
  const deleted = splitOut(await tryGitStdout(['diff', '--name-only', '--diff-filter=D', 'HEAD']));
  // `git diff --name-only HEAD` includes deletions — remove them from the
  // add-side list so we don't `git add` a path that no longer exists and
  // emit a spurious warning; the dedicated `git rm` loop handles them.
  const deletedSet = new Set(deleted);
  const all = dedupeSorted([...splitOut(modified), ...splitOut(untracked)])
    .filter((f) => !deletedSet.has(f));
  return { all, deleted };
}

function parseFileListMarkdown(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const results = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (m) results.push(m[1]);
  }
  return results;
}

async function main() {
  const { opts } = parseArgs(process.argv.slice(2), { booleanFlags: ['dry-run'] });
  if (opts.help) { help(); process.exit(0); }

  const message = opts.message ?? opts.m;
  const allowlist = opts.allowlist;
  const maxSizeMb = parseFloat(opts['max-size-mb'] || '1');
  const fileList = opts['file-list'];
  const dryRun = !!opts['dry-run'];

  if (!message) {
    log.error('--message required');
    process.exit(2);
  }

  const { all, deleted } = await collectChanges();

  if (all.length === 0 && deleted.length === 0) {
    log.err('Nothing to commit');
    process.exit(1);
  }

  const warnings = [];
  const maxSizeBytes = Math.round(maxSizeMb * 1024 * 1024);
  const allowPatterns = parseAllowlist(allowlist);
  // Cap secret-scan reads to keep memory bounded on accidentally-staged
  // multi-megabyte logs / generated artifacts. The scan is a warning-only
  // heuristic anyway — refusing to scan a huge file is preferable to OOM.
  const MAX_SCAN_BYTES = 2 * 1024 * 1024;

  for (const file of all) {
    try {
      // lstat (not stat) so symlinks are visible and skippable. A symlink
      // pointing outside the repo (e.g. /etc/shadow) would otherwise be
      // opened and its contents included in warning output.
      const lstat = fs.lstatSync(file);
      if (lstat.isSymbolicLink()) continue;
      if (!lstat.isFile()) continue;

      // Detect once — binary classification is the same whether we're
      // scanning for secrets or emitting the binary-file warning.
      const isBinary = isBinaryFile(file);

      if (!isAllowlisted(file, allowPatterns)) {
        if (lstat.size > MAX_SCAN_BYTES) {
          warnings.push(`secret scan skipped for ${file} (size ${Math.floor(lstat.size / 1024)} KB > ${MAX_SCAN_BYTES / 1024} KB limit)`);
        } else if (!isBinary) {
          try {
            const raw = fs.readFileSync(file, 'utf8');
            const hits = scanLinesForSecrets(raw, 3);
            if (hits.length > 0) {
              const shown = hits.map((h) => `${file}:${h.line}:${h.text}`).join('\n');
              warnings.push(`possible secret in ${file}:\n${shown}\n`);
            }
          } catch {
            // read error — skip
          }
        }
      }

      if (lstat.size > maxSizeBytes) {
        const sizeMb = Math.floor(lstat.size / (1024 * 1024));
        warnings.push(`large file ${file} (${sizeMb}MB > ${maxSizeMb}MB limit)`);
      }

      if (isBinary) {
        warnings.push(`binary file detected: ${file} (will be staged but verify it's intended)`);
      }
    } catch {
      // missing / permission — ignore
    }
  }

  if (fs.existsSync('.gitignore')) {
    // Exact line match — substring tests were fooled by the entry appearing
    // inside a comment (e.g. "# .autopilot.lock is auto-created").
    const entries = fs.readFileSync('.gitignore', 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    if (!entries.includes('.autopilot.lock')) {
      warnings.push(".gitignore missing entry '.autopilot.lock' — run installer to fix");
    }
  } else {
    warnings.push('no .gitignore found — addon artifacts may be committed');
  }

  if (fileList) {
    const expected = parseFileListMarkdown(fileList);
    if (expected.length > 0) {
      for (const file of all) {
        if (!expected.includes(file)) {
          warnings.push(`unexpected file not in story File List: ${file}`);
        }
      }
    }
  }

  for (const w of warnings) log.err(`WARN: ${w}`);

  if (dryRun) {
    log.out('DRY RUN — would stage and commit:');
    for (const f of all) log.out(f);
    if (deleted.length > 0) log.out(`Deleted: ${deleted.join(' ')}`);
    return;
  }

  // Stage adds
  for (const file of all) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    const r = await tryGit(['add', '--', file]);
    if (r.exitCode !== 0) {
      log.err(`WARN: could not add '${file}': ${(r.stderr || '').trim()}`);
    }
  }

  // Stage deletions
  for (const file of deleted) {
    const r = await tryGit(['rm', '--quiet', '--', file]);
    if (r.exitCode !== 0) {
      log.err(`WARN: could not remove '${file}' from index (may not be tracked)`);
    }
  }

  const commit = await tryGit(['commit', '-m', message]);
  if (commit.exitCode !== 0) {
    log.error(`commit failed: ${(commit.stderr || commit.stdout || '').trim()}`);
    process.exit(2);
  }

  const sha = await gitStdout(['rev-parse', 'HEAD']);
  log.out(sha);
}

main().catch((e) => {
  log.error(e.message || String(e));
  process.exit(2);
});
