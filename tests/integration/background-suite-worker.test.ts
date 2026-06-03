import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const WORKER_PATH = path.join(
  process.cwd(),
  '_Sprintpilot',
  'scripts',
  'background-suite-worker.js',
);

let tmpRoot = '';

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-bgworker-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function runWorker(args: { command: string }) {
  const sidecar = path.join(tmpRoot, 'sidecar.json');
  const log = path.join(tmpRoot, 'sidecar.log');
  // Pre-write a running sidecar (the orchestrator does this before spawn).
  fs.writeFileSync(
    sidecar,
    JSON.stringify({
      schema: 'sprintpilot.background-suite.v1',
      story_key: 'test-story',
      command: args.command,
      started_at: new Date().toISOString(),
      status: 'running',
    }),
    'utf8',
  );
  const result = spawnSync(
    process.execPath,
    [
      WORKER_PATH,
      '--sidecar',
      sidecar,
      '--log',
      log,
      '--story-key',
      'test-story',
      '--command',
      args.command,
    ],
    { cwd: tmpRoot, encoding: 'utf8', timeout: 10_000 },
  );
  return { sidecar, log, result };
}

describe('background-suite-worker (integration)', () => {
  it('writes a completed sidecar with exit_code=0 on success', () => {
    const { sidecar, result } = runWorker({ command: 'echo hello && exit 0' });
    expect(result.status).toBe(0);
    const obj = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    expect(obj.status).toBe('completed');
    expect(obj.exit_code).toBe(0);
    expect(obj.completed_at).toMatch(/^\d{4}-/);
    expect(typeof obj.duration_ms).toBe('number');
  });

  it('writes a completed sidecar with non-zero exit_code on failure', () => {
    const { sidecar, log, result } = runWorker({ command: 'echo nope >&2 && exit 7' });
    expect(result.status).toBe(7);
    const obj = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    expect(obj.exit_code).toBe(7);
    expect(obj.status).toBe('completed');
    const logText = fs.readFileSync(log, 'utf8');
    expect(logText).toContain('nope');
  });
});
