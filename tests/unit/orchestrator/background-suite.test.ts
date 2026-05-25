import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// @ts-expect-error — CommonJS module
import backgroundSuite from '../../../_Sprintpilot/lib/orchestrator/background-suite.js';

type Sidecar = {
  story_key: string;
  command: string;
  started_at: string;
  completed_at?: string;
  exit_code?: number;
  signal?: string | null;
  acknowledged?: boolean;
  status?: string;
  log_path?: string;
};

const {
  sidecarDir,
  sidecarPath,
  logPath,
  readLatestSidecar,
  resolveFullSuiteCommand,
  spawnBackground,
  acknowledgeSidecar,
  tailLog,
  checkPriorRun,
  writeRunningSidecar,
  sanitizeStoryKey,
} = backgroundSuite as {
  sidecarDir: (root: string) => string;
  sidecarPath: (root: string, story: string) => string;
  logPath: (root: string, story: string) => string;
  readLatestSidecar: (root: string) => Sidecar | null;
  resolveFullSuiteCommand: (
    profile: Record<string, unknown>,
    root: string,
    extra?: Record<string, unknown>,
  ) => string | null;
  spawnBackground: (args: Record<string, unknown>) => Record<string, unknown> | null;
  acknowledgeSidecar: (filePath: string) => boolean;
  tailLog: (filePath: string, maxBytes?: number) => string;
  checkPriorRun: (
    root: string,
    profile: Record<string, unknown>,
  ) => { sidecar: Sidecar; log_tail: string } | null;
  writeRunningSidecar: (args: Record<string, unknown>) => string;
  sanitizeStoryKey: (s: string) => string;
};

