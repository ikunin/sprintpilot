#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');

const ACTIONS = ['check', 'acquire', 'release', 'status'];
const CLOCK_SKEW_TOLERANCE_SECONDS = 60;

function help() {
  log.out('Usage: lock.js <check|acquire|release|status> [--file path] [--stale-minutes n]');
}

function makeSessionId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `session-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
}

function readLockInfo(lockFile, staleSeconds) {
  let stat;
  try {
    stat = fs.lstatSync(lockFile);
  } catch {
    return { state: 'FREE' };
  }
  // A non-regular-file lock (directory, symlink, device, etc.) is unsafe to
  // read/overwrite. Treat as LOCKED so the operator can investigate rather
  // than silently stomp it.
  // Identifiers returned from this function are included in the CLI's
  // stdout as part of a `STATE:ID:AGE` contract — callers split on `:`, so
  // IDs must not contain colons, spaces, or parentheses. Use stable,
  // parser-safe slugs for the diagnostic cases.
  if (!stat.isFile()) {
    return { state: 'LOCKED', id: 'non-file-lock-path', ageMin: 0, corrupt: true };
  }

  let raw;
  try {
    raw = fs.readFileSync(lockFile, 'utf8');
  } catch {
    return { state: 'LOCKED', id: 'unreadable-lock', ageMin: 0, corrupt: true };
  }

  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  const firstLine = lines[0];
  // A corrupted or unparseable first line is not automatically stale.
  // Treating garbage as epoch-0 lets anyone wipe a live lock by writing junk.
  if (!firstLine || !/^\d+$/.test(firstLine)) {
    return { state: 'LOCKED', id: 'corrupt-lock', ageMin: 0, corrupt: true };
  }

  const lockTime = parseInt(firstLine, 10);
  const lockId = lines[lines.length - 1] || 'unknown';
  const now = Math.floor(Date.now() / 1000);
  const age = now - lockTime;

  // Future-dated lockTime (clock skew, DST, manual mtime): treat as STALE so
  // the lock doesn't become permanent. Tolerate a small positive skew window.
  if (age < -CLOCK_SKEW_TOLERANCE_SECONDS) {
    return { state: 'STALE', id: lockId, ageMin: 0, skew: true };
  }

  const ageMin = Math.floor(Math.max(age, 0) / 60);
  if (age < staleSeconds) return { state: 'LOCKED', id: lockId, ageMin };
  return { state: 'STALE', id: lockId, ageMin };
}

// Atomic exclusive-create write — the lockfile's existence IS the lock.
// Two racing acquirers cannot both win: the second sees EEXIST.
function writeLockExclusive(lockFile, id) {
  const dir = path.dirname(lockFile);
  if (dir && dir !== '.' && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const ts = Math.floor(Date.now() / 1000);
  const content = `${ts}\n${id}\n`;
  // 'wx' => O_CREAT | O_EXCL: fails with EEXIST if file already exists.
  const fd = fs.openSync(lockFile, 'wx', 0o644);
  let wrote = false;
  try {
    fs.writeSync(fd, content, 0, 'utf8');
    wrote = true;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    if (!wrote) {
      // writeSync failed (ENOSPC, EIO): leaving an empty lockfile behind
      // would look "corrupt" to the next acquirer and permanently wedge
      // the autopilot. Unlink so the next try can re-create cleanly.
      try {
        fs.unlinkSync(lockFile);
      } catch {
        /* ignore */
      }
    }
  }
}

function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));

  if (opts.help) {
    help();
    process.exit(0);
  }

  const action = positional.find((p) => ACTIONS.includes(p));
  const lockFile = opts.file || '.autopilot.lock';
  const staleMinutes = parseInt(opts['stale-minutes'] || '30', 10);
  const staleSeconds = staleMinutes * 60;

  if (!action) {
    log.error('action required (check|acquire|release|status)');
    process.exit(1);
  }

  if (action === 'check') {
    const info = readLockInfo(lockFile, staleSeconds);
    if (info.state === 'FREE') log.out('FREE');
    else log.out(`${info.state}:${info.id}:${info.ageMin}m`);
    return;
  }

  if (action === 'acquire') {
    const id = makeSessionId();
    // First try the fast exclusive-create path.
    try {
      writeLockExclusive(lockFile, id);
      log.out(`ACQUIRED:${id}`);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') {
        log.error(`failed to acquire lock: ${e.message}`);
        process.exit(1);
      }
    }

    // EEXIST: inspect the current lock. Only STALE may be taken over, and
    // the takeover is still racy (two processes could unlink+recreate) —
    // mitigate by re-doing an exclusive create after unlink. On race, one
    // of them gets EEXIST.
    const info = readLockInfo(lockFile, staleSeconds);
    if (info.state === 'STALE') {
      try {
        fs.unlinkSync(lockFile);
      } catch {
        /* ignore */
      }
      try {
        writeLockExclusive(lockFile, id);
        log.out(`ACQUIRED_STALE:${id}`);
        return;
      } catch (e) {
        // Another acquirer either won the stale takeover race, OR released
        // their lock in the meantime. Re-read and handle both cases.
        const fresh = readLockInfo(lockFile, staleSeconds);
        if (fresh.state === 'FREE') {
          // Released between our unlink and our re-create. Try once more.
          try {
            writeLockExclusive(lockFile, id);
            log.out(`ACQUIRED:${id}`);
            return;
          } catch {
            const afterRetry = readLockInfo(lockFile, staleSeconds);
            log.out(`LOCKED:${afterRetry.id || 'unknown'}:${afterRetry.ageMin || 0}m`);
            process.exit(1);
          }
        }
        log.out(`LOCKED:${fresh.id || 'unknown'}:${fresh.ageMin || 0}m`);
        process.exit(1);
      }
    }

    // LOCKED (or corrupt lock — surface the state rather than silently evicting it).
    log.out(`LOCKED:${info.id}:${info.ageMin}m`);
    process.exit(1);
  }

  if (action === 'release') {
    if (fs.existsSync(lockFile)) {
      try {
        fs.unlinkSync(lockFile);
      } catch {
        /* ignore */
      }
      log.out('RELEASED');
    } else {
      log.out('NO_LOCK');
    }
    return;
  }

  if (action === 'status') {
    const info = readLockInfo(lockFile, staleSeconds);
    if (info.state === 'FREE') log.out('Lock: free (no active session)');
    else if (info.state === 'LOCKED')
      log.out(`Lock: ACTIVE — session ${info.id}, age ${info.ageMin}m`);
    else log.out(`Lock: STALE — session ${info.id}, age ${info.ageMin}m (will auto-remove)`);
  }
}

main();
