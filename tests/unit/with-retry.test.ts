import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import retryMod from '../../_Sprintpilot/scripts/with-retry.js';

const {
  DEFAULT_ATTEMPTS,
  DEFAULT_REF_LOCK_PATTERN,
  shouldRetry,
  jitteredDelay,
  runWithRetry,
  splitAtSeparator,
} = retryMod as {
  DEFAULT_ATTEMPTS: number;
  DEFAULT_REF_LOCK_PATTERN: RegExp;
  shouldRetry: (stderr: string, pattern: RegExp) => boolean;
  jitteredDelay: (min: number, max: number) => number;
  runWithRetry: (opts: {
    cmd: string;
    args: string[];
    attempts?: number;
    minMs?: number;
    maxMs?: number;
    pattern?: RegExp;
    onAttempt?: (x: { attempt: number; stderr: string; status: number | null }) => void;
  }) => { status: number | null; stdout: string; stderr: string; attempts: number };
  splitAtSeparator: (argv: string[]) => { flags: string[]; cmdArgs: string[] };
};

const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, '_Sprintpilot', 'scripts', 'with-retry.js');

let tmpDir = '';

function makeFakeGit(name: string, body: string): string {
  const file = join(tmpDir, name);
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return file;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sp-retry-'));
});
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = '';
});

describe('constants + helpers', () => {
  it('default attempts is 3', () => {
    expect(DEFAULT_ATTEMPTS).toBe(3);
  });

  it('DEFAULT_REF_LOCK_PATTERN matches known git ref-lock messages', () => {
    const msgs = [
      "fatal: cannot lock ref 'refs/heads/foo': Unable to create '.git/refs/heads/foo.lock': File exists",
      "error: Reference already exists",
      "error: failed to lock refs/heads/topic",
      "warning: unable to unlink lock.ref",
    ];
    for (const m of msgs) {
      expect(shouldRetry(m, DEFAULT_REF_LOCK_PATTERN)).toBe(true);
    }
  });

  it('does not match unrelated errors', () => {
    expect(shouldRetry('permission denied', DEFAULT_REF_LOCK_PATTERN)).toBe(false);
    expect(shouldRetry('fatal: unknown revision', DEFAULT_REF_LOCK_PATTERN)).toBe(false);
    expect(shouldRetry('', DEFAULT_REF_LOCK_PATTERN)).toBe(false);
  });

  it('jitteredDelay respects bounds', () => {
    for (let i = 0; i < 50; i++) {
      const d = jitteredDelay(100, 200);
      expect(d).toBeGreaterThanOrEqual(100);
      expect(d).toBeLessThanOrEqual(200);
    }
  });

  it('splitAtSeparator finds the -- sentinel', () => {
    const r = splitAtSeparator(['--attempts', '5', '--', 'git', 'fetch']);
    expect(r.flags).toEqual(['--attempts', '5']);
    expect(r.cmdArgs).toEqual(['git', 'fetch']);
  });
});

describe('runWithRetry', () => {
  it('succeeds on the first try when the command is clean', () => {
    const r = runWithRetry({ cmd: '/bin/sh', args: ['-c', 'echo ok'] });
    expect(r.status).toBe(0);
    expect(r.attempts).toBe(1);
    expect(r.stdout).toMatch(/ok/);
  });

  it('retries on a ref-lock match and eventually succeeds', () => {
    const counter = join(tmpDir, 'counter');
    const script = makeFakeGit(
      'flaky.sh',
      `#!/bin/bash
cnt_file="${counter}"
n=$( [ -f "$cnt_file" ] && cat "$cnt_file" || echo 0 )
n=$((n + 1))
echo $n > "$cnt_file"
if [ "$n" -le 2 ]; then
  echo "fatal: cannot lock ref 'refs/heads/foo'" >&2
  exit 1
fi
echo "ok on attempt $n"
exit 0
`,
    );
    const r = runWithRetry({ cmd: script, args: [], attempts: 5, minMs: 5, maxMs: 20 });
    expect(r.status).toBe(0);
    expect(r.attempts).toBe(3);
  });

  it('gives up after attempts exhausted on persistent ref-lock failure', () => {
    const script = makeFakeGit(
      'always-locked.sh',
      `#!/bin/bash
echo "fatal: cannot lock ref 'refs/heads/bar'" >&2
exit 1
`,
    );
    const r = runWithRetry({ cmd: script, args: [], attempts: 3, minMs: 1, maxMs: 5 });
    expect(r.status).toBe(1);
    expect(r.attempts).toBe(3);
  });

  it('does NOT retry on a non-matching failure', () => {
    const script = makeFakeGit(
      'unrelated-fail.sh',
      `#!/bin/bash
echo "permission denied" >&2
exit 13
`,
    );
    const r = runWithRetry({ cmd: script, args: [], attempts: 5, minMs: 1, maxMs: 5 });
    expect(r.status).toBe(13);
    expect(r.attempts).toBe(1);
  });

  it('custom --pattern flag trips retry on the supplied regex', () => {
    const counter = join(tmpDir, 'counter2');
    const script = makeFakeGit(
      'flaky2.sh',
      `#!/bin/bash
cnt_file="${counter}"
n=$( [ -f "$cnt_file" ] && cat "$cnt_file" || echo 0 )
n=$((n + 1))
echo $n > "$cnt_file"
if [ "$n" -le 1 ]; then
  echo "custom-transient: network hiccup" >&2
  exit 1
fi
echo "ok on attempt $n"
exit 0
`,
    );
    const r = runWithRetry({
      cmd: script,
      args: [],
      attempts: 3,
      minMs: 1,
      maxMs: 5,
      pattern: /custom-transient/i,
    });
    expect(r.status).toBe(0);
    expect(r.attempts).toBe(2);
  });
});

describe('CLI integration', () => {
  it('no-op command arguments produces help and exits 1', () => {
    const res = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/Usage/);
  });
});
