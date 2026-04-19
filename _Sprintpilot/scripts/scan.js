#!/usr/bin/env node

/**
 * Cross-platform codebase scanner.
 *
 * Replaces bash pipelines like `find ... -exec wc -l {} + | sort -rn | head -N`
 * so sprintpilot skills work on Windows PowerShell / cmd / Gemini CLI, not just bash.
 *
 * Subcommands:
 *   files       List files matching include globs, excluding ignore globs.
 *               Flags: --include, --exclude, --root, --limit, --count
 *   largest     Top N files by line count.
 *               Flags: --include, --exclude, --root, --limit (default 10)
 *   loc         Total line count across matched files.
 *               Flags: --include, --exclude, --root
 *   extensions  Extension frequency histogram, descending.
 *               Flags: --exclude, --root, --limit (default 20)
 */

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');

const DEFAULT_EXCLUDES = [
  'node_modules',
  '.git',
  'vendor',
  'target',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'coverage',
  '.turbo',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.worktrees',
];

function help() {
  log.out(
    'Usage: scan.js <files|largest|loc|extensions> [--include <globs>] [--exclude <globs>] [--root <path>] [--limit <N>] [--count]',
  );
}

// Split a comma-delimited list, but keep commas inside {a,b} brace groups intact.
function splitList(value) {
  if (value === undefined || value === null || value === true) return [];
  const s = String(value);
  const out = [];
  let buf = '';
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    if (c === ',' && depth === 0) {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
    } else {
      buf += c;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// Find matching closing brace, respecting nesting. Returns -1 if unterminated.
function findBraceClose(glob, start) {
  let depth = 1;
  for (let i = start + 1; i < glob.length; i++) {
    const c = glob[i];
    if (c === '\\' && i + 1 < glob.length) {
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Split a brace group's body on commas at depth 0 (so nested braces stay intact).
function splitBraceAlts(body) {
  const parts = [];
  let buf = '';
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\' && i + 1 < body.length) {
      buf += c + body[i + 1];
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    if (c === ',' && depth === 0) {
      parts.push(buf);
      buf = '';
    } else {
      buf += c;
    }
  }
  parts.push(buf);
  return parts;
}

// Convert a glob pattern into a RegExp.
// Supports: * (any chars except /), ** (any chars incl. /), ? (single non-/),
// {a,b} alternation (nestable), and literal path segments.
// Matching is against forward-slash paths.
function globToRegex(glob) {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '\\') {
      if (i + 1 >= glob.length) {
        // Trailing lone backslash — emit as a literal backslash.
        re += '\\\\';
        i++;
        continue;
      }
      // Literal escape: pass the next char through verbatim.
      const next = glob[i + 1];
      re += '.+^$()|[]{}?*\\'.includes(next) ? '\\' + next : next;
      i += 2;
      continue;
    }
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (glob[i] === '/') i++; // consume trailing slash of ** segment
      } else {
        re += '[^/]*';
        i++;
      }
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i++;
      continue;
    }
    if (c === '{') {
      const end = findBraceClose(glob, i);
      if (end === -1) {
        // Unterminated brace — treat as literal.
        re += '\\{';
        i++;
        continue;
      }
      const alts = splitBraceAlts(glob.slice(i + 1, end));
      const altRegexes = alts.map((p) => globToRegex(p).source.slice(1, -1));
      re += `(?:${altRegexes.join('|')})`;
      i = end + 1;
      continue;
    }
    if ('.+^$()|[]'.includes(c)) {
      re += '\\' + c;
      i++;
      continue;
    }
    re += c;
    i++;
  }
  return new RegExp('^' + re + '$');
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

// Compile a pattern into { raw, re, pathAnchored }.
// pathAnchored = true if the pattern contains a path separator; such patterns
// only match the full relative path. Basename-only patterns (no '/') match
// both the full path and the basename, so "*.ts" works at any depth.
function compilePatterns(patterns) {
  return patterns.map((p) => ({
    raw: p,
    re: globToRegex(p),
    pathAnchored: p.includes('/'),
  }));
}

function matchesAny(relPath, compiled) {
  if (compiled.length === 0) return false;
  const basename = relPath.slice(relPath.lastIndexOf('/') + 1);
  for (const { re, pathAnchored } of compiled) {
    if (re.test(relPath)) return true;
    if (!pathAnchored && re.test(basename)) return true;
  }
  return false;
}

function isExcludedDir(name, excludeBasenames) {
  return excludeBasenames.has(name);
}

function matchesExcludePath(relPath, compiled) {
  return matchesAny(relPath, compiled);
}

// Resolve a dirent to { kind: 'file' | 'dir' | 'other' }, following symlinks
// through stat(). Returns 'other' on broken links or errors.
function classifyEntry(fullPath, entry) {
  if (entry.isFile()) return 'file';
  if (entry.isDirectory()) return 'dir';
  if (entry.isSymbolicLink()) {
    try {
      const st = fs.statSync(fullPath);
      if (st.isFile()) return 'file';
      if (st.isDirectory()) return 'dir';
    } catch {
      return 'other';
    }
  }
  return 'other';
}

function isWithinRoot(real, rootReal) {
  if (real === rootReal) return true;
  const prefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  return real.startsWith(prefix);
}

// Walk directory tree, yielding files that match includes and not excludes.
// Follows symlinks (like GNU find's default) but:
//   - breaks cycles by tracking the realpath of every directory visited
//   - refuses to traverse symlinks that escape the --root boundary
function* walk(root, includes, excludes, excludeBasenames) {
  const visited = new Set();
  let rootReal;
  try {
    rootReal = fs.realpathSync(root);
  } catch {
    rootReal = path.resolve(root);
  }
  visited.add(rootReal);

  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = toPosix(path.relative(root, full));
      const kind = classifyEntry(full, entry);
      if (kind === 'dir') {
        if (isExcludedDir(entry.name, excludeBasenames)) continue;
        if (matchesExcludePath(rel, excludes)) continue;
        let real;
        try {
          real = fs.realpathSync(full);
        } catch {
          continue;
        }
        if (visited.has(real)) continue;
        if (!isWithinRoot(real, rootReal)) continue; // refuse symlinks that escape root
        visited.add(real);
        stack.push(full);
        continue;
      }
      if (kind !== 'file') continue;
      if (matchesExcludePath(rel, excludes)) continue;
      if (includes.length > 0 && !matchesAny(rel, includes)) continue;
      // For symlinked files, verify the target is within root.
      if (entry.isSymbolicLink()) {
        try {
          const fileReal = fs.realpathSync(full);
          if (!isWithinRoot(fileReal, rootReal)) continue;
        } catch {
          continue;
        }
      }
      yield rel;
    }
  }
}