let tmpRoot = '';

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-bgsuite-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeSidecar(storyKey: string, payload: Sidecar) {
  const filePath = sidecarPath(tmpRoot, storyKey);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

describe('background-suite.sanitizeStoryKey', () => {
  it('passes safe chars through', () => {
    expect(sanitizeStoryKey('1.2-foo_bar')).toBe('1.2-foo_bar');
  });
  it('replaces unsafe chars with underscore', () => {
    expect(sanitizeStoryKey('1/2 foo')).toBe('1_2_foo');
  });
  it('returns _unknown for missing/empty', () => {
    expect(sanitizeStoryKey('')).toBe('_unknown');
    expect(sanitizeStoryKey(undefined as unknown as string)).toBe('_unknown');
  });
});

describe('background-suite.sidecarDir + sidecarPath', () => {
  it('locates files under _bmad-output/implementation-artifacts/.background-suite', () => {
    const dir = sidecarDir(tmpRoot);
    expect(dir.endsWith(path.join('_bmad-output', 'implementation-artifacts', '.background-suite'))).toBe(true);
    expect(sidecarPath(tmpRoot, '1.2-foo').endsWith('1.2-foo.json')).toBe(true);
    expect(logPath(tmpRoot, '1.2-foo').endsWith('1.2-foo.log')).toBe(true);
  });
});

describe('background-suite.readLatestSidecar', () => {
  it('returns null when the sidecar directory does not exist', () => {
    expect(readLatestSidecar(tmpRoot)).toBeNull();
  });

  it('returns the most-recently-completed sidecar', () => {
    writeSidecar('1.1-foo', {
      story_key: '1.1-foo',
      command: 'npm test',
      started_at: '2026-06-01T11:00:00.000Z',
      completed_at: '2026-06-01T11:05:00.000Z',
      exit_code: 0,
    });
    writeSidecar('1.2-bar', {
      story_key: '1.2-bar',
      command: 'npm test',
      started_at: '2026-06-01T12:00:00.000Z',
      completed_at: '2026-06-01T12:10:00.000Z',
      exit_code: 1,
    });
    const r = readLatestSidecar(tmpRoot);
    expect(r).not.toBeNull();
    expect(r!.story_key).toBe('1.2-bar');
    expect(r!.exit_code).toBe(1);
  });

  it('skips sidecars without completed_at (still running)', () => {
    writeSidecar('1.1-foo', {
      story_key: '1.1-foo',
      command: 'npm test',
      started_at: '2026-06-01T11:00:00.000Z',
      status: 'running',
    });
    writeSidecar('1.2-bar', {
      story_key: '1.2-bar',
      command: 'npm test',
      started_at: '2026-06-01T10:00:00.000Z',
      completed_at: '2026-06-01T10:05:00.000Z',
      exit_code: 0,
    });
    const r = readLatestSidecar(tmpRoot);
    expect(r!.story_key).toBe('1.2-bar');
  });
});

describe('background-suite.resolveFullSuiteCommand', () => {
  it('prefers user override testing_commands_full', () => {
    const cmd = resolveFullSuiteCommand(
      { testing_commands_full: 'pytest -x' },
      tmpRoot,
    );
    expect(cmd).toBe('pytest -x');
  });

  it('returns null when no override and the adapter registry has no adapter', () => {
    const cmd = resolveFullSuiteCommand({}, tmpRoot, {
      registry: { pickAdapter: () => null },
    });
    expect(cmd).toBeNull();
  });

  it('asks the adapter when no user override is set', () => {
    const fakeAdapter = {
      NAME: 'fake',
      buildCmd: () => 'fake-runner --all',
    };
    const cmd = resolveFullSuiteCommand({}, tmpRoot, {
      registry: { pickAdapter: () => fakeAdapter },
    });
    expect(cmd).toBe('fake-runner --all');
  });
});

describe('background-suite.spawnBackground', () => {
  it('writes a running sidecar and returns spawn metadata', () => {
    let spawned: { args: string[]; opts: Record<string, unknown> } | null = null;
    const fakeChildProcess = {
      spawn(_bin: string, args: string[], opts: Record<string, unknown>) {
        spawned = { args, opts };
        return {
          pid: 99999,
          unref() {},
        };
      },
    };
    const r = spawnBackground({
      command: 'npm test',
      projectRoot: tmpRoot,
      storyKey: '1.2-foo',
      childProcess: fakeChildProcess,
      _now: '2026-06-01T12:00:00.000Z',
    });
    expect(r).not.toBeNull();
    expect((r as Record<string, unknown>).pid).toBe(99999);

    // Sidecar exists with status=running.
    const sidecar = JSON.parse(
      fs.readFileSync(sidecarPath(tmpRoot, '1.2-foo'), 'utf8'),
    );
    expect(sidecar.status).toBe('running');
    expect(sidecar.command).toBe('npm test');
    expect(sidecar.story_key).toBe('1.2-foo');
    expect(sidecar.started_at).toBe('2026-06-01T12:00:00.000Z');
    expect(spawned).not.toBeNull();
    expect(spawned!.args).toContain('--command');
    expect(spawned!.args).toContain('npm test');
  });

  it('returns null when command is empty', () => {
    const r = spawnBackground({
      command: '',
      projectRoot: tmpRoot,
      storyKey: '1.1-foo',
    });
    expect(r).toBeNull();
  });

  it('surfaces spawn errors without throwing', () => {
    const fakeChildProcess = {
      spawn() {
        throw new Error('ENOENT');
      },
    };
    const r = spawnBackground({
      command: 'npm test',
      projectRoot: tmpRoot,
      storyKey: '1.2-foo',
      childProcess: fakeChildProcess,
    });
    expect(r).not.toBeNull();
    expect((r as Record<string, unknown>).error).toMatch(/spawn_failed/);
  });
});

describe('background-suite.acknowledgeSidecar', () => {
  it('flips acknowledged=true atomically', () => {
    const filePath = writeSidecar('1.2-foo', {
      story_key: '1.2-foo',
      command: 'npm test',
      started_at: '2026-06-01T12:00:00.000Z',
      completed_at: '2026-06-01T12:10:00.000Z',
      exit_code: 1,
    });
    expect(acknowledgeSidecar(filePath)).toBe(true);
    const after = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(after.acknowledged).toBe(true);
    expect(after.acknowledged_at).toMatch(/^\d{4}-/);
  });

  it('returns false for missing file', () => {
    const filePath = sidecarPath(tmpRoot, 'nonexistent');
    expect(acknowledgeSidecar(filePath)).toBe(false);
  });
});

describe('background-suite.tailLog', () => {
  it('returns the full log when smaller than maxBytes', () => {
    const lp = logPath(tmpRoot, '1.2-foo');
    fs.mkdirSync(path.dirname(lp), { recursive: true });
    fs.writeFileSync(lp, 'hello world\n', 'utf8');
    expect(tailLog(lp, 1024)).toBe('hello world\n');
  });

  it('returns the last maxBytes when larger', () => {
    const lp = logPath(tmpRoot, '1.2-foo');
    fs.mkdirSync(path.dirname(lp), { recursive: true });
    fs.writeFileSync(lp, 'A'.repeat(8000) + 'TAIL', 'utf8');
    const tail = tailLog(lp, 100);
    expect(tail.endsWith('TAIL')).toBe(true);
    expect(tail.length).toBe(100);
  });

  it('returns empty string for missing file', () => {
    expect(tailLog(path.join(tmpRoot, 'missing.log'), 100)).toBe('');
  });
});

describe('background-suite.checkPriorRun', () => {
  it('returns null when knob is not background', () => {
    writeSidecar('1.1-foo', {
      story_key: '1.1-foo',
      command: 'npm test',
      started_at: '2026-06-01T11:00:00.000Z',
      completed_at: '2026-06-01T11:05:00.000Z',
      exit_code: 1,
    });
    expect(checkPriorRun(tmpRoot, { testing_full_suite_on_story_land: 'ci' })).toBeNull();
  });

  it('returns null when latest sidecar exit_code is 0', () => {
    writeSidecar('1.1-foo', {
      story_key: '1.1-foo',
      command: 'npm test',
      started_at: '2026-06-01T11:00:00.000Z',
      completed_at: '2026-06-01T11:05:00.000Z',
      exit_code: 0,
    });
    expect(
      checkPriorRun(tmpRoot, { testing_full_suite_on_story_land: 'background' }),
    ).toBeNull();
  });

  it('returns null when latest sidecar is acknowledged', () => {
    writeSidecar('1.1-foo', {
      story_key: '1.1-foo',
      command: 'npm test',
      started_at: '2026-06-01T11:00:00.000Z',
      completed_at: '2026-06-01T11:05:00.000Z',
      exit_code: 1,
      acknowledged: true,
    });
    expect(
      checkPriorRun(tmpRoot, { testing_full_suite_on_story_land: 'background' }),
    ).toBeNull();
  });

  it('returns halt descriptor when latest sidecar failed and is unack', () => {
    writeSidecar('1.1-foo', {
      story_key: '1.1-foo',
      command: 'npm test',
      started_at: '2026-06-01T11:00:00.000Z',
      completed_at: '2026-06-01T11:05:00.000Z',
      exit_code: 2,
      log_path: logPath(tmpRoot, '1.1-foo'),
    });
    const lp = logPath(tmpRoot, '1.1-foo');
    fs.writeFileSync(lp, 'FAIL: test_foo failed\n', 'utf8');
    const r = checkPriorRun(tmpRoot, { testing_full_suite_on_story_land: 'background' });
    expect(r).not.toBeNull();
    expect(r!.sidecar.story_key).toBe('1.1-foo');
    expect(r!.log_tail).toContain('FAIL: test_foo failed');
  });
});

describe('background-suite.writeRunningSidecar', () => {
  it('creates the sidecar with status=running', () => {
    const filePath = writeRunningSidecar({
      projectRoot: tmpRoot,
      storyKey: '1.2-foo',
      command: 'npm test',
      startedAt: '2026-06-01T12:00:00.000Z',
    });
    expect(fs.existsSync(filePath)).toBe(true);
    const sidecar = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(sidecar.status).toBe('running');
    expect(sidecar.completed_at).toBeUndefined();
  });
});
