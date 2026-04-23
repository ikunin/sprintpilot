#!/usr/bin/env node

// cached-read.js — TTL + mtime-aware file cache for the autopilot loop.
//
// Usage:
//   cached-read.js read     --file <path> [--ttl <ms>] [--cache-root <path>]
//   cached-read.js invalidate --file <path> [--cache-root <path>]
//   cached-read.js clear      [--cache-root <path>]
//   cached-read.js stats      [--cache-root <path>]
//
// Rationale (PR 8 / M5):
//   workflow.md re-reads sprint-status.yaml, git-status.yaml, and
//   decision-log.yaml at many step boundaries. A single loop iteration
//   can read each one 5+ times. This helper memoizes the reads to a
//   per-project cache directory, respecting TTL AND source-file mtime
//   so a write always invalidates the cache even if the caller forgets
//   to call `invalidate` explicitly.
//
// Cache layout:
//   <cache-root>/.cache/cached-reads/<sha256(file)>.json
//     { source, mtime_ms, cached_at, body }
//
// Consumer gate:
//   Callers should gate use of this script on `autopilot.cache_shared_reads`
//   via resolve-profile.js. When the flag is false, read the file directly.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');

const DEFAULT_TTL_MS = 60_000;
const VALID_ACTIONS = ['read', 'invalidate', 'clear', 'stats'];

function help() {
  log.out(
    [
      'Usage:',
      '  cached-read.js read --file <path> [--ttl <ms>] [--cache-root <path>]',
      '  cached-read.js invalidate --file <path> [--cache-root <path>]',
      '  cached-read.js clear  [--cache-root <path>]',
      '  cached-read.js stats  [--cache-root <path>]',
      '',
      `Default TTL: ${DEFAULT_TTL_MS}ms. Source-file mtime always invalidates.`,
    ].join('\n'),
  );
}

function cacheDir(cacheRoot) {
  return path.join(cacheRoot, '.cache', 'cached-reads');
}

function keyFor(filePath) {
  return crypto.createHash('sha256').update(path.resolve(filePath)).digest('hex').slice(0, 32);
}

function cacheEntryPath(cacheRoot, filePath) {
  return path.join(cacheDir(cacheRoot), `${keyFor(filePath)}.json`);
}

function readFileStat(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return { exists: true, mtime_ms: stat.mtimeMs };
  } catch {
    return { exists: false, mtime_ms: 0 };
  }
}

function readFromCache(cacheRoot, filePath, ttlMs) {
  const entryFile = cacheEntryPath(cacheRoot, filePath);
  if (!fs.existsSync(entryFile)) return { hit: false, reason: 'miss' };
  let entry;
  try {
    entry = JSON.parse(fs.readFileSync(entryFile, 'utf8'));
  } catch {
    return { hit: false, reason: 'corrupt' };
  }
  const now = Date.now();
  // ttlMs=0 means "always miss" (bypass); >= (not >) ensures that.
  if (now - entry.cached_at >= ttlMs) return { hit: false, reason: 'ttl-expired' };
  const srcStat = readFileStat(filePath);
  if (!srcStat.exists) return { hit: false, reason: 'source-gone' };
  if (srcStat.mtime_ms > entry.mtime_ms) return { hit: false, reason: 'source-newer' };
  return { hit: true, body: entry.body, entry };
}

function writeToCache(cacheRoot, filePath, body) {
  const dir = cacheDir(cacheRoot);
  fs.mkdirSync(dir, { recursive: true });
  const srcStat = readFileStat(filePath);
  const entry = {
    source: path.resolve(filePath),
    mtime_ms: srcStat.mtime_ms,
    cached_at: Date.now(),
    body,
  };
  const file = cacheEntryPath(cacheRoot, filePath);
  const tmp = `${file}.tmp.${process.pid}.${process.hrtime.bigint().toString(36)}`;
  fs.writeFileSync(tmp, JSON.stringify(entry));
  fs.renameSync(tmp, file);
  return file;
}