function readLineCount(fullPath) {
  let fd;
  try {
    fd = fs.openSync(fullPath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    let count = 0;
    let bytesRead;
    let lastByte = null;
    let total = 0;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      total += bytesRead;
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 0x0a) count++;
      }
      lastByte = buf[bytesRead - 1];
    }
    // Count the final line if the file is non-empty and doesn't end with \n
    if (total > 0 && lastByte !== 0x0a) count++;
    return count;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function resolveRoot(opts) {
  const root = opts.root ? path.resolve(opts.root) : process.cwd();
  try {
    if (!fs.statSync(root).isDirectory()) {
      log.fail(`root is not a directory: ${root}`);
    }
  } catch {
    log.fail(`root does not exist: ${root}`);
  }
  return root;
}

function buildExcludes(extra) {
  const list = [...DEFAULT_EXCLUDES, ...extra];
  // Patterns: match the basename of a directory OR any path containing it.
  const patterns = [];
  const basenames = new Set();
  for (const item of list) {
    if (item.includes('/') || item.includes('*')) {
      patterns.push(item);
    } else {
      basenames.add(item);
      patterns.push(`**/${item}/**`);
      patterns.push(item);
    }
  }
  return { compiled: compilePatterns(patterns), basenames };
}

function cmdFiles(opts) {
  const root = resolveRoot(opts);
  const includes = compilePatterns(splitList(opts.include));
  const { compiled: excludes, basenames } = buildExcludes(splitList(opts.exclude));
  const limit = opts.limit ? Number(opts.limit) : 0;
  const count = opts.count === true || opts.count === 'true';

  let n = 0;
  const out = [];
  for (const rel of walk(root, includes, excludes, basenames)) {
    n++;
    if (!count) {
      out.push(rel);
      if (limit > 0 && out.length >= limit) break;
    }
  }
  if (count) {
    log.out(String(n));
  } else {
    for (const p of out) log.out(p);
  }
}

function cmdLargest(opts) {
  const root = resolveRoot(opts);
  const includes = compilePatterns(splitList(opts.include));
  const { compiled: excludes, basenames } = buildExcludes(splitList(opts.exclude));
  const limit = opts.limit ? Number(opts.limit) : 10;

  const heap = []; // simple array; N is small so O(files * log N) is fine
  for (const rel of walk(root, includes, excludes, basenames)) {
    const full = path.join(root, rel);
    const lines = readLineCount(full);
    heap.push({ lines, path: rel });
  }
  heap.sort((a, b) => b.lines - a.lines);
  for (const item of heap.slice(0, limit)) {
    log.out(`${item.lines}\t${item.path}`);
  }
}

function cmdLoc(opts) {
  const root = resolveRoot(opts);
  const includes = compilePatterns(splitList(opts.include));
  const { compiled: excludes, basenames } = buildExcludes(splitList(opts.exclude));

  let total = 0;
  let fileCount = 0;
  for (const rel of walk(root, includes, excludes, basenames)) {
    total += readLineCount(path.join(root, rel));
    fileCount++;
  }
  log.out(`${total}\t${fileCount}`);
}

function cmdExtensions(opts) {
  const root = resolveRoot(opts);
  const { compiled: excludes, basenames } = buildExcludes(splitList(opts.exclude));
  const limit = opts.limit ? Number(opts.limit) : 20;

  const counts = new Map();
  for (const rel of walk(root, [], excludes, basenames)) {
    const base = rel.split('/').pop();
    const dot = base.lastIndexOf('.');
    const ext = dot > 0 ? base.slice(dot + 1) : '(no-ext)';
    counts.set(ext, (counts.get(ext) || 0) + 1);
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  for (const [ext, n] of rows) {
    log.out(`${n}\t${ext}`);
  }
}

function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2), {
    booleanFlags: ['count'],
  });
  if (opts.help || positional.length === 0) {
    help();
    process.exit(opts.help ? 0 : 1);
  }
  const cmd = positional[0];
  switch (cmd) {
    case 'files':
      cmdFiles(opts);
      break;
    case 'largest':
      cmdLargest(opts);
      break;
    case 'loc':
      cmdLoc(opts);
      break;
    case 'extensions':
      cmdExtensions(opts);
      break;
    default:
      log.error(`Unknown subcommand: ${cmd}`);
      help();
      process.exit(1);
  }
}

main();
