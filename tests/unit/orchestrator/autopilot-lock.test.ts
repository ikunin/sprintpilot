import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// @ts-expect-error — CommonJS module
import autopilot from '../../../_Sprintpilot/bin/autopilot.js';
// @ts-expect-error — CommonJS module
import profileRules from '../../../_Sprintpilot/lib/orchestrator/profile-rules.js';

const { acquireAutopilotLock } = autopilot as {
  acquireAutopilotLock: (
    persisted: Record<string, unknown>,
    profile: Record<string, unknown>,
    projectRoot: string,
  ) => {
    acquired: boolean;
    id?: string | null;
    holder?: string;
    ageMin?: number;
    refreshed?: boolean;
    takeover?: string;
    skipped?: boolean;
  };
};

const { flatToProfile } = profileRules as {
  flatToProfile: (resolved: unknown, name: string) => Record<string, unknown>;
};

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const REAL_LOCK_SCRIPT = join(REPO_ROOT, '_Sprintpilot', 'scripts', 'lock.js');

let tmp: string;

function setupProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'autopilot-lock-'));
  // Stage lock.js and its runtime deps so acquireAutopilotLock can spawn it.
  mkdirSync(join(root, '_Sprintpilot', 'scripts'), { recursive: true });
  mkdirSync(join(root, '_Sprintpilot', 'lib', 'runtime'), { recursive: true });
  cpSync(REAL_LOCK_SCRIPT, join(root, '_Sprintpilot', 'scripts', 'lock.js'));
  cpSync(
    join(REPO_ROOT, '_Sprintpilot', 'lib', 'runtime', 'args.js'),
    join(root, '_Sprintpilot', 'lib', 'runtime', 'args.js'),
  );
  cpSync(
    join(REPO_ROOT, '_Sprintpilot', 'lib', 'runtime', 'log.js'),
    join(root, '_Sprintpilot', 'lib', 'runtime', 'log.js'),
  );
  return root;
}

beforeEach(() => {
  tmp = setupProject();
});

afterEach(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

describe('acquireAutopilotLock', () => {
  it('acquires when no lock exists (FREE)', () => {
    const r = acquireAutopilotLock({}, flatToProfile({}, 'medium'), tmp);
    expect(r.acquired).toBe(true);
    expect(typeof r.id).toBe('string');
    expect(existsSync(join(tmp, '.autopilot.lock'))).toBe(true);
  });

  it('blocks when a foreign session holds a fresh lock', () => {
    // Pre-create a lock owned by some other session, age 1 minute.
    const ts = Math.floor(Date.now() / 1000) - 60;
    writeFileSync(join(tmp, '.autopilot.lock'), `${ts}\nother-session\n`);
    const r = acquireAutopilotLock({}, flatToProfile({}, 'medium'), tmp);
    expect(r.acquired).toBe(false);
    expect(r.holder).toBe('other-session');
    expect(r.ageMin).toBeGreaterThanOrEqual(0);
  });

  it('refreshes its own lock when persisted.lock_session_id matches', () => {
    const ts = Math.floor(Date.now() / 1000) - 60;
    writeFileSync(join(tmp, '.autopilot.lock'), `${ts}\nmy-session-id\n`);
    const r = acquireAutopilotLock(
      { lock_session_id: 'my-session-id' },
      flatToProfile({}, 'medium'),
      tmp,
    );
    expect(r.acquired).toBe(true);
    expect(r.id).toBe('my-session-id');
    expect(r.refreshed).toBe(true);
    // Lockfile rewritten with a newer timestamp:
    const newRaw = readFileSync(join(tmp, '.autopilot.lock'), 'utf8');
    const newTs = parseInt(newRaw.split('\n')[0], 10);
    expect(newTs).toBeGreaterThan(ts);
  });

  it('takes over a stale lock (older than stale_timeout_minutes)', () => {
    // 60 minutes old, default stale threshold = 30.
    const ts = Math.floor(Date.now() / 1000) - 60 * 60;
    writeFileSync(join(tmp, '.autopilot.lock'), `${ts}\ndead-session\n`);
    const r = acquireAutopilotLock({}, flatToProfile({}, 'medium'), tmp);
    expect(r.acquired).toBe(true);
    expect(r.takeover).toBe('stale');
    // New ID, not the dead one:
    expect(r.id).not.toBe('dead-session');
  });

  it('respects lock_stale_timeout_minutes=0 by never treating locks as stale', () => {
    // Lock is 6 hours old — would normally be stale, but with 0 it isn't.
    const ts = Math.floor(Date.now() / 1000) - 6 * 60 * 60;
    writeFileSync(join(tmp, '.autopilot.lock'), `${ts}\nancient-session\n`);
    const profile = { ...flatToProfile({}, 'medium'), lock_stale_timeout_minutes: 0 };
    const r = acquireAutopilotLock({}, profile, tmp);
    expect(r.acquired).toBe(false);
    expect(r.holder).toBe('ancient-session');
  });

  it('honors a custom stale_timeout_minutes from config', () => {
    // Lock 10 min old. Custom threshold 5 min → stale.
    const ts = Math.floor(Date.now() / 1000) - 10 * 60;
    writeFileSync(join(tmp, '.autopilot.lock'), `${ts}\nbriefly-stale\n`);
    const profile = { ...flatToProfile({}, 'medium'), lock_stale_timeout_minutes: 5 };
    const r = acquireAutopilotLock({}, profile, tmp);
    expect(r.acquired).toBe(true);
    expect(r.takeover).toBe('stale');
  });

  it('skips silently when lock.js is missing (partial install)', () => {
    rmSync(join(tmp, '_Sprintpilot', 'scripts', 'lock.js'));
    const r = acquireAutopilotLock({}, flatToProfile({}, 'medium'), tmp);
    expect(r.acquired).toBe(true);
    expect(r.skipped).toBe(true);
  });
});