function readThrough(cacheRoot, filePath, ttlMs) {
  const hit = readFromCache(cacheRoot, filePath, ttlMs);
  if (hit.hit) return { body: hit.body, hit: true, source: filePath };
  // Cache miss — read through.
  if (!fs.existsSync(filePath)) {
    return { body: null, hit: false, source: filePath, reason: hit.reason || 'missing' };
  }
  const body = fs.readFileSync(filePath, 'utf8');
  writeToCache(cacheRoot, filePath, body);
  return { body, hit: false, source: filePath, reason: hit.reason };
}

function invalidate(cacheRoot, filePath) {
  const file = cacheEntryPath(cacheRoot, filePath);
  try {
    fs.unlinkSync(file);
    return { cleared: true };
  } catch {
    return { cleared: false };
  }
}

function clearAll(cacheRoot) {
  const dir = cacheDir(cacheRoot);
  if (!fs.existsSync(dir)) return { cleared: 0 };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  let cleared = 0;
  for (const f of files) {
    try {
      fs.unlinkSync(path.join(dir, f));
      cleared++;
    } catch {
      /* best effort */
    }
  }
  return { cleared };
}

function stats(cacheRoot) {
  const dir = cacheDir(cacheRoot);
  if (!fs.existsSync(dir)) return { entries: 0, oldest_age_ms: null, newest_age_ms: null };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const now = Date.now();
  let oldest = Infinity;
  let newest = 0;
  for (const f of files) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const age = now - entry.cached_at;
      if (age < oldest) oldest = age;
      if (age > newest) newest = age;
    } catch {
      /* skip corrupt */
    }
  }
  return {
    entries: files.length,
    oldest_age_ms: files.length ? oldest : null,
    newest_age_ms: files.length ? newest : null,
  };
}

function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));
  if (opts.help || positional.length === 0) {
    help();
    process.exit(opts.help ? 0 : 1);
  }
  const action = positional[0];
  if (!VALID_ACTIONS.includes(action)) {
    log.error(`unknown action '${action}'. Valid: ${VALID_ACTIONS.join(', ')}`);
    process.exit(1);
  }
  const cacheRoot = opts['cache-root'] || process.cwd();
  const filePath = opts.file;
  const ttlMs = opts.ttl !== undefined ? Number.parseInt(String(opts.ttl), 10) : DEFAULT_TTL_MS;
  if (Number.isNaN(ttlMs) || ttlMs < 0) {
    log.error(`invalid --ttl '${opts.ttl}': must be a non-negative integer (ms)`);
    process.exit(1);
  }

  if (action === 'read') {
    if (!filePath) {
      log.error('--file is required for read');
      process.exit(1);
    }
    const out = readThrough(cacheRoot, filePath, ttlMs);
    if (out.body === null) {
      log.error(`source missing: ${filePath}`);
      process.exit(2);
    }
    process.stdout.write(out.body);
    return;
  }
  if (action === 'invalidate') {
    if (!filePath) {
      log.error('--file is required for invalidate');
      process.exit(1);
    }
    const r = invalidate(cacheRoot, filePath);
    process.stdout.write(`${JSON.stringify(r)}\n`);
    return;
  }
  if (action === 'clear') {
    const r = clearAll(cacheRoot);
    process.stdout.write(`${JSON.stringify(r)}\n`);
    return;
  }
  if (action === 'stats') {
    const r = stats(cacheRoot);
    process.stdout.write(`${JSON.stringify(r)}\n`);
  }
}

module.exports = {
  DEFAULT_TTL_MS,
  VALID_ACTIONS,
  cacheDir,
  keyFor,
  cacheEntryPath,
  readFileStat,
  readFromCache,
  writeToCache,
  readThrough,
  invalidate,
  clearAll,
  stats,
};

if (require.main === module) {
  main();
}
